import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DeckAgentAppliedEdit,
  DeckAgentDeckEdit,
  DeckAgentDeckHistory,
  DeckAgentDeckSnapshot,
  DeckAgentRequestMessage,
  DeckAgentToolCall,
  DeckAgentTranscriptEntry,
} from "../domain/agent";
import { Icon } from "./Icon";
import {
  buildAgentMessages,
  formatModelCostUsd,
  isRefusedDeckEdit,
} from "../domain/agent";
import type { CardSearchResult } from "../domain/card";
import { CARD_NAME_DRAG_TYPE } from "../domain/card";
import { useDeckAgentChats } from "../hooks/useDeckAgentChats";
import { apiClient, type ApiClient } from "../lib/api";
import { AgentAnswer } from "./AgentAnswer";

/**
 * The turn in progress: what has been read, and what has been written so far.
 *
 * Presentation while the turn is running, and the whole turn once a cancel commits it —
 * which is why it is held in a ref as well as in state. See `updateLive`.
 */
interface LiveTurn {
  text: string;
  toolCalls: DeckAgentToolCall[];
  /** Edits already made to the deck this turn, shown the moment they land. */
  appliedEdits: DeckAgentAppliedEdit[];
}

const NO_LIVE_TURN: LiveTurn = { text: "", toolCalls: [], appliedEdits: [] };

/**
 * How many decks may have the agent working at once.
 *
 * Not a taste limit. HTTP/1.1 allows a browser roughly six connections per origin, and a
 * streamed turn holds one of them open for its whole duration — every tool round and the
 * written answer. Three leaves half that budget for what the user is doing while they wait:
 * card searches, card images, the health poll. Six turns would answer nothing on time and
 * starve the board of the lookups it is made of.
 */
const MAX_CONCURRENT_TURNS = 3;

/** Why a fourth deck's question is refused, in the words the composer says it in. */
const TOO_MANY_TURNS =
  `The agent is already working on ${MAX_CONCURRENT_TURNS} decks. A turn holds one of the ` +
  "browser's few connections to the card service open until it finishes, so a fourth would " +
  "start starving card searches. Your question is still here — send it when one finishes.";

/**
 * One entry per deck that is in this state, and no entry at all for every other deck.
 *
 * A turn belongs to its deck rather than to the panel, so each piece of turn state is keyed:
 * the panel renders the open deck's turn and every other deck's keeps running. Absent is
 * the ordinary case and means "this deck has no turn", which is why nothing here carries a
 * per-deck default — the reader supplies one.
 */
type ByDeck<T> = Record<string, T>;

/** One deck's entry set, every other deck's left exactly as it was. */
function withDeck<T>(current: ByDeck<T>, deckId: string, value: T): ByDeck<T> {
  return { ...current, [deckId]: value };
}

/**
 * One deck's entry removed.
 *
 * The very same object back when there was nothing to remove, so a clear for a deck that
 * had no turn is not a state change and cannot re-render the panel — which matters because
 * clearing runs from a stream's `finally`, on whichever turn happens to settle.
 */
function withoutDeck<T>(current: ByDeck<T>, deckId: string): ByDeck<T> {
  if (!(deckId in current)) {
    return current;
  }
  const { [deckId]: _removed, ...rest } = current;
  return rest;
}

/** Whether a turn has produced anything at all: what decides a cancel's two paths. */
function hasStreamed(live: LiveTurn): boolean {
  return (
    live.toolCalls.length > 0 ||
    live.text.length > 0 ||
    live.appliedEdits.length > 0
  );
}

interface DeckAgentPanelProps {
  client?: ApiClient;
  debugEnabled?: boolean;
  /** Whose conversation this is. Each deck keeps its own, saved in the browser. */
  deckId: string;
  /** The open deck, read by the agent's tools. Absent when none is open. */
  deck?: DeckAgentDeckSnapshot | null;
  /** Open a card the answer named, in the same inspector the board uses. */
  onOpenCard?: (card: CardSearchResult) => void;
  /**
   * Apply an edit the agent just made. Threaded exactly as `onOpenCard` is, and for
   * the same reason: how a deck changes is not this panel's business, so it hands the
   * resolved edit outward rather than reaching into deck state itself.
   *
   * It answers with the block to record — what the deck *did* with the edit, which the
   * panel writes down as given and does not second-guess. The transcript is durable, so
   * the one thing it may not do is describe the request: only the deck knows whether the
   * edit happened, which cards moved, and how many copies went either way.
   *
   * `null` answers that there is nothing to record, which is what an edit the deck already
   * matched leaves behind. A refusal is a block too — see `refusedDeckEdit` — because an
   * edit that did not happen still has to be said.
   *
   * The deck id is the deck the *turn* was asked about, which is not always the deck on
   * screen: a turn keeps running after the user moves on, and its edit belongs to the deck
   * it was asked about. Handed over explicitly rather than left to the receiver's idea of
   * which deck is open, because the receiver's idea is right only until the user switches.
   */
  onDeckEdit?: (
    edit: DeckAgentDeckEdit,
    deckId: string,
  ) => DeckAgentAppliedEdit | null;
  /** Reverse the deck's last recorded change, behind the transcript's Undo. */
  onUndoDeckEdit?: () => void;
  /**
   * The id of the deck's newest recorded edit, or nothing when it has none.
   *
   * Which block gets the Undo, decided by comparison rather than by position: `undo`
   * reverses this one edit, so it is the only block that may offer to. See
   * `DeckAgentAppliedEdit.editId`.
   */
  undoableEditId?: string | null;
  /**
   * The deck's recorded history, read at the moment a turn is sent.
   *
   * A function rather than a value because the log is written by an effect after the
   * render that changed the deck: a value handed down during that render would be one
   * edit stale, and the missing edit would be the one just made.
   */
  readDeckHistory?: () => DeckAgentDeckHistory | null;
  /**
   * Which decks have a turn running, whenever that set changes.
   *
   * The panel owns turn state and the deck list is nowhere near it, so the fact travels
   * outward as a report rather than the state being lifted: a running turn is otherwise
   * invisible the moment the user opens another deck. Reported as the whole set rather than
   * as a start/stop pair, so a listener cannot drift out of step with it — and it is the
   * panel's only outward interest in a turn it is not rendering.
   */
  onActiveTurnsChange?: (deckIds: string[]) => void;
}

