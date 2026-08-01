import type { CardSearchResult } from "./card";
import type { DeckCardEntry, DeckSection } from "./deck";
import { isDeckSection } from "./deck";
import type { DeckCardPlacement, DeckDiff, DeckHistory } from "./history";
import { createDeckHistory, parseDeckHistory } from "./history";

export type DeckAgentRole = "user" | "assistant";

/** Who made one edit. The same two values the recorded history tags a session with. */
export type DeckAgentActor = "user" | "agent";

export interface DeckAgentMessage {
  role: DeckAgentRole;
  content: string;
}

/** One tool the agent ran, as the chat shows it above the answer. */
export interface DeckAgentToolCall {
  name: string;
  /** What the user reads — `read_deck()` — rendered by the backend that ran it. */
  signature: string;
  ok: boolean;
  detail: string | null;
  /**
   * The arguments the model sent, as JSON text, and the exact result it read back.
   *
   * Both are null unless the turn was sent with debug on, so null means "not
   * asked for" — never "the call had no arguments" or "it returned nothing".
   */
  arguments_json: string | null;
  result: string | null;
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
 * The budget is spent newest-chat-first and newest-turn-first: a turn is written
 * whole while there is room, then without its tool payloads, and once there is no
 * room at all the remaining older turns are left out.
 */
export function serializeAgentChats(chats: DeckAgentChatsByDeck): string {
  const stored: DeckAgentChatsByDeck = {};
  let used = 0;
  const recent = Object.entries(chats)
    .sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_STORED_CHATS);

  for (const [deckId, chat] of recent) {
    const entries: DeckAgentTranscriptEntry[] = [];
    for (let index = chat.entries.length - 1; index >= 0; index -= 1) {
      const entry = chat.entries[index];
      const whole = JSON.stringify(entry).length;
      if (used + whole <= MAX_STORED_CHARS) {
        entries.unshift(entry);
        used += whole;
        continue;
      }
      const lean = withoutToolPayloads(entry);
      const leanSize = JSON.stringify(lean).length;
      if (used + leanSize > MAX_STORED_CHARS) {
        break;
      }
      entries.unshift(lean);
      used += leanSize;
    }
    // A draft alone is worth keeping: it is the question the user was in the
    // middle of asking about this deck.
    if (entries.length > 0 || chat.draft) {
      stored[deckId] = { ...chat, entries };
    }
  }
  return JSON.stringify({ version: 1, chats: stored });
}

/**
 * Keep the turn, drop its diagnostics.
 *
 * The payloads are nulled rather than deleted so a restored turn reads as one
 * whose payloads were never asked for, which is what it now is.
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
 * Reduce the open deck to what the agent's tools need.
 *
 * Only identity and placement travel. The name, type line, rules and price are
 * resolved from the catalog on the backend, so the agent cannot be told the deck
 * holds a card the catalog disagrees about — and a hundred-card deck stays a small
 * request.
 */
export function toDeckSnapshot(
  name: string,
  entries: DeckCardEntry[],
): DeckAgentDeckSnapshot {
  return {
    name,
    cards: entries.map((entry) => ({
      scryfall_id: entry.card.scryfall_id,
      quantity: entry.quantity,
      section: entry.section,
    })),
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
