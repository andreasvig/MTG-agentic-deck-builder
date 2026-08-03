import type { CardSearchResult } from "./card";
import type { DeckCardEntry, DeckSection } from "./deck";
import { isDeckSection } from "./deck";
import type { DeckCardPlacement, DeckDiff, DeckHistory } from "./history";
import {
  createDeckHistory,
  parseDeckHistory,
  undoneEdits,
} from "./history";

export type DeckAgentRole = "user" | "assistant";

/**
 * Who said one message in a posted request, which is one role more than a
 * transcript has.
 *
 * `tool` lives only on the wire. A replayed result is not a message the panel ever
 * draws — the chat shows the call as a tool line and the answer as prose — so
 * `DeckAgentRole` keeps its two values and no stored transcript can grow a role the
 * panel has no way to render.
 */
export type DeckAgentRequestRole = DeckAgentRole | "tool";

/** Who made one edit. The same two values the recorded history tags a session with. */
export type DeckAgentActor = "user" | "agent";

export interface DeckAgentMessage {
  role: DeckAgentRole;
  content: string;
}

/**
 * One tool call handed back to the model, exactly as it was made.
 *
 * The turn that made it was interrupted, so no answer was ever written from it. What
 * goes back is the call and its result rather than a summary of either: `search_web`
 * and `read_page` results are paid for and non-deterministic, so re-running one is not
 * the same as replaying it.
 */
export interface DeckAgentReplayCall {
  /**
   * The provider's own id for this call.
   *
   * Matched rather than read, so it travels byte for byte: it is the only thing that
   * ties this call to the `tool` message answering it, and an unanswered call is a 422.
   */
  id: string;
  name: string;
  arguments_json: string;
  /**
   * The deck's `updated_at` when this call ran, for the deck-dependent tools.
   *
   * Absent means the browser could not say, which the backend does not read as
   * "unchanged": which tool's result depends on the deck is the backend's own
   * knowledge, and the browser only reports the fact.
   */
  deck_revision?: string;
}

/**
 * One message as a request carries it, which is more than a transcript stores.
 *
 * An assistant message may carry tool calls and no prose — the provider's own shape
 * for a turn that only called tools — and a `tool` message carries one call's result
 * and names the call by id. Every field is optional here and constrained by role on
 * the backend, so `buildAgentMessages` is the one place that decides which
 * combinations are produced.
 */
export interface DeckAgentRequestMessage {
  role: DeckAgentRequestRole;
  content?: string;
  /** Assistant only, and never empty: an empty list says nothing and costs bytes. */
  tool_calls?: DeckAgentReplayCall[];
  /** Tool only, and required there: which call this message answers. */
  tool_call_id?: string;
}

/** One tool the agent ran, as the chat shows it above the answer. */
export interface DeckAgentToolCall {
  name: string;
  /** What the user reads — `read_deck()` — rendered by the backend that ran it. */
  signature: string;
  ok: boolean;
  detail: string | null;
  /**
   * The provider's own id for this call, when the backend that ran it reported one.
   *
   * Absent on a turn an older build answered, and that absence is why the fallback
   * exists: without an id a call cannot be paired with its result, so the turn
   * replays as framing rather than as a malformed pair.
   */
  id?: string;
  /**
   * The arguments the model sent, as JSON text, and the exact result it read back.
   *
   * Both travel on every turn, because which turn gets cancelled is not knowable in
   * advance and an interrupted turn is replayed from exactly these two fields. Null
   * means the payload is gone — shed by the storage budget, or never sent by an older
   * build — never "the call had no arguments" or "it returned nothing".
   */
  arguments_json: string | null;
  result: string | null;
  /**
   * The deck's `updated_at` when this call ran, as the browser saw it.
   *
   * Recorded by the panel rather than read from the reply: the backend holds no deck,
   * so it cannot know when the one it was posted last changed. Carried so a replay can
   * report the fact and let the backend decide whether the result is still an
   * observation. Absent on a turn stored before this field existed.
   */
  deckRevision?: string;
}

/** One entry of the open deck, as posted with a chat turn. */
export interface DeckAgentDeckCard {
  scryfall_id: string;
  quantity: number;
  section: DeckSection;
}

export interface DeckAgentDeckSnapshot {
  name: string;
  cards: DeckAgentDeckCard[];
  /**
   * When this deck last changed, so a replayed result can be told from a stale one.
   *
   * The only use of it is comparison: the backend checks a replayed call's
   * `deck_revision` against this and substitutes the result of a deck-dependent tool
   * when the two differ. Absent means the caller could not say, which is not the same
   * as "unchanged" — see `buildAgentMessages`.
   */
  updated_at?: string;
}

/**
 * One card the answer named, resolved by the backend against the local catalog.
 *
 * The agent braces every card name it writes; these are the ones the catalog
 * recognised. Resolution is the backend's because only it can tell a card name from
 * a mana symbol, and because the chat needs an Oracle id to open anything.
 */
export interface DeckAgentCardLink {
  name: string;
  oracle_id: string;
}

/**
 * One card change the backend already resolved against the deck this browser posted.
 *
 * The applied form of what the model asked for: the card name it typed is now a
 * printing, the count the deck held sits beside the count it should hold, and a card
 * being added arrives with the catalog entry this browser could not have built for a
 * card it has never seen. Only changes that change something are sent, so applying the
 * same edit twice is the same deck — which is what makes a retried turn safe.
 */