/**
 * The deck agent in the reserved right workspace.
 *
 * The transcript lives in the browser rather than on the server: the agent has no
 * session of its own, so every turn posts the whole conversation back and **Reset
 * chat** is simply forgetting it locally. It is kept per deck, so switching decks
 * switches conversation. The deck snapshot travels the same way, which is why the
 * agent's tools always read the deck as it is right now.
 *
 * A turn belongs to its deck too, and that is the stronger statement of the two: switching
 * decks leaves the turn running, and coming back finds it further along than it was left.
 * Every piece of turn state below is keyed by deck id for exactly that reason, so
 * `MAX_CONCURRENT_TURNS` decks can be working at once. This reverses ADR 0030's "a reply in
 * flight is abandoned on a deck switch", whose reason — answering into a deck the user has
 * left is worse than not answering — assumed the answer had nowhere else to land. It has: the
 * deck it was asked about, which owns both the transcript and the turn (ADR 0045).
 *
 * A turn is streamed: each tool call shows the moment it runs, and the answer
 * appears as it is written. An **answered** turn is committed from the finished reply, so
 * what is stored never depends on what was on screen. A **cancelled** turn is the one
 * exception, and it narrows that rule rather than reversing it: for an interrupted turn no
 * `done` will ever arrive, so the stream is the only account of what happened, and
 * throwing it away would throw away paid lookups the next turn could have continued from
 * (ADR 0031, "what streams must converge on what is committed").
 *
 * A deck edit is the one thing on the stream that is not presentation: the deck has
 * already changed by the time the block describing it appears, which is why that block
 * is worded in the past tense and carries an Undo rather than a confirmation. The block is
 * the deck's own account of what it did, handed back by `onDeckEdit` — nothing here is
 * written from the event. The event is what was asked for, and the two differ every time the
 * deck had moved on or turned the edit down: a commander that cannot legally share the zone,
 * a group the deck does not have, a card the user had already cut. The transcript is the
 * lasting record of what happened, not of what was proposed.
 */
