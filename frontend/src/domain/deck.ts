import type { CardSearchResult, MagicColor } from "./card";

export interface CardReference {
  oracle_id: string;
  scryfall_id: string;
  name: string;
  details?: CardSearchResult;
}

/**
 * Where a card sits, and the only axis a card can be moved along.
 *
 * There were once two axes: this one, and a user-defined group stored in a `categories`
 * array. The groups are gone — the board groups by card type, which is derived from the
 * card and cannot be edited — so a placement is a section and nothing else. Anything that
 * used to pass a "group id" around passes one of these two values, because those are the
 * only ids there ever were once the custom ones went.
 */
export type DeckSection = "command_zone" | "mainboard";

export interface DeckCardEntry {
  card: CardReference;
  quantity: number;
  section: DeckSection;
}

/**
 * A stored entry may carry fields this build no longer models: `maybeboard` as a section,
 * and the `categories` array that held a custom group id. Both are read, dropped and never
 * written again, so a deck saved by an older build opens without them.
 */
type StoredDeckCardEntry = Omit<DeckCardEntry, "section"> & {
  section: DeckSection | "maybeboard";
  categories?: unknown;
};

export interface Deck {
  id: string;
  name: string;
  format: "commander";
  cards: DeckCardEntry[];
  created_at: string;
  updated_at: string;
}

export interface DeckLibrary {
  active_deck_id: string;
  decks: Deck[];
}

export interface CommandZoneValidation {
  allowed: boolean;
  reason: string | null;
}

export const COMMAND_ZONE_SECTION: DeckSection = "command_zone";
export const MAINBOARD_SECTION: DeckSection = "mainboard";
export const DECK_STORAGE_KEY = "manabase.active-deck.v1";
export const DECK_LIBRARY_STORAGE_KEY = "manabase.deck-library.v2";

/**
 * What a section is called wherever one is named — a board heading, the inspector's
 * placement control, the deck snapshot the agent reads, and the label the agent may write
 * back. One function so those cannot come to disagree: the agent is told a card is in the
 * "Command zone" using the same string that resolves back to a section.
 */
export function sectionLabel(section: DeckSection): string {
  return section === "command_zone" ? "Command zone" : "Deck";
}

/** The section behind a label, or nothing when it names neither. Matched case-insensitively. */
export function sectionForLabel(label: string): DeckSection | undefined {
  const wanted = label.trim().toLowerCase();
  if (wanted === sectionLabel("command_zone").toLowerCase()) {
    return "command_zone";
  }
  return wanted === sectionLabel("mainboard").toLowerCase()
    ? "mainboard"
    : undefined;
}