export interface DeckAgentDeckEditChange {
  scryfall_id: string;
  name: string;
  /** The count the deck should hold afterwards. `0` removes the card. */
  quantity: number;
  /** What it held when the turn started, so the transcript can say what moved. */
  previous_quantity: number;
  /**
   * Where the card should sit afterwards. Absent leaves placement alone, which is what an
   * ordinary add or cut wants; `command_zone` is how the agent names a commander.
   */
  section?: DeckSection;
  /**
   * Present exactly when the change adds copies, because the deck's own validators
   * read the card's colours and type line and a card the deck has never held has
   * neither. A change that only cuts or moves needs none: the deck already has it.
   */
  card?: CardSearchResult;
}

/** One whole edit the agent made: what it moved, and the one line saying why. */
export interface DeckAgentDeckEdit {
  deck_name: string;
  reason: string;
  changes: DeckAgentDeckEditChange[];
}

/**
 * How many changes one edit may carry, matching the tool's own schema bound.
 *
 * A hundred is a whole deck replaced at once. Anything longer is not an edit this
 * backend can have produced, so it is read as a malformed event rather than trusted.
 */
const MAX_DECK_EDIT_CHANGES = 100;

/** The most copies of one printing an edit may ask for, as the tool's schema bounds it. */
const MAX_DECK_EDIT_COPIES = 99;

/**
 * Read a `deck_edit` event's payload, or report that it was not one.
 *
 * Rejected whole rather than in part. A change this cannot read is a change the deck
 * would silently not make, and an edit applied minus one of its changes is exactly the
 * half-applied edit the whole design refuses: history would then record an intent that
 * did not happen. A `null` here is treated by the stream reader the way an unknown
 * event type is — ignored, never fatal.
 */
export function readDeckAgentDeckEdit(
  value: unknown,
): DeckAgentDeckEdit | null {
  if (
    !isRecord(value) ||
    typeof value.deck_name !== "string" ||
    typeof value.reason !== "string" ||
    !Array.isArray(value.changes) ||
    value.changes.length === 0 ||
    value.changes.length > MAX_DECK_EDIT_CHANGES
  ) {
    return null;
  }
  const changes: DeckAgentDeckEditChange[] = [];
  for (const candidate of value.changes) {
    const change = readDeckAgentDeckEditChange(candidate);
    if (!change) {
      return null;
    }
    changes.push(change);
  }
  return {
    deck_name: value.deck_name,
    reason: value.reason,
    changes,
  };
}

function readDeckAgentDeckEditChange(
  value: unknown,
): DeckAgentDeckEditChange | null {
  if (
    !isRecord(value) ||
    typeof value.scryfall_id !== "string" ||
    typeof value.name !== "string" ||
    !isEditCopyCount(value.quantity) ||
    !isEditCopyCount(value.previous_quantity) ||
    // Absent means "leave placement alone". Anything present that is not one of the two
    // sections fails the whole edit rather than falling back to the mainboard: the one
    // value it could be wrong about is the command zone, and quietly reading an
    // unrecognised section as "not the command zone" would move the user's commander out.
    (value.section !== undefined &&
      value.section !== null &&
      !isDeckSection(value.section))
  ) {
    return null;
  }
  // A change that adds copies without the card it adds cannot be applied, because the
  // validators the deck runs read fields only the payload carries. The backend already
  // refuses to emit one, so reading it here as malformed keeps the two in step.
  const card = isCardSearchResult(value.card) ? value.card : null;
  if (value.quantity > value.previous_quantity && !card) {
    return null;
  }
  return {
    scryfall_id: value.scryfall_id,
    name: value.name,
    quantity: value.quantity,
    previous_quantity: value.previous_quantity,
    ...(isDeckSection(value.section) ? { section: value.section } : {}),
    ...(card ? { card } : {}),
  };
}

/**
 * A copy count, rejected rather than coerced.
 *
 * `Number(undefined)` is `NaN` and `Number(null)` is `0`, and a quantity that quietly
 * became zero deletes a card the edit meant to keep.
 */
function isEditCopyCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_DECK_EDIT_COPIES
  );
}

/**
 * The fields the deck's own validators read, checked before an edit is trusted.
 *
 * Deliberately the same set `lib/api.ts` requires of a searched card: an edit that adds
 * a card is adding it to the board the search drawer adds to, so a payload good enough
 * for one has to be good enough for the other.
 */
function isCardSearchResult(value: unknown): value is CardSearchResult {
  return (
    isRecord(value) &&
    typeof value.oracle_id === "string" &&
    typeof value.scryfall_id === "string" &&
    typeof value.name === "string" &&
    typeof value.type_line === "string" &&
    typeof value.mana_value === "number" &&
    isRecord(value.prices)
  );
}

/**
 * One edit as the transcript keeps it: what the deck did, with no card payloads.
 *
 * The event that asked for it carries a whole `CardSearchResult` per added card, which
 * the deck needs and the transcript does not. Storing the event as it arrived would
 * spend the chat's whole storage budget on payloads the deck already holds, so the
 * conversation keeps the sentence and the deck keeps the cards.
 */