export function DeckAgentPanel({
  client = apiClient,
  debugEnabled = false,
  deckId,
  deck = null,
  onOpenCard,
  onDeckEdit,
  onUndoDeckEdit,
  undoableEditId = null,
  readDeckHistory,
  onActiveTurnsChange,
}: DeckAgentPanelProps) {
  const {
    chat,
    appendEntry,
    recordReply,
    recordInterruptedTurn,
    setDraft,
    withdrawQuestion,
    clearChat,
  } = useDeckAgentChats(deckId);
  /*
   * The three states a turn has, each keyed by the deck the turn is about.
   *
   * `error` is keyed with the others, and that is not symmetry for its own sake: a
   * background turn that fails must not put its error on the deck the user happens to be
   * looking at, and clearing it on a deck switch would throw away the only account a failed
   * background turn leaves. It waits in its own deck's view until the user goes back — which
   * is the whole of that surface, and the known limit of it.
   */
  const [pending, setPending] = useState<ByDeck<true>>({});
  const [live, setLive] = useState<ByDeck<LiveTurn>>({});
  const [error, setError] = useState<ByDeck<string>>({});
  /** A card is being dragged over the panel, so the composer says where it will land. */
  const [cardOver, setCardOver] = useState(false);
  /**
   * Where the caret goes once something has written the draft for the user: a dropped
   * card's name, or a question taken back off a cancelled turn.
   *
   * The textarea's value is controlled, so a selection set straight after `setDraft`
   * would be set on the value that replaced and then thrown away by the render that
   * follows. Held as state instead and applied by the effect below, which runs after the
   * new value is in the DOM.
   */
  const [caretTarget, setCaretTarget] = useState<number | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  /** Each running turn's controller, by deck. Only what is in here can be aborted. */
  const pendingRequests = useRef(new Map<string, AbortController>());
  /**
   * The question each turn in flight is answering, by the deck it was asked about.
   *
   * Kept so that cancelling can hand the question back rather than leaving the user to
   * retype it, and so that a turn committed by a cancel lands in its own deck's
   * transcript. A ref because the canceller is a keystroke handler that must see the
   * turn as it is *now*, not as it was when the handler was last rendered — and because its
   * size is what the concurrency cap is counted from, at the instant a send is attempted
   * rather than at the last render.
   */
  const inFlight = useRef(new Map<string, string>());
  /**
   * The same live turns as the state above, readable synchronously.
   *
   * Held twice because they are read by two things with different needs. The render needs
   * state; the canceller needs the turn as it is at the instant the key was pressed, and
   * a cancel is by definition a race with the stream. A keydown dispatched between a
   * chunk arriving and React committing it would run a handler closed over the previous
   * value — and the last thing to arrive before a cancel is exactly the thing the user
   * was reacting to. Dropping it would drop a paid `search_web` result out of the replay
   * this whole feature exists to keep.
   *
   * Written only by `updateLive` and `clearLive`, so the two cannot disagree.
   */
  const liveTurns = useRef(new Map<string, LiveTurn>());
  const transcript = useRef<HTMLDivElement>(null);
  const entries = chat.entries;
  // The unsent question belongs to the deck it is about, so it waits in that
  // deck's chat rather than following the user to the next one.
  const draft = chat.draft;
  // What the panel renders: the open deck's turn. Every other deck's is still in the maps
  // above, still being written to by its own stream.
  const openPending = pending[deckId] === true;
  const openLive = live[deckId] ?? NO_LIVE_TURN;
  const openError = error[deckId] ?? null;

  /**
   * Advance one deck's live turn, in both the ref and the state, from its current value.
   *
   * The single writer of either. An updater rather than a value because every caller is
   * accumulating — another chunk, another call — and the caller is the stream, which has
   * no render of its own to read the previous value from. The state is written through an
   * updater for the same reason one step up: two decks' streams can advance between two
   * renders, and a written-out object would drop whichever one lost the race.
   */
  const updateLive = useCallback(
    (turnDeckId: string, next: (current: LiveTurn) => LiveTurn) => {
      const advanced = next(liveTurns.current.get(turnDeckId) ?? NO_LIVE_TURN);
      liveTurns.current.set(turnDeckId, advanced);
      setLive((current) => withDeck(current, turnDeckId, advanced));
    },
    [],
  );

  /** Forget one deck's live turn, once it has been committed or thrown away. */
  const clearLive = useCallback((turnDeckId: string) => {
    liveTurns.current.delete(turnDeckId);
    setLive((current) => withoutDeck(current, turnDeckId));
  }, []);

  /*
   * A deck switch leaves every turn running. Only unmount stops one.
   *
   * This effect used to key on `deckId` and abort in its cleanup, which is what made a deck
   * switch a cancel — ADR 0030, "a reply in flight is abandoned on a deck switch". ADR 0045
   * reverses it: two decks building at once is the feature, and a turn that dies because the
   * user looked at something else is the opposite of it. Nothing about a deck switch is
   * handled here any more, because there is nothing left to handle: the state is keyed by
   * deck, so the open deck's view is a lookup rather than something that has to be cleared.
   *
   * The empty dependency list is the whole mechanism. It runs once, and its cleanup runs
   * once — at unmount, where every turn must stop, because from then on nothing can receive
   * a frame or commit what one carried.
   */
  useEffect(() => {
    const requests = pendingRequests.current;
    return () => {
      for (const controller of requests.values()) {
        controller.abort();
      }
      requests.clear();
    };
  }, []);

  /**
   * Which decks have the agent working, reported outward whenever that set changes.
   *
   * Sorted, so the same set is the same array: this lands in a parent's state, and an array
   * whose order wandered between renders would re-render forever.
   */
  const runningDeckIds = useMemo(() => Object.keys(pending).sort(), [pending]);

  useEffect(() => {
    onActiveTurnsChange?.(runningDeckIds);
  }, [onActiveTurnsChange, runningDeckIds]);

  useEffect(() => {
    const element = transcript.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [entries, openLive, openPending]);

  useEffect(() => {
    if (caretTarget === null) {
      return;
    }
    setCaretTarget(null);
    const field = composer.current;
    if (!field) {
      return;
    }
    // Focused as well as positioned: a name dropped into a composer nobody is typing in
    // leaves the user one keystroke from continuing the sentence, which is the whole
    // point of dropping it there rather than clicking the card. A question handed back
    // by a cancel is the same — it came back to be edited.
    field.focus();
    field.setSelectionRange(caretTarget, caretTarget);
  }, [caretTarget]);

  /**
   * Put a dragged card's name in the draft, at the caret when there is one.
   *
   * Spaced on whichever sides need it, so dropping into the middle of a sentence reads
   * as a word rather than joining the one beside it. The caret lands after the name.
   */
  const dropCardName = useCallback(
    (name: string) => {
      const field = composer.current;
      const at =
        field && document.activeElement === field
          ? (field.selectionStart ?? draft.length)
          : draft.length;
      const before = draft.slice(0, at);
      const after = draft.slice(at);
      const lead = before && !/\s$/.test(before) ? " " : "";
      const trail = after && !/^\s/.test(after) ? " " : "";
      setDraft(deckId, `${before}${lead}${name}${trail}${after}`);
      setCaretTarget(before.length + lead.length + name.length);
    },
    [deckId, draft, setDraft],
  );

  /**
   * Stop the turn in flight, and keep whatever it had already done.
   *
   * One question decides everything: has anything streamed? A turn that ran a tool, wrote
   * a word or changed the deck **did** something, and that work is committed as an
   * interrupted entry — the tool lines the user watched appear, the prose so far, the edits
   * already applied. It is worth keeping for its own sake, and worth more than that
   * because the next turn replays those calls instead of paying for the same lookups
   * again (`buildAgentMessages`).
   *
   * A turn that has produced nothing is the other case, and it is the only one where the
   * question goes back to the composer: nothing has happened, so there is nothing for the
   * question to be the record of, and the question the user meant to ask is the one they
   * are about to type. This replaces a ten-second timer (`174b63f`), which was a proxy for
   * this same test back when a cancel kept nothing — measured directly now that it can be.
   *
   * An applied edit therefore still blocks the withdrawal, as it always has, but it needs
   * no condition of its own: an edit is something that streamed. Once a turn has changed
   * the deck its question is part of the only account of why the deck is different, and
   * withdrawing it would leave a change nothing explains.
   */
  const cancel = useCallback(() => {
    /*
     * The open deck's turn, and no other deck's.
     *
     * Escape belongs to the conversation on screen: a turn running on a deck the user is not
     * looking at is not the one they are reacting to, and stopping it would make a deck
     * switch a cancel again by another route. There is deliberately no way to cancel a
     * background turn — the deck list's dot says one is running and switching to it is one
     * click, which is enough until it is not.
     */
    const turnDeckId = deckId;
    const question = inFlight.current.get(turnDeckId);
    // Read before anything is cleared, and from the ref rather than from state: this is
    // the turn as it stands at the instant of the key press. See `liveTurns`.
    const live = liveTurns.current.get(turnDeckId) ?? NO_LIVE_TURN;
    pendingRequests.current.get(turnDeckId)?.abort();
    pendingRequests.current.delete(turnDeckId);
    inFlight.current.delete(turnDeckId);
    setPending((current) => withoutDeck(current, turnDeckId));
    clearLive(turnDeckId);
    setError((current) => withoutDeck(current, turnDeckId));
    if (question === undefined) {
      return;
    }
    if (hasStreamed(live)) {
      const committed: DeckAgentTranscriptEntry = {
        // Empty when the cancel landed inside the first tool call, which is an ordinary
        // case rather than a defect: the entry is then its tool lines and its marker, and
        // the transcript renders no bubble for prose that was never written.
        message: { role: "assistant", content: live.text },
        toolCalls: live.toolCalls,
        // Nothing is resolved for a turn that never finished: card links come from the
        // backend's pass over the committed answer, and there is no committed answer.
        cardLinks: [],
        ...(live.appliedEdits.length > 0
          ? { appliedEdits: live.appliedEdits }
          : {}),
        interrupted: true,
      };
      recordInterruptedTurn(turnDeckId, committed);
      return;
    }
    withdrawQuestion(turnDeckId, question);
    setDraft(turnDeckId, question);
    setCaretTarget(question.length);
  }, [
    clearLive,
    deckId,
    recordInterruptedTurn,
    setDraft,
    withdrawQuestion,
  ]);

  const resetChat = useCallback(() => {
    // Every line here is scoped to the open deck, and `clearChat` was the one that already
    // was: **Reset chat** clears one conversation, so it must stop one turn. A global clear
    // beside a per-deck one would silently kill whatever another deck was working on.
    pendingRequests.current.get(deckId)?.abort();
    pendingRequests.current.delete(deckId);
    /*
     * Along with the question it was answering.
     *
     * There is no state today in which this matters, and the claim is worth being exact
     * about: `cancel` is the only reader, its only caller is guarded by this deck's
     * `pending`, and the line below clears that in the same block — so nothing can reach
     * `cancel` holding a question this reset has thrown away. It is kept because that guard
     * is the only thing making it so. A defence whose reason is "unreachable" is worth
     * keeping; one whose reason is wrong is worse than none, because the next reader
     * believes it.
     */
    inFlight.current.delete(deckId);
    // The spend belongs to the conversation being reset, not to the session, so
    // dropping the conversation drops its total with it.
    clearChat(deckId);
    setPending((current) => withoutDeck(current, deckId));
    clearLive(deckId);
    setError((current) => withoutDeck(current, deckId));
  }, [clearChat, clearLive, deckId]);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || openPending || !client.streamDeckAgentChat) {
      return;
    }
    /*
     * Refused rather than queued, and the question stays in the composer.
     *
     * Counted from the ref rather than from `pending`, because two sends in one tick would
     * both read the same rendered state and both start. The draft is left alone on purpose:
     * a question silently swallowed by a limit is worse than one the user still has, and the
     * reason is said out loud rather than expressed as a disabled button.
     */
    if (inFlight.current.size >= MAX_CONCURRENT_TURNS) {
      setError((current) => withDeck(current, deckId, TOO_MANY_TURNS));
      return;
    }
    // The sent transcript has to include this turn, because the reply is answered
    // from the messages alone. Built rather than mapped: an answered turn posts its prose
    // and nothing else, and an interrupted one posts the calls it made and their results,
    // which is several messages from one entry. See `buildAgentMessages`.
    const conversation: DeckAgentRequestMessage[] = [
      ...buildAgentMessages(entries),
      { role: "user", content },
    ];
    // Captured for the whole turn: the answer belongs to the deck the question was
    // asked about, even if the request outlives the user's attention on it.
    const turnDeckId = deckId;
    /*
     * The revision of the deck this turn is asking about, stamped onto every call it
     * makes.
     *
     * The panel is the only place this can come from: the backend holds no deck, so a
     * reply cannot report when the one it was posted last changed. Without it a replayed
     * `read_deck` result is handed back to the model with nothing to compare, and the
     * backend's staleness substitution can never fire — a result read before the user
     * moved half the deck would come back as a current observation.
     *
     * Captured here rather than read when each event arrives, and that is the whole
     * point: what matters is the deck the call was answered *about*. Editing the deck
     * mid-turn re-renders the panel with a new revision, and this turn's calls still
     * carry the one they actually read — which is exactly the difference the backend is
     * comparing for.
     *
     * `undefined` until `App.tsx` passes the deck's `updated_at` (Phase 4), and absent is
     * not "unchanged": the backend reads a missing revision as the browser declining to
     * say, so nothing is claimed in the meantime.
     */
    const askedRevision = deck?.updated_at;
    // Read now rather than held in state, so the log includes the edit made a moment
    // ago. See `readDeckHistory`.
    const history = readDeckHistory?.() ?? null;
    // Accumulated on the turn itself rather than read back out of `live` at the end:
    // this closure would see the state as it was when the turn started, and an edit
    // the deck has already taken must not be the thing the transcript forgets.
    const appliedEdits: DeckAgentAppliedEdit[] = [];
    const controller = new AbortController();
    pendingRequests.current.set(turnDeckId, controller);
    inFlight.current.set(turnDeckId, content);
    appendEntry(turnDeckId, {
      message: { role: "user", content },
      toolCalls: [],
      cardLinks: [],
    });
    setDraft(turnDeckId, "");
    /*
     * Focus goes to the composer, and this is load-bearing rather than a nicety.
     *
     * Sending by *clicking* disables the button that was clicked, and a disabled
     * element cannot hold focus: the browser drops it to `<body>`, outside this panel,
     * where the Escape handler below never sees it. So the most ordinary way to send a
     * question — type, click, change your mind — left the shortcut dead. Measured in a
     * real browser; jsdom has no such rule and reported it working from every path.
     *
     * Unconditional because `send` has no caller from outside the panel: it runs on
     * this form's submit, which is the button or Enter in the composer, and focus is
     * already in here for both.
     */
    setCaretTarget(0);
    setPending((current) => withDeck(current, turnDeckId, true));
    clearLive(turnDeckId);
    setError((current) => withoutDeck(current, turnDeckId));
    try {
      const reply = await client.streamDeckAgentChat(
        conversation,
        deck,
        {
          onText: (chunk) => {
            updateLive(turnDeckId, (current) => ({
              ...current,
              text: current.text + chunk,
            }));
          },
          onToolCall: (call) => {
            // Text written before a tool call was preamble, not the answer: the
            // committed turn keeps only the final round's prose, so the live view
            // drops it here and ends up showing exactly what gets stored.
            updateLive(turnDeckId, (current) => ({
              ...current,
              text: "",
              toolCalls: [
                ...current.toolCalls,
                // Stamped as the call arrives, because this is the only moment the deck it
                // was answered about is known. Absent rather than empty when there is no
                // revision to report — see `askedRevision`.
                askedRevision ? { ...call, deckRevision: askedRevision } : call,
              ],
            }));
          },
          onDeckEdit: (edit) => {
            /*
             * Applied to the deck the turn was asked about, whether or not it is the deck on
             * screen. There used to be a guard here dropping an edit whose deck was not
             * open, on the reasoning that such a frame had outlived its turn — true while a
             * deck switch aborted the request, and the exact case this phase supports now.
             * What keeps the old worry answered is that the edit is *named*: it goes to
             * `turnDeckId` rather than to whichever deck happens to be open, so it can no
             * longer land on a deck nobody asked about.
             */
            // Handed outward first and written down second, from the answer. The deck is
            // the authority on what an edit does, and a transcript that described the
            // change before the deck had been offered it would be describing an intention.
            const block = onDeckEdit?.(edit, turnDeckId) ?? null;
            // Absent when the deck neither took nor refused anything: it already matched
            // the edit, so there is nothing to describe, and a block here would be the
            // transcript inventing a change out of a request.
            if (!block) {
              return;
            }
            appliedEdits.push(block);
            // From here the question cannot be taken back, however fast the cancel: it is
            // the only account of why this deck is now different. No flag says so — the
            // block below is on the live turn, and a cancel keeps a turn that has anything
            // on it. One condition rather than two, and the same one.
            updateLive(turnDeckId, (current) => ({
              ...current,
              appliedEdits: [...current.appliedEdits, block],
            }));
          },
        },
        controller.signal,
        debugEnabled,
        history,
      );
      if (controller.signal.aborted) {
        return;
      }
      // Counted rather than ignored, so a total that is missing a completion says
      // so instead of quietly reading low.
      const cost = typeof reply.cost_usd === "number" ? reply.cost_usd : null;
      const unpriced =
        typeof reply.unpriced_call_count === "number"
          ? reply.unpriced_call_count
          : 0;
      const missingWholeTurn = cost === null && unpriced === 0 ? 1 : 0;
      recordReply(turnDeckId, {
        entry: {
          message: reply.message,
          toolCalls: reply.tool_calls,
          cardLinks: reply.card_links,
          // The one part of a committed turn the finished reply does not carry: the
          // edits arrived on the stream and have already been applied, so the panel
          // is the only thing that saw them. Absent when the turn changed nothing.
          ...(appliedEdits.length > 0 ? { appliedEdits } : {}),
        },
        costUsd: cost,
        unpricedCalls: unpriced + missingWholeTurn,
      });
    } catch (caught: unknown) {
      if (
        controller.signal.aborted ||
        (caught instanceof DOMException && caught.name === "AbortError")
      ) {
        return;
      }
      // The question stays in the transcript so it can be retried by sending
      // again, rather than being lost with the failure. Filed against the deck it was
      // asked about, which may no longer be the one on screen: a failure is part of that
      // conversation's account of itself and belongs to it.
      setError((current) =>
        withDeck(
          current,
          turnDeckId,
          caught instanceof Error
            ? caught.message
            : "The deck agent is temporarily unavailable.",
        ),
      );
    } finally {
      // Only for the turn this controller belongs to, which is what keeps a cancel and
      // this block from both committing. A cancel has already dropped this deck's entry from
      // `pendingRequests` and cleared its live turn by the time the aborted promise settles,
      // so this recognises the turn as no longer its own and touches nothing.
      if (pendingRequests.current.get(turnDeckId) === controller) {
        pendingRequests.current.delete(turnDeckId);
        inFlight.current.delete(turnDeckId);
        setPending((current) => withoutDeck(current, turnDeckId));
        // The turn is committed — or failed — so the live copy has served its
        // purpose. Leaving it would show the answer twice.
        clearLive(turnDeckId);
      }
    }
  }, [
    appendEntry,
    clearLive,
    client,
    debugEnabled,
    deck,
    deckId,
    draft,
    entries,
    onDeckEdit,
    openPending,
    readDeckHistory,
    recordReply,
    setDraft,
    updateLive,
  ]);

  if (!client.streamDeckAgentChat) {
    return null;
  }

  return (
    <section
      className={`deck-agent ${cardOver ? "deck-agent--card-over" : ""}`}
      aria-labelledby="deck-agent-heading"
      /*
       * Escape abandons the turn in flight. On the panel rather than on the composer,
       * because the key belongs to the conversation and not to the textarea: the user
       * may well have tabbed to a card the agent named while waiting.
       *
       * Bubbled to, not captured: anything inside that has its own use for Escape — a
       * dialog opened from a card link — handles it and stops it, and this never sees
       * it. That is the right order. A key with two meanings should mean the innermost.
       */
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !openPending) {
          return;
        }
        event.preventDefault();
        cancel();
      }}
      /*
       * The whole panel takes the drop, and the composer is where it lands. A drag ends
       * where the hand stops, not where the target is, so a zone the size of the panel
       * is the difference between dropping a card and missing the textarea by 20px.
       *
       * Only a card, and only ever appended to the draft: a link or a run of text
       * dragged in from elsewhere is left to the browser, which puts it where it was
       * dropped or nowhere.
       */
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(CARD_NAME_DRAG_TYPE)) {
          return;
        }
        // Both required, and for different reasons: without the default prevented the
        // drop event never fires at all, and `copy` is what stops the cursor claiming
        // the card is about to be moved out of the deck.
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setCardOver(true);
      }}
      onDragLeave={(event) => {
        // Crossing into a child of the panel fires `dragleave` on the panel too, which
        // would flicker the highlight off over every message in the transcript.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        setCardOver(false);
      }}
      onDrop={(event) => {
        const name = event.dataTransfer.getData(CARD_NAME_DRAG_TYPE).trim();
        setCardOver(false);
        if (!name) {
          return;
        }
        // Prevented only once there is a name to insert. A drop this panel is not going
        // to act on is a drop the browser should still handle its own way.
        event.preventDefault();
        dropCardName(name);
      }}
    >
      <header className="deck-agent__header">
        <h2 id="deck-agent-heading">
          <Icon name="bot" aria-hidden="true" size={15} />
          Deck agent
        </h2>
        {debugEnabled ? (
          <span
            className="deck-agent__spend"
            title={
              chat.unpricedCalls > 0
                ? `${chat.unpricedCalls} model call(s) reported no cost`
                : "What this conversation has cost so far"
            }
          >
            {formatModelCostUsd(chat.spentUsd)}
            {chat.unpricedCalls > 0 ? "+" : ""}
          </span>
        ) : null}
        <button
          className="deck-agent__reset"
          type="button"
          disabled={entries.length === 0 && !openError}
          onClick={resetChat}
        >
          <Icon name="reset" aria-hidden="true" size={13} />
          Reset chat
        </button>
      </header>

      <div
        className="deck-agent__transcript"
        ref={transcript}
        role="log"
        aria-label="Deck agent conversation"
        aria-live="polite"
      >
        {entries.length === 0 ? (
          <p className="deck-agent__empty">
            Ask about the deck you are building. The agent can read your deck and
            look cards up, but it cannot change anything.
          </p>
        ) : (
          entries.map((entry, index) => (
            <div key={`${index}-${entry.message.role}`}>
              {entry.toolCalls.map((call, callIndex) => (
                <ToolCallLine
                  call={call}
                  debugEnabled={debugEnabled}
                  key={`${callIndex}-${call.signature}`}
                />
              ))}
              {/*
                * No bubble for a turn that said nothing. Only one kind of turn can be in
                * that state — one cancelled inside its first tool call, before a word was
                * written — and an empty bubble with an author on it would claim the agent
                * answered and then show nothing. Its tool lines and its marker say what
                * happened. Every other entry has content by contract: a question is
                * non-blank before it is sent, and a reply is refused if its content is.
                */}
              {entry.message.content ? (
                <article
                  className={`deck-agent__message deck-agent__message--${entry.message.role}`}
                >
                  <span className="deck-agent__author">
                    {entry.message.role === "user" ? "You" : "Agent"}
                  </span>
                  <p>
                    {entry.message.role === "assistant" ? (
                      <AgentAnswer
                        text={entry.message.content}
                        links={entry.cardLinks}
                        client={client}
                        onOpenCard={onOpenCard}
                      />
                    ) : (
                      // The user's own words are never parsed: braces they typed are
                      // braces they meant.
                      entry.message.content
                    )}
                  </p>
                </article>
              ) : null}
              {(entry.appliedEdits ?? []).map((applied, editIndex) => (
                <AppliedEditBlock
                  applied={applied}
                  key={`edit-${editIndex}-${applied.reason}`}
                  // The block whose edit *is* the deck's last recorded change, and no
                  // other. Matching ids rather than counting backwards from the newest
                  // block is what makes the affordance impossible to strand: a refusal
                  // records nothing and therefore never matches, a later edit in the same
                  // turn takes the match with it, and so does a drag the user made after
                  // the turn ended. A block with no id — a refusal, or one an older build
                  // stored — cannot match either, which is the safe way to be wrong.
                  onUndo={
                    applied.editId !== undefined &&
                    applied.editId === undoableEditId
                      ? onUndoDeckEdit
                      : undefined
                  }
                />
              ))}
              {entry.interrupted ? <InterruptedTurnMarker /> : null}
            </div>
          ))
        )}
        {/*
          * The turn in progress, hidden from assistive technology: a live region
          * that announced every chunk would be unusable. The committed turn is
          * announced once, whole, the moment it lands.
          */}
        {openLive.toolCalls.length > 0 ||
        openLive.text ||
        openLive.appliedEdits.length > 0 ? (
          <div aria-hidden="true">
            {openLive.toolCalls.map((call, callIndex) => (
              <ToolCallLine
                call={call}
                debugEnabled={debugEnabled}
                key={`live-${callIndex}-${call.signature}`}
              />
            ))}
            {/*
              * The edit is on screen the moment the deck takes it, with no Undo: the
              * committed block carries that, and a button inside a hidden region is
              * one nobody can press anyway.
              */}
            {openLive.appliedEdits.map((applied, editIndex) => (
              <AppliedEditBlock
                applied={applied}
                key={`live-edit-${editIndex}-${applied.reason}`}
              />
            ))}
            {openLive.text ? (
              <article className="deck-agent__message deck-agent__message--assistant">
                <span className="deck-agent__author">Agent</span>
                <p>
                  {/*
                    * Parsed with no links yet: nothing is resolved until the turn
                    * commits. The words are therefore identical to the committed
                    * ones — braces already gone — and only the ability to open a
                    * card arrives at the end.
                    */}
                  <AgentAnswer text={openLive.text} client={client} />
                  <span className="deck-agent__caret" />
                </p>
              </article>
            ) : null}
          </div>
        ) : null}
        {openPending && !openLive.text ? (
          <p className="deck-agent__thinking" role="status">
            Thinking…
            {/*
              * Inside the status, so it is announced with it rather than being a
              * shortcut only a sighted user is told about.
              */}
            <span className="deck-agent__interrupt">esc to cancel</span>
          </p>
        ) : null}
        {openError ? (
          <p className="deck-agent__error" role="alert">
            {openError}
          </p>
        ) : null}
      </div>

      <form
        className="deck-agent__composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={composer}
          aria-label="Message the deck agent"
          placeholder={
            cardOver ? "Drop to add the card's name" : "Ask the deck agent"
          }
          rows={2}
          maxLength={8_000}
          value={draft}
          onChange={(event) => setDraft(deckId, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="deck-agent__send"
          type="submit"
          disabled={openPending || draft.trim().length === 0}
          aria-label="Send message"
          title="Send message"
        >
          <Icon name="send" aria-hidden="true" size={16} />
        </button>
      </form>
    </section>
  );
}

