import { getKnownCardPrice } from "./card";
import type { Deck, DeckCardEntry } from "./deck";

/**
 * The shapes this deck can leave the application in.
 *
 * There are two audiences and they want different files, which is why `text` and `arena`
 * are not one format with a flag. A **shop** — Cardmarket's wants import, TCGplayer's Mass
 * Entry — parses every line as a card to sell you, so a `Commander` heading would be read
 * as a card called "Commander" and the whole paste fails on it. A **deck site** — Moxfield,
 * Archidekt, Arena itself — needs those headings to know which card is the commander.
 *
 * So `text` is headingless on purpose. Do not "improve" it by adding sections.
 */
export type DeckExportFormat = "text" | "arena" | "csv";

export interface DeckExportFormatDescriptor {
  id: DeckExportFormat;
  label: string;
  /** What the file is called, and what a paste target expects. */
  extension: string;
  mimeType: string;
  /** Named in the dialog, so the choice is made on where it is going, not on its name. */
  destinations: string;
}

export const DECK_EXPORT_FORMATS: readonly DeckExportFormatDescriptor[] = [
  {
    id: "text",
    label: "Plain text",
    extension: "txt",
    mimeType: "text/plain",
    destinations:
      "Cardmarket wants, TCGplayer Mass Entry, Moxfield, Archidekt, EDHREC",
  },
  {
    id: "arena",
    label: "MTG Arena",
    extension: "txt",
    mimeType: "text/plain",
    destinations: "Moxfield, Archidekt, MTG Arena — pins the exact printing",
  },
  {
    id: "csv",
    label: "CSV",
    extension: "csv",
    mimeType: "text/csv",
    destinations: "Spreadsheets and collection trackers",
  },
];

/** TCGplayer's documented bulk-cart parameter. Lines are joined by a literal `||`. */
const TCGPLAYER_MASS_ENTRY = "https://www.tcgplayer.com/massentry";

/**
 * Layouts whose two faces have two names, printed one per side.
 *
 * Arena names such a card by its front face alone. Every *other* multi-part layout —
 * split, adventure, flip, aftermath — is one physical face carrying `A // B` as its
 * printed name, and that whole string is what both Arena and a shop expect.
 */
const FRONT_FACE_ONLY_LAYOUTS = new Set([
  "transform",
  "modal_dfc",
  "reversible_card",
]);

export function exportDeck(deck: Deck, format: DeckExportFormat): string {
  const commanders = sortedSection(deck, "command_zone");
  const mainboard = sortedSection(deck, "mainboard");

  if (format === "csv") {
    return csvExport([...commanders, ...mainboard]);
  }
  if (format === "arena") {
    return arenaExport(commanders, mainboard);
  }
  return [...commanders, ...mainboard].map(plainLine).join("\n");
}

/**
 * A cart on TCGplayer holding every card in the deck, or nothing when the deck is empty.
 *
 * Deliberately built from the *headingless* lines: the parameter is the same parser as the
 * paste box, so it has the same objection to the word "Commander" on a line of its own.
 */
export function tcgplayerMassEntryUrl(deck: Deck): string | null {
  const lines = [
    ...sortedSection(deck, "command_zone"),
    ...sortedSection(deck, "mainboard"),
  ].map(plainLine);
  if (lines.length === 0) {
    return null;
  }
  const cards = encodeURIComponent(lines.join("||"));
  return `${TCGPLAYER_MASS_ENTRY}?productline=Magic&c=${cards}`;
}

export function deckExportFilename(
  deck: Deck,
  format: DeckExportFormat,
): string {
  const descriptor = describeDeckExportFormat(format);
  const slug =
    deck.name
      .normalize("NFKD")
      // Anything that is not a letter, a digit or a space becomes a break. A deck called
      // "Ghalta / Mavren" must not produce a filename with a path separator in it.
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 60) || "deck";
  return `${slug}.${descriptor.extension}`;
}

export function describeDeckExportFormat(
  format: DeckExportFormat,
): DeckExportFormatDescriptor {
  const descriptor = DECK_EXPORT_FORMATS.find((entry) => entry.id === format);
  if (!descriptor) {
    throw new Error(`Unknown deck export format: ${format}`);
  }
  return descriptor;
}

function arenaExport(
  commanders: DeckCardEntry[],
  mainboard: DeckCardEntry[],
): string {
  const blocks: string[] = [];
  if (commanders.length > 0) {
    blocks.push(
      ["Commander", ...commanders.map(arenaLine)].join("\n"),
    );
  }
  if (mainboard.length > 0) {
    blocks.push(["Deck", ...mainboard.map(arenaLine)].join("\n"));
  }
  // One blank line between blocks is what the format uses to end a section.
  return blocks.join("\n\n");
}

function csvExport(entries: DeckCardEntry[]): string {
  const rows = entries.map((entry) => [
    String(entry.quantity),
    entry.card.name,
    entry.card.details?.set_code.toUpperCase() ?? "",
    entry.card.details?.collector_number ?? "",
    getKnownCardPrice(entry.card.details).toFixed(2),
  ]);
  return [
    ["Quantity", "Name", "Set", "Collector number", "Price EUR"],
    ...rows,
  ]
    .map((row) => row.map(csvField).join(","))
    .join("\n");
}

/**
 * A field a spreadsheet reads back as one value.
 *
 * Not optional politeness: legendary creatures are named "Elesh Norn, Grand Cenobite", so
 * an unquoted name column splits a deck's commanders across two cells.
 */
function csvField(value: string): string {
  return /[",\n]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

function plainLine(entry: DeckCardEntry): string {
  return `${entry.quantity} ${entry.card.name}`;
}

/**
 * `1 Sol Ring (LTC) 285` — the printing this deck actually priced and pictured.
 *
 * A deck entry may carry no `details` at all (`isDeckEntry` does not require one, so a deck
 * saved by an older build hydrates without it). Such a card falls back to a bare
 * `1 Sol Ring`, which every importer still accepts — it just picks its own printing. Better
 * a line that resolves to the wrong art than a line reading `(undefined) undefined`.
 */
function arenaLine(entry: DeckCardEntry): string {
  const details = entry.card.details;
  const name = details && FRONT_FACE_ONLY_LAYOUTS.has(details.layout)
    ? frontFaceName(entry.card.name)
    : entry.card.name;
  if (!details) {
    return `${entry.quantity} ${name}`;
  }
  return `${entry.quantity} ${name} (${details.set_code.toUpperCase()}) ${details.collector_number}`;
}

function frontFaceName(name: string): string {
  return name.split("//")[0].trim();
}

function sortedSection(
  deck: Deck,
  section: DeckCardEntry["section"],
): DeckCardEntry[] {
  return deck.cards
    .filter((entry) => entry.section === section)
    .sort((left, right) => left.card.name.localeCompare(right.card.name));
}