export interface DeckAgentAppliedEdit {
  /** The model's one line for an edit; the deck's own sentence for a refusal. */
  reason: string;
  /** Copies in and copies out, which is what `+2 / −2` in the transcript counts. */
  addedCopies: number;
  removedCopies: number;
  /** The card names, so the block reads without the catalog or the deck. */
  added: string[];
  removed: string[];
  /** Same count, new section: a move states neither an addition nor a cut. */
  moved: string[];
  /**
   * The history entry this block describes, when the deck recorded one.
   *
   * What decides which block may carry an Undo. `undo` reverses the deck's *last recorded
   * change*, so the affordance belongs to whichever block describes that entry and to no
   * other — a question of identity rather than of position. Comparing ids is what makes an
   * Undo impossible to strand: a block that is not the newest recorded edit simply does not
   * match, whether the newer edit came later in the same turn, in a later turn, or from the
   * user dragging a card afterwards.
   *
   * Absent on a refusal, which recorded nothing, and on a block restored from a transcript
   * an older build wrote. Both then offer no Undo, which is the safe way to be wrong.
   */
  editId?: string;
}

/**
 * Describe one recorded edit as the transcript shows and stores it.
 *
 * Written from the diff the deck derived by comparing itself before and after, and never
 * from the event that asked for the edit. The event is a request, and its copy counts are
 * the backend's belief about the snapshot this browser posted — a belief that is wrong
 * whenever the deck moved on, which it does when the user edits mid-turn and when an
 * earlier edit in the same turn already touched the card. The diff is what happened, so
 * every name and every copy counted here is true by construction.
 *
 * Takes the diff of an edit the deck *recorded*, which is why the block it returns always
 * names at least one card: an edit states copy counts and placements and nothing else, so a
 * diff it produced and that was worth recording changed a card. That is what keeps an applied
 * block distinguishable from a refusal, which names none — see `refusedDeckEdit`.
 */
export function summarizeDeckEditRecord(
  diff: DeckDiff,
  reason: string,
  editId: string,
): DeckAgentAppliedEdit {
  const summary: DeckAgentAppliedEdit = {
    reason,
    addedCopies: 0,
    removedCopies: 0,
    added: [],
    removed: [],
    moved: [],
    editId,
  };
  for (const change of diff.cards) {
    // Absent on a side means the card was not in the deck on that side, which counts as
    // none of it — an added card is every copy in, and a cut card is every copy out.
    const before = change.before?.quantity ?? 0;
    const after = change.after?.quantity ?? 0;
    if (after > before) {
      summary.addedCopies += after - before;
      summary.added.push(change.name);
    } else if (after < before) {
      summary.removedCopies += before - after;
      summary.removed.push(change.name);
    } else {
      // Neither in nor out. A derivation records a card only when something about it
      // changed, so a card at an unchanged count is one that changed section.
      summary.moved.push(change.name);
    }
  }
  return summary;
}

/**
 * A block recording that an edit did not happen, in the deck's own words.
 *
 * A refusal needs no field of its own, and deliberately has none: an edit that named no card
 * and counted no copy is not something that happened, and nothing else can produce that
 * shape. A block is written only for an edit the deck recorded, every recorded edit changed
 * at least one card, and a card that changed lands in exactly one of the three name lists.
 * Encoding a refusal in the fields the transcript already stores is what makes it survive a
 * reload, where a flag the stored-transcript reader has never heard of would quietly come
 * back as an applied edit. `reason` carries the deck's own sentence, reused rather than
 * reworded so the transcript and the toast cannot disagree about why.
 */
export function refusedDeckEdit(reason: string): DeckAgentAppliedEdit {
  return {
    reason,
    addedCopies: 0,
    removedCopies: 0,
    added: [],
    removed: [],
    moved: [],
  };
}

/** Whether a block records a refusal rather than an edit. See `refusedDeckEdit`. */
export function isRefusedDeckEdit(applied: DeckAgentAppliedEdit): boolean {
  return (
    applied.added.length === 0 &&
    applied.removed.length === 0 &&
    applied.moved.length === 0
  );
}

export interface DeckAgentChatReply {
  message: DeckAgentMessage;
  model: string;
  replayed_message_count: number;
  /** USD this whole turn cost, or null when no completion reported a figure. */
  cost_usd: number | null;
  /** Completions in this turn that reported no price, so a total can say so. */
  unpriced_call_count: number;
  tool_calls: DeckAgentToolCall[];
  card_links: DeckAgentCardLink[];
}

/** One message in the panel, with whatever the agent did before answering it. */
export interface DeckAgentTranscriptEntry {
  message: DeckAgentMessage;
  toolCalls: DeckAgentToolCall[];
  /** Kept with the message so a restored conversation is still clickable. Small
   * enough that the storage budget never trades them away. */
  cardLinks: DeckAgentCardLink[];
  /**
   * What this turn changed about the deck, already applied.
   *
   * Absent on every turn that changed nothing, which is most of them — and absent is
   * what makes "this turn edited the deck" answerable from the stored transcript alone.
   * An empty array would claim the turn edited the deck and then name nothing.
   */
  appliedEdits?: DeckAgentAppliedEdit[];
  /**
   * Present only when true: the turn was cancelled, so it committed from the stream.
   *
   * Two things read it. `serializeAgentChats` treats this turn's tool payloads as
   * load-bearing rather than as diagnostics, because they are what the next turn
   * continues from; and `buildAgentMessages` replays them, as `assistant.tool_calls`
   * plus one `tool` message each, instead of posting the prose alone.
   *
   * Absent is the ordinary turn, committed from `done`, whose prose already says
   * everything its tools found — so replaying its calls would only pay twice for the
   * same reading. Omitted rather than `false` so an answered turn costs no bytes.
   */
  interrupted?: true;
}