/**
 * The last line of a turn that was cancelled.
 *
 * Below everything the turn produced, because it is what became of the turn rather than
 * something the turn did: the tool lines ran, the prose was as far as it got, and then it
 * stopped. It says why the work was kept as well as that it stopped — the reason it is
 * still here is that the next question carries on from it, and a user who reads this as
 * "nothing happened" would retype the question and pay for every lookup again.
 *
 * Not to be confused with `deck-agent__interrupt`, which is the *offer* to cancel beside
 * "Thinking…". This is the record of one having been accepted.
 */
function InterruptedTurnMarker() {
  return (
    <p className="deck-agent__interrupted">
      <Icon name="alert" aria-hidden="true" size={11} />
      <span>Interrupted — kept, and the next question continues from here</span>
    </p>
  );
}

/**
 * One edit the agent made, below the answer that explains it.
 *
 * Written in the past tense throughout, because it is: the deck took the change before
 * this rendered, and wording that suggested a pending action would be describing a
 * confirmation step this design deliberately does not have. A refused edit is the same
 * block in the negative — no counts, no Undo, and the deck's own sentence as the reason,
 * reused rather than reworded so the transcript and the toast cannot disagree about why.
 */
function AppliedEditBlock({
  applied,
  onUndo,
}: {
  applied: DeckAgentAppliedEdit;
  onUndo?: () => void;
}) {
  if (isRefusedDeckEdit(applied)) {
    return (
      <div className="deck-agent__edit deck-agent__edit--refused">
        <p className="deck-agent__edit-summary">
          <Icon name="warning" aria-hidden="true" size={12} />
          <span>Not applied</span>
        </p>
        <p className="deck-agent__edit-cards">{applied.reason}</p>
      </div>
    );
  }

  const lines: Array<[string, string]> = [
    ["+", applied.added.join(", ")],
    ["−", applied.removed.join(", ")],
    ["→", applied.moved.join(", ")],
  ];

  return (
    <div className="deck-agent__edit">
      <p className="deck-agent__edit-summary" title={applied.reason}>
        <Icon name="check" aria-hidden="true" size={12} />
        <span>{`Applied: +${applied.addedCopies} / −${applied.removedCopies}`}</span>
        {onUndo ? (
          <button
            className="deck-agent__edit-undo"
            type="button"
            title="Undo the last deck change"
            onClick={onUndo}
          >
            <Icon name="undo" aria-hidden="true" size={12} />
            Undo
          </button>
        ) : null}
      </p>
      {lines.map(([marker, names]) =>
        names ? (
          <p className="deck-agent__edit-cards" key={marker}>
            {`${marker} ${names}`}
          </p>
        ) : null,
      )}
    </div>
  );
}

