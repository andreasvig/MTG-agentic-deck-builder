import type { CardSearchResult, MagicColor } from "./card";

export interface CardReference {
  oracle_id: string;
  scryfall_id: string;
  name: string;
  details?: CardSearchResult;
}

export type DeckSection = "command_zone" | "mainboard";

export interface DeckCustomGroup {
  id: string;
  name: string;
}

export interface DeckCardEntry {
  card: CardReference;
  quantity: number;
  section: DeckSection;
  categories: string[];
}

type StoredDeckCardEntry = Omit<DeckCardEntry, "section"> & {
  section: DeckSection | "maybeboard";
};

export interface Deck {
  id: string;
  name: string;
  format: "commander";
  cards: DeckCardEntry[];
  custom_groups: DeckCustomGroup[];
  created_at: string;
  updated_at: string;
}

export interface DeckLibrary {
  active_deck_id: string;
  decks: Deck[];
}

export const COMMAND_ZONE_GROUP_ID = "command_zone";
export const UNASSIGNED_GROUP_ID = "unassigned";
export const DECK_STORAGE_KEY = "manabase.active-deck.v1";
export const DECK_LIBRARY_STORAGE_KEY = "manabase.deck-library.v2";

export function groupIdForEntry(
  entry: DeckCardEntry,
  customGroups: DeckCustomGroup[],
): string {
  if (entry.section === "command_zone") {
    return COMMAND_ZONE_GROUP_ID;
  }
  const stored = entry.categories[0];
  return customGroups.some((group) => group.id === stored)
    ? stored
    : UNASSIGNED_GROUP_ID;
}

export function groupName(
  groupId: string,
  customGroups: DeckCustomGroup[],
): string {
  if (groupId === COMMAND_ZONE_GROUP_ID) {
    return "Command zone";
  }
  if (groupId === UNASSIGNED_GROUP_ID) {
    return "Not assigned";
  }
  return customGroups.find((group) => group.id === groupId)?.name ?? "Not assigned";
}

export function placementForGroup(groupId: string): {
  section: DeckSection;
  categories: string[];
} {
  if (groupId === COMMAND_ZONE_GROUP_ID) {
    return {
      section: "command_zone",
      categories: [COMMAND_ZONE_GROUP_ID],
    };
  }
  return {
    section: "mainboard",
    categories: [groupId || UNASSIGNED_GROUP_ID],
  };
}

export function getCommanderColorIdentity(
  entries: DeckCardEntry[],
): Set<MagicColor> | null {
  const commanders = entries.filter(
    (entry) => entry.section === "command_zone",
  );
  if (
    commanders.length === 0 ||
    commanders.some((entry) => !entry.card.details)
  ) {
    return null;
  }

  return new Set(
    commanders.flatMap((entry) => entry.card.details?.color_identity ?? []),
  );
}

export function isWithinCommanderColorIdentity(
  card: CardSearchResult,
  commanderIdentity: ReadonlySet<MagicColor> | null,
): boolean {
  return (
    commanderIdentity === null ||
    card.color_identity.every((color) => commanderIdentity.has(color))
  );
}

export function getColorIdentityWarnings(
  entries: DeckCardEntry[],
): Set<string> {
  const commanderIdentity = getCommanderColorIdentity(entries);
  if (commanderIdentity === null) {
    return new Set();
  }

  return new Set(
    entries
      .filter(
        (entry) =>
          entry.section !== "command_zone" &&
          entry.card.details &&
          !isWithinCommanderColorIdentity(
            entry.card.details,
            commanderIdentity,
          ),
      )
      .map((entry) => entry.card.oracle_id),
  );
}

export function createEmptyDeck(
  now = new Date(),
  name = "Untitled Commander",
): Deck {
  const timestamp = now.toISOString();
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `local-${now.getTime()}`,
    name,
    format: "commander",
    cards: [],
    custom_groups: [],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function createDeckLibrary(deck = createEmptyDeck()): DeckLibrary {
  return {
    active_deck_id: deck.id,
    decks: [deck],
  };
}

export function parseStoredDeck(
  rawValue: string | null,
  fallback = createEmptyDeck(),
): Deck {
  if (!rawValue) {
    return fallback;
  }

  try {
    const parsed: unknown = JSON.parse(rawValue);
    return isDeckBase(parsed) ? normalizeDeck(parsed) : fallback;
  } catch {
    return fallback;
  }
}

export function parseStoredDeckLibrary(
  rawValue: string | null,
  fallback = createDeckLibrary(),
): DeckLibrary {
  if (!rawValue) {
    return fallback;
  }

  try {
    const parsed: unknown = JSON.parse(rawValue);
    if (
      !isRecord(parsed) ||
      typeof parsed.active_deck_id !== "string" ||
      !Array.isArray(parsed.decks) ||
      parsed.decks.length === 0 ||
      !parsed.decks.every(isDeckBase)
    ) {
      return fallback;
    }
    const decks = parsed.decks.map(normalizeDeck);
    return {
      active_deck_id: decks.some(
        (deck) => deck.id === parsed.active_deck_id,
      )
        ? parsed.active_deck_id
        : decks[0].id,
      decks,
    };
  } catch {
    return fallback;
  }
}

function normalizeDeck(value: Record<string, unknown>): Deck {
  const storedGroups = Array.isArray(value.custom_groups)
    ? value.custom_groups.filter(isCustomGroup)
    : [];
  const knownGroupIds = new Set(storedGroups.map((group) => group.id));
  const cards = (value.cards as StoredDeckCardEntry[]).map((entry) => {
    if (entry.section === "command_zone") {
      return {
        ...entry,
        section: "command_zone" as const,
        categories: [COMMAND_ZONE_GROUP_ID],
      };
    }
    const storedGroup = entry.categories[0];
    return {
      ...entry,
      section: "mainboard" as const,
      categories: [
        storedGroup && knownGroupIds.has(storedGroup)
          ? storedGroup
          : UNASSIGNED_GROUP_ID,
      ],
    };
  });

  return {
    id: value.id as string,
    name: value.name as string,
    format: "commander",
    cards,
    custom_groups: storedGroups,
    created_at: value.created_at as string,
    updated_at: value.updated_at as string,
  };
}

function isDeckBase(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    value.format === "commander" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    Array.isArray(value.cards) &&
    value.cards.every(isDeckEntry) &&
    (value.custom_groups === undefined ||
      (Array.isArray(value.custom_groups) &&
        value.custom_groups.every(isCustomGroup)))
  );
}

function isDeckEntry(value: unknown): value is StoredDeckCardEntry {
  if (!isRecord(value) || !isRecord(value.card)) {
    return false;
  }
  return (
    typeof value.card.oracle_id === "string" &&
    typeof value.card.scryfall_id === "string" &&
    typeof value.card.name === "string" &&
    Number.isInteger(value.quantity) &&
    typeof value.quantity === "number" &&
    value.quantity > 0 &&
    (value.section === "command_zone" ||
      value.section === "mainboard" ||
      value.section === "maybeboard") &&
    Array.isArray(value.categories) &&
    value.categories.every((category) => typeof category === "string")
  );
}

function isCustomGroup(value: unknown): value is DeckCustomGroup {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    value.name.trim().length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