/** One deck's conversation: what was said, and what it cost to say it. */
export interface DeckAgentChat {
  entries: DeckAgentTranscriptEntry[];
  spentUsd: number;
  unpricedCalls: number;
  /** What is typed but not yet sent. A half-written question about one deck is
   * about that deck, so it waits here rather than following the user. */
  draft: string;
  /** When this conversation last changed — what decides whose chat is kept. */
  updatedAt: string;
}

/** Every deck's conversation, keyed by deck id. */
export type DeckAgentChatsByDeck = Record<string, DeckAgentChat>;

export const EMPTY_DECK_AGENT_CHAT: DeckAgentChat = {
  entries: [],
  spentUsd: 0,
  unpricedCalls: 0,
  draft: "",
  updatedAt: "",
};

export const DECK_AGENT_CHAT_STORAGE_KEY = "manabase.deck-agent-chats.v1";

/** As much of a draft as the composer itself accepts. */
const MAX_DRAFT_CHARS = 8_000;

/** How many decks' conversations survive a write, newest first. */
const MAX_STORED_CHATS = 12;

/**
 * Roughly how many characters the whole chat store may occupy.
 *
 * The deck library shares the same browser-storage quota and holds every card's
 * full Scryfall payload, so a chat store that grew without limit would eventually
 * stop *decks* from saving — a far worse failure than losing an old transcript.
 * When the budget runs out, tool payloads are dropped before turns and turns are
 * dropped oldest-first, so the conversation on screen is the last thing to go.
 */
const MAX_STORED_CHARS = 200_000;

/** Read the persisted chats, treating anything malformed as no chats at all. */
export function parseStoredAgentChats(raw: string | null): DeckAgentChatsByDeck {
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || !isRecord(parsed.chats)) {
    return {};
  }
  const chats: DeckAgentChatsByDeck = {};
  for (const [deckId, value] of Object.entries(parsed.chats)) {
    const chat = readStoredChat(value);
    // A deck with nothing said and nothing typed has no conversation to restore.
    if (chat && (chat.entries.length > 0 || chat.draft)) {
      chats[deckId] = chat;
    }
  }
  return chats;
}

/**
 * Render the chats for storage, inside the byte budget.
 *
 * The budget is spent newest-chat-first, and inside one chat in two passes. First
 * what was said, newest-turn-first and payload-free, because the conversation on
 * screen is the last thing that should go. Then the tool payloads, onto the turns
 * that need them most: an **interrupted** turn's payloads are what its replay is made
 * of, so they are claimed before any answered turn's, and only then does the ordinary
 * newest-first order apply. Once even a bare turn will not fit, the older turns are
 * left out entirely.
 *
 * The inversion is the whole point of the second pass. An answered turn's payloads are
 * diagnostics — its prose already says what its tools found — and losing them costs a
 * debug view. An interrupted turn's payloads are the turn: lose them and the next turn
 * replays as framing and the model pays again for every lookup.
 */
export function serializeAgentChats(chats: DeckAgentChatsByDeck): string {
  const stored: DeckAgentChatsByDeck = {};
  let used = 0;
  const recent = Object.entries(chats)
    .sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_STORED_CHATS);

  for (const [deckId, chat] of recent) {
    // Held by position rather than appended, so the second pass can upgrade one turn
    // in place without the two passes needing to agree about ordering.
    const kept: (DeckAgentTranscriptEntry | null)[] = chat.entries.map(() => null);
    for (let index = chat.entries.length - 1; index >= 0; index -= 1) {
      const lean = withoutToolPayloads(chat.entries[index]);
      const size = JSON.stringify(lean).length;
      if (used + size > MAX_STORED_CHARS) {
        // Nothing older will fit either, and stopping here is what makes the loss
        // oldest-first rather than a hole in the middle of the conversation.
        break;
      }
      kept[index] = lean;
      used += size;
    }
    for (const index of payloadPriority(chat.entries, kept)) {
      const whole = chat.entries[index];
      const lean = kept[index];
      const extra = JSON.stringify(whole).length - JSON.stringify(lean).length;
      // Skipped rather than stopped: a later turn in this order may be small enough to
      // fit where this one was not, and every one of them already has its text stored.
      if (extra <= 0 || used + extra > MAX_STORED_CHARS) {
        continue;
      }
      kept[index] = whole;
      used += extra;
    }
    const entries = kept.filter(
      (entry): entry is DeckAgentTranscriptEntry => entry !== null,
    );
    // A draft alone is worth keeping: it is the question the user was in the
    // middle of asking about this deck.
    if (entries.length > 0 || chat.draft) {
      stored[deckId] = { ...chat, entries };
    }
  }
  return JSON.stringify({ version: 1, chats: stored });
}