export function isDeckSection(value: unknown): value is DeckSection {
  return value === "command_zone" || value === "mainboard";
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

export function validateCommandZoneAddition(
  entries: DeckCardEntry[],
  candidate: CardSearchResult,
): CommandZoneValidation {
  const commanders = entries.filter(
    (entry) => entry.section === "command_zone",
  );
  if (commanders.length === 0) {
    return { allowed: true, reason: null };
  }
  if (
    commanders.some(
      (entry) => entry.card.oracle_id === candidate.oracle_id,
    )
  ) {
    return {
      allowed: false,
      reason: `${candidate.name} is already in the command zone. Commanders may only have one copy.`,
    };
  }
  if (commanders.length >= 2) {
    return {
      allowed: false,
      reason:
        "The command zone already has two legal paired commanders. Move one out before adding another.",
    };
  }

  const current = commanders[0];
  if (!current.card.details || current.quantity !== 1) {
    return {
      allowed: false,
      reason:
        "The current command zone must contain one known commander before a legal second commander can be checked.",
    };
  }
  if (!canShareCommandZone(current.card.details, candidate)) {
    return {
      allowed: false,
      reason: `${candidate.name} cannot share the command zone with ${current.card.name}. A second commander needs a legal Partner, Partner with, Friends forever, Choose a Background, or Doctor's companion pairing.`,
    };
  }
  return { allowed: true, reason: null };
}

export function getCommandZoneProblem(
  entries: DeckCardEntry[],
): string | null {
  const commanders = entries.filter(
    (entry) => entry.section === "command_zone",
  );
  if (commanders.length === 0) {
    return null;
  }
  if (commanders.some((entry) => entry.quantity !== 1)) {
    return "Each commander must appear exactly once in the command zone.";
  }
  if (commanders.length === 1) {
    return null;
  }
  if (commanders.length > 2) {
    return "A Commander deck can have at most two commanders in its command zone.";
  }

  const [left, right] = commanders;
  if (!left.card.details || !right.card.details) {
    return "The two command-zone cards could not be verified as a legal commander pair.";
  }
  return canShareCommandZone(left.card.details, right.card.details)
    ? null
    : `${left.card.name} and ${right.card.name} are not a legal commander pair.`;
}

export function canShareCommandZone(
  left: CardSearchResult,
  right: CardSearchResult,
): boolean {
  if (
    left.oracle_id === right.oracle_id ||
    left.legalities.commander !== "legal" ||
    right.legalities.commander !== "legal"
  ) {
    return false;
  }

  if (
    hasOracleKeyword(left, "Partner") &&
    hasOracleKeyword(right, "Partner")
  ) {
    return true;
  }
  if (
    hasOracleKeyword(left, "Friends forever") &&
    hasOracleKeyword(right, "Friends forever")
  ) {
    return true;
  }

  const leftPartner = namedPartner(left);
  const rightPartner = namedPartner(right);
  if (
    leftPartner &&
    rightPartner &&
    normalizedCardName(leftPartner) === normalizedCardName(right.name) &&
    normalizedCardName(rightPartner) === normalizedCardName(left.name)
  ) {
    return true;
  }

  if (
    (hasOracleKeyword(left, "Choose a Background") &&
      isLegendaryBackground(right)) ||
    (hasOracleKeyword(right, "Choose a Background") &&
      isLegendaryBackground(left))
  ) {
    return true;
  }

  return (
    (hasOracleKeyword(left, "Doctor's companion") &&
      isLegendaryTimeLordDoctor(right)) ||
    (hasOracleKeyword(right, "Doctor's companion") &&
      isLegendaryTimeLordDoctor(left))
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

/**
 * Bring a stored deck up to what this build models, dropping what it no longer does.
 *
 * A deck saved before custom groups were removed carries `custom_groups` and a `categories`
 * array per card. Both are dropped here rather than migrated, because there is nowhere left
 * to put them: the board groups by card type, so a stored group name has no display and no
 * control. The cards themselves are untouched — only where a card was *filed* is lost, never
 * whether the deck holds it — and the command zone, which is the one placement that survived,
 * comes through as it always did.
 */
function normalizeDeck(value: Record<string, unknown>): Deck {
  const cards = (value.cards as StoredDeckCardEntry[]).map(
    ({ categories: _categories, ...entry }) => ({
      ...entry,
      section:
        entry.section === "command_zone"
          ? ("command_zone" as const)
          : ("mainboard" as const),
    }),
  );

  return {
    id: value.id as string,
    name: value.name as string,
    format: "commander",
    cards,
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
    value.cards.every(isDeckEntry)
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
    // `categories` is deliberately not checked. A deck this build writes has none, so
    // requiring one would reject every deck saved from here on; a deck an older build wrote
    // has one, and it is dropped rather than read.
    (value.section === "command_zone" ||
      value.section === "mainboard" ||
      value.section === "maybeboard")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function oracleLines(card: CardSearchResult): string[] {
  const text = [
    card.oracle_text,
    ...card.card_faces.map((face) => face.oracle_text),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return text.split("\n").map((line) => line.trim());
}

function hasOracleKeyword(
  card: CardSearchResult,
  keyword: string,
): boolean {
  const normalizedKeyword = keyword.toLocaleLowerCase();
  return oracleLines(card).some((line) => {
    const normalizedLine = line.toLocaleLowerCase();
    return (
      normalizedLine === normalizedKeyword ||
      normalizedLine.startsWith(`${normalizedKeyword} (`)
    );
  });
}

function namedPartner(card: CardSearchResult): string | null {
  const partnerLine = oracleLines(card).find((line) =>
    line.toLocaleLowerCase().startsWith("partner with "),
  );
  if (!partnerLine) {
    return null;
  }
  const nameAndReminder = partnerLine.slice("Partner with ".length);
  const reminderStart = nameAndReminder.indexOf(" (");
  return (
    reminderStart >= 0
      ? nameAndReminder.slice(0, reminderStart)
      : nameAndReminder
  ).trim();
}

function isLegendaryBackground(card: CardSearchResult): boolean {
  return (
    /\bLegendary\b/i.test(card.type_line) &&
    /\bBackground\b/i.test(card.type_line)
  );
}

function isLegendaryTimeLordDoctor(card: CardSearchResult): boolean {
  return (
    /\bLegendary\b/i.test(card.type_line) &&
    /\bTime Lord Doctor\b/i.test(card.type_line)
  );
}

function normalizedCardName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}
