import type { CardSearchResult } from "./card";
import type { DeckCardEntry, DeckCustomGroup, DeckSection } from "./deck";
import {
  COMMAND_ZONE_GROUP_ID,
  UNASSIGNED_GROUP_ID,
  groupName,
} from "./deck";
import type { DeckCardPlacement, DeckHistory } from "./history";
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
  section: "command_zone" | "mainboard";
  group?: string;
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
  /** The group it should sit in, by display name. Absent leaves placement alone. */
  group?: string;
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
    (value.group !== undefined &&
      value.group !== null &&
      typeof value.group !== "string")
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
    ...(typeof value.group === "string" ? { group: value.group } : {}),
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
 * One applied edit as the transcript keeps it: what changed, with no card payloads.
 *
 * The event that produced it carries a whole `CardSearchResult` per added card, which
 * the deck needs and the transcript does not. Storing the event as it arrived would
 * spend the chat's whole storage budget on payloads the deck already holds, so the
 * conversation keeps the sentence and the deck keeps the cards.
 */
export interface DeckAgentAppliedEdit {
  /** The model's one line, the same text history records against the edit. */
  reason: string;
  /** Copies in and copies out, which is what `+2 / −2` in the transcript counts. */
  addedCopies: number;
  removedCopies: number;
  /** The card names, so the block reads without the catalog or the deck. */
  added: string[];
  removed: string[];
  /** Same count, new group: a move states neither an addition nor a cut. */
  moved: string[];
}

/** Reduce a resolved edit to the block the transcript shows and stores. */
export function summarizeDeckEdit(
  edit: DeckAgentDeckEdit,
): DeckAgentAppliedEdit {
  const summary: DeckAgentAppliedEdit = {
    reason: edit.reason,
    addedCopies: 0,
    removedCopies: 0,
    added: [],
    removed: [],
    moved: [],
  };
  for (const change of edit.changes) {
    if (change.quantity > change.previous_quantity) {
      summary.addedCopies += change.quantity - change.previous_quantity;
      summary.added.push(change.name);
    } else if (change.quantity < change.previous_quantity) {
      summary.removedCopies += change.previous_quantity - change.quantity;
      summary.removed.push(change.name);
    } else {
      // Neither in nor out. The backend drops a change the deck already satisfies, so
      // what is left at an unchanged count is a card that moved group.
      summary.moved.push(change.name);
    }
  }
  return summary;
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
  groupNameFor: (entry: DeckCardEntry) => string | undefined,
): DeckAgentDeckSnapshot {
  return {
    name,
    cards: entries.map((entry) => {
      const group = groupNameFor(entry);
      return {
        scryfall_id: entry.card.scryfall_id,
        quantity: entry.quantity,
        section: entry.section,
        ...(group ? { group } : {}),
      };
    }),
  };
}

/** Where one printing sat, and how many copies, on one side of a recorded change. */
export interface DeckAgentDeckPlacement {
  quantity: number;
  section: DeckSection;
  group?: string;
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
  customGroups: DeckCustomGroup[],
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
              ? { before: toPostedPlacement(change.before, customGroups) }
              : {}),
            ...(change.after
              ? { after: toPostedPlacement(change.after, customGroups) }
              : {}),
          })),
      })),
    });
  }
  return { sessions: sessions.reverse() };
}

/**
 * One recorded placement, as the agent can read it.
 *
 * The group travels as the name on screen rather than as the id the deck files it
 * under, because the agent talks about groups the way the user sees them — and because
 * an id it repeated back would resolve to nothing. A group deleted since the edge was
 * recorded resolves to no name at all, so it is left out rather than named wrongly.
 */
function toPostedPlacement(
  placement: DeckCardPlacement,
  customGroups: DeckCustomGroup[],
): DeckAgentDeckPlacement {
  const groupId = placement.categories[0];
  const named =
    groupId !== undefined &&
    groupId !== COMMAND_ZONE_GROUP_ID &&
    groupId !== UNASSIGNED_GROUP_ID &&
    customGroups.some((group) => group.id === groupId)
      ? groupName(groupId, customGroups)
      : undefined;
  return {
    quantity: placement.quantity,
    section: placement.section,
    ...(named ? { group: shortLabel(named) } : {}),
  };
}

/** Held to the length the backend accepts, so a long label cannot fail a whole turn. */
function shortLabel(value: string): string {
  return value.length > MAX_POSTED_LABEL_CHARS
    ? value.slice(0, MAX_POSTED_LABEL_CHARS)
    : value;
}