/**
 * Which stored turns may buy their payloads back, most deserving first.
 *
 * Interrupted turns before answered ones, and newest before oldest inside each group.
 * Only turns the first pass kept are listed: a turn that did not fit at all cannot
 * have its payloads restored.
 */
function payloadPriority(
  entries: DeckAgentTranscriptEntry[],
  kept: (DeckAgentTranscriptEntry | null)[],
): number[] {
  return entries
    .flatMap((_, index) => (kept[index] ? [index] : []))
    .sort((left, right) => {
      const byNeed =
        Number(entries[right].interrupted === true) -
        Number(entries[left].interrupted === true);
      return byNeed !== 0 ? byNeed : right - left;
    });
}

/**
 * Keep the turn, drop the payloads.
 *
 * Nulled rather than deleted so a restored turn reads as one whose payloads are gone,
 * which is what it now is — and `buildAgentMessages` reads that same absence as its
 * signal to replay the turn as framing rather than as an unanswered call. The id and
 * the deck revision stay: they are tens of characters, and neither is what makes a
 * pair replayable.
 */
function withoutToolPayloads(
  entry: DeckAgentTranscriptEntry,
): DeckAgentTranscriptEntry {
  return {
    ...entry,
    toolCalls: entry.toolCalls.map((call) => ({
      ...call,
      arguments_json: null,
      result: null,
    })),
  };
}

function readStoredChat(value: unknown): DeckAgentChat | null {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return null;
  }
  const entries = value.entries.flatMap((entry) => {
    const read = readStoredEntry(entry);
    return read ? [read] : [];
  });
  return {
    entries,
    spentUsd: readNonNegative(value.spentUsd),
    unpricedCalls: readNonNegative(value.unpricedCalls),
    // Held to the composer's own limit, so restored text can always be sent.
    draft:
      typeof value.draft === "string" ? value.draft.slice(0, MAX_DRAFT_CHARS) : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

function readStoredEntry(value: unknown): DeckAgentTranscriptEntry | null {
  if (!isRecord(value) || !isRecord(value.message)) {
    return null;
  }
  const { role, content } = value.message;
  if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
    return null;
  }
  const toolCalls = Array.isArray(value.toolCalls)
    ? value.toolCalls.flatMap((call) => {
        const read = readStoredToolCall(call);
        return read ? [read] : [];
      })
    : [];
  const cardLinks = Array.isArray(value.cardLinks)
    ? value.cardLinks.flatMap((link) => {
        const read = readStoredCardLink(link);
        return read ? [read] : [];
      })
    : [];
  const appliedEdits = Array.isArray(value.appliedEdits)
    ? value.appliedEdits.flatMap((applied) => {
        const read = readStoredAppliedEdit(applied);
        return read ? [read] : [];
      })
    : [];
  return {
    message: { role, content },
    toolCalls,
    cardLinks,
    // Restored as absent rather than as an empty list, because a turn stored before
    // the agent could edit anything did not edit anything.
    ...(appliedEdits.length > 0 ? { appliedEdits } : {}),
    // Read only from the stored `true`. A turn written before cancelling kept anything
    // was a turn that finished, and reading a missing flag as anything else would hand
    // the model a replay of calls whose results the prose already accounts for.
    ...(value.interrupted === true ? { interrupted: true as const } : {}),
  };
}

function readStoredAppliedEdit(value: unknown): DeckAgentAppliedEdit | null {
  if (!isRecord(value) || typeof value.reason !== "string") {
    return null;
  }
  return {
    reason: value.reason,
    addedCopies: readNonNegative(value.addedCopies),
    removedCopies: readNonNegative(value.removedCopies),
    added: readStoredNames(value.added),
    removed: readStoredNames(value.removed),
    moved: readStoredNames(value.moved),
    // Carried through storage because the log outlives the page too: the edit this block
    // describes is still the deck's newest recorded change after a reload, so its Undo has
    // to come back with it. Absent stays absent — a block an older build stored names no
    // entry, and inventing an id for it would attach an Undo to somebody else's edit.
    ...(typeof value.editId === "string" ? { editId: value.editId } : {}),
  };
}

function readStoredNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string")
    : [];
}

function readStoredToolCall(value: unknown): DeckAgentToolCall | null {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.signature !== "string"
  ) {
    return null;
  }
  return {
    name: value.name,
    signature: value.signature,
    ok: value.ok !== false,
    detail: typeof value.detail === "string" ? value.detail : null,
    arguments_json:
      typeof value.arguments_json === "string" ? value.arguments_json : null,
    result: typeof value.result === "string" ? value.result : null,
    // Both stay absent rather than becoming null when they were never stored, so a
    // call an older build wrote reads as a call with no id — which is exactly what it
    // is, and what sends it down the framing path instead of into a pair.
    ...(typeof value.id === "string" && value.id.length > 0
      ? { id: value.id }
      : {}),
    ...(typeof value.deckRevision === "string" && value.deckRevision.length > 0
      ? { deckRevision: value.deckRevision }
      : {}),
  };
}

function readStoredCardLink(value: unknown): DeckAgentCardLink | null {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.oracle_id !== "string"
  ) {
    return null;
  }
  return { name: value.name, oracle_id: value.oracle_id };
}

function readNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Render a model cost the way OpenRouter accounts for it: USD, to four decimals.
 *
 * A non-zero cost too small to show rounds to `<$0.0001` rather than to `$0.0000`,
 * because a real charge displayed as zero is the one reading that would be wrong.
 */