/**
 * One tool the agent ran, above the answer it produced.
 *
 * A plain line by default. With debug mode on it opens onto what the model asked
 * for and the exact text it read back — the two things that explain an answer.
 * Turns that were sent with debug off carry no payload, so they stay plain lines
 * rather than opening onto nothing.
 */
function ToolCallLine({
  call,
  debugEnabled,
}: {
  call: DeckAgentToolCall;
  debugEnabled: boolean;
}) {
  const title = call.detail ?? "What the agent read to answer";
  const payloads: Array<[string, string, string]> = [];
  if (debugEnabled && call.arguments_json) {
    payloads.push([
      "Call",
      "arguments the model sent",
      prettyJson(call.arguments_json),
    ]);
  }
  if (debugEnabled && call.result) {
    payloads.push(["Result", "exact text returned to the agent", call.result]);
  }

  if (payloads.length === 0) {
    return (
      <p
        className={
          call.ok
            ? "deck-agent__tool"
            : "deck-agent__tool deck-agent__tool--failed"
        }
        title={title}
      >
        <Icon name="wrench" aria-hidden="true" size={11} />
        <code className="deck-agent__tool-signature">{call.signature}</code>
        {call.ok ? null : <span> — failed</span>}
      </p>
    );
  }

  return (
    <details
      className={
        call.ok
          ? "deck-agent__tool-call"
          : "deck-agent__tool-call deck-agent__tool-call--failed"
      }
    >
      <summary title={title}>
        <Icon name="wrench" aria-hidden="true" size={11} />
        <code className="deck-agent__tool-signature">{call.signature}</code>
        {call.ok ? null : <span>failed</span>}
        <Icon name="chevronDown" aria-hidden="true" size={12} />
      </summary>
      <div className="deck-agent__tool-body">
        {payloads.map(([label, hint, text]) => (
          <details className="deck-agent__tool-payload" key={label} open>
            <summary>
              <strong>{label}</strong>
              <span>{hint}</span>
            </summary>
            <pre>{text}</pre>
          </details>
        ))}
      </div>
    </details>
  );
}

/** Indent JSON when it is JSON, and show it as it arrived when it is not. */
function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
