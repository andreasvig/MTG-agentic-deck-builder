import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  RotateCcw,
  SendHorizontal,
  Undo2,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  DeckAgentAppliedEdit,
  DeckAgentDeckEdit,
  DeckAgentDeckHistory,
  DeckAgentDeckSnapshot,
  DeckAgentMessage,
  DeckAgentToolCall,
} from "../domain/agent";
import { formatModelCostUsd, isRefusedDeckEdit } from "../domain/agent";
import type { CardSearchResult } from "../domain/card";
import { useDeckAgentChats } from "../hooks/useDeckAgentChats";
import { apiClient, type ApiClient } from "../lib/api";
import { AgentAnswer } from "./AgentAnswer";

/** The turn in progress: what has been read, and what has been written so far. */
interface LiveTurn {
  text: string;
  toolCalls: DeckAgentToolCall[];
  /** Edits already made to the deck this turn, shown the moment they land. */
  appliedEdits: DeckAgentAppliedEdit[];
}

const NO_LIVE_TURN: LiveTurn = { text: "", toolCalls: [], appliedEdits: [] };

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
   */
  onDeckEdit?: (edit: DeckAgentDeckEdit) => DeckAgentAppliedEdit | null;
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
 * A turn is streamed: each tool call shows the moment it runs, and the answer
 * appears as it is written. The stream is presentation only — the turn is committed
 * from the finished reply, so what is stored never depends on what was on screen.
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
}: DeckAgentPanelProps) {
  const { chat, appendEntry, recordReply, setDraft, clearChat } =
    useDeckAgentChats(deckId);
  const [pending, setPending] = useState(false);
  const [live, setLive] = useState<LiveTurn>(NO_LIVE_TURN);
  const [error, setError] = useState<string | null>(null);
  const pendingRequest = useRef<AbortController | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const entries = chat.entries;
  // The unsent question belongs to the deck it is about, so it waits in that
  // deck's chat rather than following the user to the next one.
  const draft = chat.draft;

  // Switching decks abandons a question already in flight rather than answering it
  // into a deck the user has left. The question itself stays in the transcript it
  // was asked in, so going back and sending again retries it.
  useEffect(() => {
    setPending(false);
    setLive(NO_LIVE_TURN);
    setError(null);
    return () => {
      pendingRequest.current?.abort();
      pendingRequest.current = null;
    };
  }, [deckId]);

  useEffect(() => {
    const element = transcript.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [entries, live, pending]);

  const resetChat = useCallback(() => {
    pendingRequest.current?.abort();
    pendingRequest.current = null;
    // The spend belongs to the conversation being reset, not to the session, so
    // dropping the conversation drops its total with it.
    clearChat(deckId);
    setPending(false);
    setLive(NO_LIVE_TURN);
    setError(null);
  }, [clearChat, deckId]);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || pending || !client.streamDeckAgentChat) {
      return;
    }
    // The sent transcript has to include this turn, because the reply is answered
    // from the messages alone.
    const conversation: DeckAgentMessage[] = [
      ...entries.map((entry) => entry.message),
      { role: "user", content },
    ];
    // Captured for the whole turn: the answer belongs to the deck the question was
    // asked about, even if the request outlives the user's attention on it.
    const turnDeckId = deckId;
    // Read now rather than held in state, so the log includes the edit made a moment
    // ago. See `readDeckHistory`.
    const history = readDeckHistory?.() ?? null;
    // Accumulated on the turn itself rather than read back out of `live` at the end:
    // this closure would see the state as it was when the turn started, and an edit
    // the deck has already taken must not be the thing the transcript forgets.
    const appliedEdits: DeckAgentAppliedEdit[] = [];
    const controller = new AbortController();
    pendingRequest.current = controller;
    appendEntry(turnDeckId, {
      message: { role: "user", content },
      toolCalls: [],
      cardLinks: [],
    });
    setDraft(turnDeckId, "");
    setPending(true);
    setLive(NO_LIVE_TURN);
    setError(null);
    try {
      const reply = await client.streamDeckAgentChat(
        conversation,
        deck,
        {
          onText: (chunk) => {
            setLive((current) => ({ ...current, text: current.text + chunk }));
          },
          onToolCall: (call) => {
            // Text written before a tool call was preamble, not the answer: the
            // committed turn keeps only the final round's prose, so the live view
            // drops it here and ends up showing exactly what gets stored.
            setLive((current) => ({
              ...current,
              text: "",
              toolCalls: [...current.toolCalls, call],
            }));
          },
          onDeckEdit: (edit) => {
            // Handed outward first and written down second, from the answer. The deck is
            // the authority on what an edit does, and a transcript that described the
            // change before the deck had been offered it would be describing an intention.
            const block = onDeckEdit?.(edit) ?? null;
            // Absent when the deck neither took nor refused anything: it already matched
            // the edit, so there is nothing to describe, and a block here would be the
            // transcript inventing a change out of a request.
            if (!block) {
              return;
            }
            appliedEdits.push(block);
            setLive((current) => ({
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
      // again, rather than being lost with the failure.
      setError(
        caught instanceof Error
          ? caught.message
          : "The deck agent is temporarily unavailable.",
      );
    } finally {
      if (pendingRequest.current === controller) {
        pendingRequest.current = null;
        setPending(false);
        // The turn is committed — or failed — so the live copy has served its
        // purpose. Leaving it would show the answer twice.
        setLive(NO_LIVE_TURN);
      }
    }
  }, [
    appendEntry,
    client,
    debugEnabled,
    deck,
    deckId,
    draft,
    entries,
    onDeckEdit,
    pending,
    readDeckHistory,
    recordReply,
    setDraft,
  ]);

  if (!client.streamDeckAgentChat) {
    return null;
  }

  return (
    <section className="deck-agent" aria-labelledby="deck-agent-heading">
      <header className="deck-agent__header">
        <h2 id="deck-agent-heading">
          <Bot aria-hidden="true" size={15} />
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
          disabled={entries.length === 0 && !error}
          onClick={resetChat}
        >
          <RotateCcw aria-hidden="true" size={13} />
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
            </div>
          ))
        )}
        {/*
          * The turn in progress, hidden from assistive technology: a live region
          * that announced every chunk would be unusable. The committed turn is
          * announced once, whole, the moment it lands.
          */}
        {live.toolCalls.length > 0 || live.text || live.appliedEdits.length > 0 ? (
          <div aria-hidden="true">
            {live.toolCalls.map((call, callIndex) => (
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
            {live.appliedEdits.map((applied, editIndex) => (
              <AppliedEditBlock
                applied={applied}
                key={`live-edit-${editIndex}-${applied.reason}`}
              />
            ))}
            {live.text ? (
              <article className="deck-agent__message deck-agent__message--assistant">
                <span className="deck-agent__author">Agent</span>
                <p>
                  {/*
                    * Parsed with no links yet: nothing is resolved until the turn
                    * commits. The words are therefore identical to the committed
                    * ones — braces already gone — and only the ability to open a
                    * card arrives at the end.
                    */}
                  <AgentAnswer text={live.text} client={client} />
                  <span className="deck-agent__caret" />
                </p>
              </article>
            ) : null}
          </div>
        ) : null}
        {pending && !live.text ? (
          <p className="deck-agent__thinking" role="status">
            Thinking…
          </p>
        ) : null}
        {error ? (
          <p className="deck-agent__error" role="alert">
            {error}
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
          aria-label="Message the deck agent"
          placeholder="Ask the deck agent"
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
          disabled={pending || draft.trim().length === 0}
          aria-label="Send message"
          title="Send message"
        >
          <SendHorizontal aria-hidden="true" size={16} />
        </button>
      </form>
    </section>
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
          <AlertTriangle aria-hidden="true" size={12} />
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
        <Check aria-hidden="true" size={12} />
        <span>{`Applied: +${applied.addedCopies} / −${applied.removedCopies}`}</span>
        {onUndo ? (
          <button
            className="deck-agent__edit-undo"
            type="button"
            title="Undo the last deck change"
            onClick={onUndo}
          >
            <Undo2 aria-hidden="true" size={12} />
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
        <Wrench aria-hidden="true" size={11} />
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
        <Wrench aria-hidden="true" size={11} />
        <code className="deck-agent__tool-signature">{call.signature}</code>
        {call.ok ? null : <span>failed</span>}
        <ChevronDown aria-hidden="true" size={12} />
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