export function formatModelCostUsd(value: number): string {
  if (value > 0 && value < 0.0001) {
    return "<$0.0001";
  }
  return `$${value.toFixed(4)}`;
}

/**
 * How long one posted message's text may be, matching the backend's `MessageText`.
 *
 * Its own constant rather than a shared one, for the reason `MAX_POSTED_HISTORY_EDITS`
 * is: this is a *contract* bound, and a request that breaks it is a 422 that fails the
 * whole chat turn rather than costing the one message. A replayed `read_deck` result is
 * kilobytes, so this is the cap that actually bites — the backend lets one payload run
 * to 24,000 characters on the way out and accepts only 8,000 of it back in a `tool`
 * message. Truncated with a visible marker, in the same words the backend truncates
 * with, because a result that lies about being complete is read by the model as an
 * observation.
 */
const MAX_POSTED_MESSAGE_CHARS = 8_000;

/** What one replayed call's arguments may run to: the backend's `ToolPayloadText`. */
const MAX_POSTED_REPLAY_ARGUMENT_CHARS = 24_000;

/** How many calls one replayed assistant message may carry: `MAX_REPLAY_CALLS`. */
const MAX_POSTED_REPLAY_CALLS = 50;

/** As long as a provider call id may be: the backend's `ToolCallId`. */
const MAX_POSTED_TOOL_CALL_ID_CHARS = 200;

/** As long as a posted deck revision may be: the backend's `DeckRevision`. */
const MAX_POSTED_DECK_REVISION_CHARS = 100;

/**
 * Build one request's messages from the conversation the browser holds.
 *
 * An answered turn posts what it always did: one message, its prose, in its own role.
 * Its tools are not replayed, because its prose is the answer written from them, and
 * handing them back would pay a second time for a reading that has already been used.
 *
 * An **interrupted** turn is different: no answer was ever written from its calls, so
 * the calls themselves go back, in the only shape the provider accepts them in — one
 * `assistant` message carrying every call, then one `tool` message per call naming it
 * by id, then the partial prose as its own `assistant` message when the turn wrote any.
 *
 * A call whose result is gone — shed by the storage budget, or never stored by an older
 * build — is **not** posted as a call. An unanswered `tool_calls` entry is rejected by
 * the backend and by the provider, so replaying one would fail the whole turn instead of
 * degrading. What goes back for it is framing naming what ran, built from the same
 * `signature` the user watched appear, which tells the model where it got to without
 * claiming to hand back what it read.
 */
export function buildAgentMessages(
  entries: DeckAgentTranscriptEntry[],
): DeckAgentRequestMessage[] {
  const messages: DeckAgentRequestMessage[] = [];
  for (const entry of entries) {
    // An interrupted user message is not a thing: the flag marks a turn the agent was
    // in the middle of, so anything else is posted as the message it is.
    if (entry.interrupted !== true || entry.message.role !== "assistant") {
      messages.push({ role: entry.message.role, content: entry.message.content });
      continue;
    }
    const replayed: DeckAgentReplayPair[] = [];
    const framed: string[] = [];
    for (const call of entry.toolCalls) {
      const pair =
        replayed.length < MAX_POSTED_REPLAY_CALLS ? toReplayPair(call) : null;
      if (pair) {
        replayed.push(pair);
      } else {
        framed.push(call.signature);
      }
    }
    if (replayed.length > 0) {
      messages.push({
        role: "assistant",
        tool_calls: replayed.map((pair) => pair.call),
      });
      // Every call answered, immediately and in the order it was made, so the group is
      // whole wherever the backend's history window happens to cut.
      for (const pair of replayed) {
        messages.push({
          role: "tool",
          tool_call_id: pair.call.id,
          content: pair.result,
        });
      }
    }
    const spoken = interruptedProse(entry.message.content, framed);
    if (spoken) {
      messages.push({ role: "assistant", content: spoken });
    }
  }
  return messages;
}

/** One replayed call and the result that answers it, which travel as two messages. */
interface DeckAgentReplayPair {
  call: DeckAgentReplayCall;
  result: string;
}

/**
 * What an interrupted turn says for itself: the framing it needs, then what it wrote.
 *
 * Empty when the turn wrote nothing and every call replayed, because there is then
 * nothing left to say — and an assistant message with empty content is a 422 rather
 * than a silence.
 */
function interruptedProse(content: string, framed: string[]): string {
  const prose = content.trim();
  const framing =
    framed.length > 0 ? `interrupted after ${framed.join(", ")}` : "";
  if (!framing) {
    return postedText(prose, MAX_POSTED_MESSAGE_CHARS);
  }
  return postedText(
    prose ? `${framing}\n\n${prose}` : framing,
    MAX_POSTED_MESSAGE_CHARS,
  );
}

/**
 * One stored call as a replayable pair, or nothing when it cannot be one.
 *
 * Every reason to refuse is a rule the backend would 422 on, and refusing here costs
 * the call its result while the turn still goes: a request rejected whole is the agent
 * simply stopping. The result is checked after trimming because `MessageText` strips
 * whitespace and then demands a character, so a result of spaces is a rejected request
 * rather than an empty answer.
 */
