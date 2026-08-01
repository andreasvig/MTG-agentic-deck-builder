import type { DeckCardEntry } from "./deck";

export type DeckAgentRole = "user" | "assistant";

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
  return { message: { role, content }, toolCalls, cardLinks };
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
