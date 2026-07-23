import type { CardSearchResult } from "./card";

export interface CardReference {
  oracle_id: string;
  scryfall_id: string;
  name: string;
  details?: CardSearchResult;
}

export type DeckSection = "command_zone" | "mainboard" | "maybeboard";
export type DeckCategory =
  | "command_zone"
  | "lands"
  | "creatures"
  | "other_spells"
  | "maybeboard";

export interface DeckCardEntry {
  card: CardReference;
  quantity: number;
  section: DeckSection;
  categories: string[];
}

export interface Deck {
  id: string;
  name: string;
  format: "commander";
  cards: DeckCardEntry[];
  created_at: string;
  updated_at: string;
}

export const DECK_STORAGE_KEY = "manabase.active-deck.v1";

export const categoryLabels: Record<DeckCategory, string> = {
  command_zone: "Command zone",
  lands: "Lands",
  creatures: "Creatures",
  other_spells: "Other spells",
  maybeboard: "Maybeboard",
};

export const categoryOrder: DeckCategory[] = [
  "command_zone",
  "lands",
  "creatures",
  "other_spells",
  "maybeboard",
];

export function categoryForCard(card: CardSearchResult): DeckCategory {
  if (card.type_line.includes("Land")) {
    return "lands";
  }
  if (card.type_line.includes("Creature")) {
    return "creatures";
  }
  return "other_spells";
}

export function categoryForEntry(entry: DeckCardEntry): DeckCategory {
  if (entry.section === "command_zone") {
    return "command_zone";
  }
  if (entry.section === "maybeboard") {
    return "maybeboard";
  }
  const stored = entry.categories[0];
  if (stored === "lands" || stored === "creatures" || stored === "other_spells") {
    return stored;
  }
  return entry.card.details ? categoryForCard(entry.card.details) : "other_spells";
}

export function placementForCategory(category: DeckCategory): {
  section: DeckSection;
  categories: string[];
} {
  if (category === "command_zone") {
    return { section: "command_zone", categories: ["command_zone"] };
  }
  if (category === "maybeboard") {
    return { section: "maybeboard", categories: ["maybeboard"] };
  }
  return { section: "mainboard", categories: [category] };
}

export function createEmptyDeck(now = new Date()): Deck {
  const timestamp = now.toISOString();
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `local-${now.getTime()}`,
    name: "Untitled Commander",
    format: "commander",
    cards: [],
    created_at: timestamp,
    updated_at: timestamp,
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
    if (!isDeck(parsed)) {
      return fallback;
    }
    return parsed;
  } catch {
    return fallback;
  }
}

function isDeck(value: unknown): value is Deck {
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
    value.cards.every(isDeckEntry)
  );
}

function isDeckEntry(value: unknown): value is DeckCardEntry {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