function toReplayPair(call: DeckAgentToolCall): DeckAgentReplayPair | null {
  const id = call.id ?? "";
  const name = call.name.trim();
  const result = (call.result ?? "").trim();
  const argumentsJson = call.arguments_json ?? "";
  if (!id || id.length > MAX_POSTED_TOOL_CALL_ID_CHARS) {
    return null;
  }
  if (!name || name.length > MAX_POSTED_LABEL_CHARS) {
    return null;
  }
  // The two payloads a replay is made of. Arguments the provider cannot parse are as
  // unreplayable as a missing result, so both absences take the same path.
  if (!result || !argumentsJson) {
    return null;
  }
  const revision = (call.deckRevision ?? "").trim();
  return {
    call: {
      id,
      name,
      arguments_json: postedText(
        argumentsJson,
        MAX_POSTED_REPLAY_ARGUMENT_CHARS,
      ),
      // Dropped rather than truncated when it will not fit: a revision is compared, so
      // half of one is a value that matches nothing while claiming to be a reading.
      ...(revision && revision.length <= MAX_POSTED_DECK_REVISION_CHARS
        ? { deck_revision: revision }
        : {}),
    },
    result: postedText(result, MAX_POSTED_MESSAGE_CHARS),
  };
}

/**
 * Fit one posted string inside its contract bound, saying so when it did not fit.
 *
 * Worded to match the backend's own `_payload` marker, so a payload truncated on the
 * way out and one truncated on the way back read the same to the model.
 */
function postedText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  const marker = `\n… truncated, ${(value.length - limit).toLocaleString(
    "en-US",
  )} characters more`;
  return value.slice(0, limit - marker.length) + marker;
}

/**
 * Reduce the open deck to what the agent's tools need.
 *
 * Only identity and placement travel. The name, type line, rules and price are
 * resolved from the catalog on the backend, so the agent cannot be told the deck
 * holds a card the catalog disagrees about — and a hundred-card deck stays a small
 * request.
 *
 * `updatedAt` is the deck's own revision, and it is what makes a replayed
 * deck-dependent result checkable: the backend compares it against the revision each
 * replayed call recorded and substitutes the ones the deck has moved past. Optional
 * because a caller with no revision to report must say nothing rather than claim the
 * deck is unchanged.
 */
export function toDeckSnapshot(
  name: string,
  entries: DeckCardEntry[],
  updatedAt?: string | null,
): DeckAgentDeckSnapshot {
  const revision = (updatedAt ?? "").trim();
  return {
    name,
    cards: entries.map((entry) => ({
      scryfall_id: entry.card.scryfall_id,
      quantity: entry.quantity,
      section: entry.section,
    })),
    ...(revision && revision.length <= MAX_POSTED_DECK_REVISION_CHARS
      ? { updated_at: revision }
      : {}),
  };
}

/** Where one printing sat, and how many copies, on one side of a recorded change. */
export interface DeckAgentDeckPlacement {
  quantity: number;
  section: DeckSection;
}

/** What one recorded edit did to one card, named so it reads without the catalog. */
export interface DeckAgentDeckHistoryChange {
  name: string;
  /** Absent on the left means the card was not in the deck. */
  before?: DeckAgentDeckPlacement;
  /** Absent on the right means it was removed. */
  after?: DeckAgentDeckPlacement;
}

export interface DeckAgentDeckHistoryEdit {
  at: string;
  /** Only an agent edit has one: a card dragged across the board states no intent. */
  reason?: string;
  cards: DeckAgentDeckHistoryChange[];
  /**
   * Present only when true: the user stepped back past this edit, so it is recorded and the
   * deck does not have it.
   *
   * Posted rather than filtered out, because "put that back" is exactly the question an
   * undone edit answers, and a history that dropped them would leave the agent unable to see
   * what the user had just reversed. Omitted when false so the ordinary edit costs no bytes.
   */
  undone?: boolean;
}

export interface DeckAgentDeckSession {
  actor: DeckAgentActor;
  started_at: string;
  ended_at: string;
  edits: DeckAgentDeckHistoryEdit[];
}

/** The open deck's recorded past, oldest session first, as one turn posts it. */
export interface DeckAgentDeckHistory {
  sessions: DeckAgentDeckSession[];
}

/**
 * How many edits one request may carry in total, across every session in it.
 *
 * The session cap alone is not enough: fifty sessions of ten edits is a request body
 * worth carrying and fifty sessions of five hundred edits is not. Both bounds are the
 * backend's, and a request that exceeds either is refused whole — which would fail the
 * chat turn rather than the history, so the browser prunes to fit before it asks.
 */
const MAX_POSTED_HISTORY_EDITS = 500;

/**
 * How many sessions one request may carry.
 *
 * Deliberately its own constant rather than `DECK_HISTORY_SESSION_CAP`, which the two
 * happen to share. That one is *storage* depth — how much past the browser keeps — and it
 * exists to be tuned against the localStorage budget. This one is the backend's
 * `MAX_HISTORY_SESSIONS`, and exceeding it fails the whole chat turn with a 422. Reusing
 * the storage constant here would mean that raising read depth for a quota reason silently
 * broke every conversation, and no frontend test would have noticed.
 */
const MAX_POSTED_HISTORY_SESSIONS = 50;

/**
 * How many card changes one posted edit may carry.
 *
 * Looser than the hundred an agent edit may ask for, because this records what actually
 * happened and replacing a whole deck in one step is a hundred cards out and a hundred
 * back in.
 */
const MAX_POSTED_HISTORY_EDIT_CARDS = 250;

/** As long as one short label may be. Longer text is refused by the backend outright. */
const MAX_POSTED_LABEL_CHARS = 200;

/**
 * Project one deck's recorded history into what `read_history` reads, inside the bounds.
 *
 * Takes the stored envelope rather than a parsed log, the same way `parseStoredAgentChats`
 * does, so which browser key history lives under stays the caller's business. It is read
 * at the moment a turn is sent rather than held in state: the log is written by an effect
 * after the render that changed the deck, so anything computed during that render would be
 * exactly one edit out of date — and the edit missing would be the one just made.
 *
 * The budget is spent newest-first. What is dropped is old, and what survives is the part
 * a question about the deck as it is now can actually be about.
 */
/**
 * Whether one recorded change is one the backend will accept.
 *
 * Nothing the writer produces fails this — `deriveDeckDiff` always records a change that
 * changed something, with a real name and a placement inside the bounds. But the log is
 * read back out of `localStorage`, and `parseDeckHistory` validates the container rather
 * than every leaf, so a corrupted or hand-edited log can hold a change the backend's
 * contract refuses. A rejected request is refused **whole**, which would fail every chat
 * turn for that deck — the agent simply stops answering — instead of costing the history
 * the agent could have read. So the browser drops what it cannot post and asks anyway.
 *
 * The four ways a stored change can be unpostable, each matching a backend rule:
 * a change with neither side (its `a_change_must_change_something` validator), a blank
 * name (`ShortLabel`'s `min_length` after stripping), a copy count outside 0–99, and a
 * section outside the two it knows.
 */
function isPostableChange(change: {
  name: string;
  before: DeckCardPlacement | null;
  after: DeckCardPlacement | null;
}): boolean {
  if (!change.before && !change.after) {
    return false;
  }
  if (change.name.trim().length === 0) {
    return false;
  }
  return [change.before, change.after].every(
    (placement) =>
      placement === null ||
      (Number.isInteger(placement.quantity) &&
        placement.quantity >= 0 &&
        placement.quantity <= MAX_DECK_EDIT_COPIES &&
        (placement.section === "command_zone" ||
          placement.section === "mainboard")),
  );
}

export function toDeckAgentHistory(
  raw: string | null,
  deckId: string,
): DeckAgentDeckHistory {
  let stored: unknown = null;
  try {
    stored = raw === null ? null : JSON.parse(raw);
  } catch {
    // Unreadable history is a deck with nothing recorded, never a failed turn.
  }
  const byDeck = isRecord(stored) ? stored : {};
  const log: DeckHistory = parseDeckHistory(
    byDeck[deckId] ?? null,
    createDeckHistory(deckId),
  );

  // Which entries the deck does not have. Read from the log's own cursor rather than
  // recomputed, so the agent's reading of "undone" and the Forward button's cannot differ.
  const undone = new Set(undoneEdits(log).map((edit) => edit.id));

  const sessions: DeckAgentDeckSession[] = [];
  let budget = MAX_POSTED_HISTORY_EDITS;
  for (const session of log.sessions.slice(-MAX_POSTED_HISTORY_SESSIONS).reverse()) {
    if (budget <= 0) {
      break;
    }
    const edits = session.edits.slice(-budget);
    budget -= edits.length;
    // A session whose every edit was pruned away describes a stretch of editing with
    // nothing in it, which tells the agent less than not sending it at all.
    if (edits.length === 0) {
      continue;
    }
    sessions.push({
      actor: session.actor,
      started_at: session.started_at,
      ended_at: session.ended_at,
      edits: edits.map((edit) => ({
        at: edit.at,
        ...(edit.reason ? { reason: shortLabel(edit.reason) } : {}),
        ...(undone.has(edit.id) ? { undone: true } : {}),
        cards: edit.cards
          .filter(isPostableChange)
          .slice(0, MAX_POSTED_HISTORY_EDIT_CARDS)
          .map((change) => ({
            name: shortLabel(change.name),
            ...(change.before
              ? { before: toPostedPlacement(change.before) }
              : {}),
            ...(change.after ? { after: toPostedPlacement(change.after) } : {}),
          })),
      })),
    });
  }
  return { sessions: sessions.reverse() };
}

/**
 * One recorded placement, as the agent can read it.
 *
 * A placement is a copy count and a section, and `index` deliberately does not travel: it
 * is a restoration hint the browser uses to put a cut card back where it was, and a
 * position in `Deck.cards` means nothing to a reader who sees the deck grouped by type.
 * A stored placement written before custom groups were removed also carries `categories`,
 * which is dropped here for the same reason it is dropped everywhere else — there is no
 * group left for it to name.
 */
function toPostedPlacement(
  placement: DeckCardPlacement,
): DeckAgentDeckPlacement {
  return { quantity: placement.quantity, section: placement.section };
}

/** Held to the length the backend accepts, so a long label cannot fail a whole turn. */
function shortLabel(value: string): string {
  return value.length > MAX_POSTED_LABEL_CHARS
    ? value.slice(0, MAX_POSTED_LABEL_CHARS)
    : value;
}
