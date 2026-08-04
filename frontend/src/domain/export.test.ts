import { describe, expect, it } from "vitest";

import type { CardSearchResult } from "./card";
import type { Deck, DeckCardEntry, DeckSection } from "./deck";
import {
  DECK_EXPORT_FORMATS,
  deckExportFilename,
  describeDeckExportFormat,
  exportDeck,
  tcgplayerMassEntryUrl,
} from "./export";
import { counterspell, ghalta, solRing } from "../test/fixtures";

/**
 * Every card this file exports is here because it carries a property the export has to get
 * right — a comma in the name, no `details`, two faces, a set code needing a case change.
 * A deck of ordinary cards would pass every assertion below while the format was wrong.
 */
const eleshNorn: CardSearchResult = {
  ...counterspell,
  oracle_id: "oracle-elesh-norn",
  scryfall_id: "printing-elesh-norn",
  name: "Elesh Norn, Grand Cenobite",
  set_code: "mm3",
  collector_number: "9",
  prices: { ...counterspell.prices, eur: "12.50" },
};

const brutalCathar: CardSearchResult = {
  ...counterspell,
  oracle_id: "oracle-brutal-cathar",
  scryfall_id: "printing-brutal-cathar",
  name: "Brutal Cathar // Moonrage Brute",
  layout: "transform",
  set_code: "mid",
  collector_number: "7",
};

const wearTear: CardSearchResult = {
  ...counterspell,
  oracle_id: "oracle-wear-tear",
  scryfall_id: "printing-wear-tear",
  name: "Wear // Tear",
  layout: "split",
  set_code: "dgm",
  collector_number: "135",
};

function entry(
  card: CardSearchResult,
  section: DeckSection = "mainboard",
  quantity = 1,
): DeckCardEntry {
  return {
    card: {
      oracle_id: card.oracle_id,
      scryfall_id: card.scryfall_id,
      name: card.name,
      details: card,
    },
    quantity,
    section,
  };
}

/** A card a deck saved by an older build hydrates without: a name and nothing else. */
function detaillessEntry(name: string): DeckCardEntry {
  return {
    card: {
      oracle_id: `oracle-${name}`,
      scryfall_id: `printing-${name}`,
      name,
    },
    quantity: 1,
    section: "mainboard",
  };
}

function deckOf(cards: DeckCardEntry[], name = "Ghalta Stompy"): Deck {
  return {
    id: "deck-1",
    name,
    description: "",
    format: "commander",
    cards,
    created_at: "2026-08-01T09:00:00.000Z",
    updated_at: "2026-08-01T09:05:00.000Z",
  };
}

describe("plain text", () => {
  it("writes one quantity-and-name line per card, commander first", () => {
    const deck = deckOf([
      entry(solRing),
      entry(counterspell),
      entry(ghalta, "command_zone"),
    ]);

    expect(exportDeck(deck, "text")).toBe(
      ["1 Ghalta, Primal Hunger", "1 Counterspell", "1 Sol Ring"].join("\n"),
    );
  });

  it("carries no section headings, because a shop reads every line as a card", () => {
    const deck = deckOf([entry(ghalta, "command_zone"), entry(solRing)]);

    // The regression this pins: a "Commander" heading is a line Cardmarket's wants import
    // and TCGplayer's Mass Entry both try to buy. Every line must start with a count.
    for (const line of exportDeck(deck, "text").split("\n")) {
      expect(line).toMatch(/^\d+ \S/);
    }
  });

  it("keeps both halves of a split card's printed name", () => {
    const deck = deckOf([entry(wearTear), entry(brutalCathar)]);

    expect(exportDeck(deck, "text")).toBe(
      ["1 Brutal Cathar // Moonrage Brute", "1 Wear // Tear"].join("\n"),
    );
  });

  it("counts copies", () => {
    expect(exportDeck(deckOf([entry(solRing, "mainboard", 4)]), "text")).toBe(
      "4 Sol Ring",
    );
  });

  it("is empty for an empty deck", () => {
    expect(exportDeck(deckOf([]), "text")).toBe("");
  });
});

describe("MTG Arena", () => {
  it("heads each section and names the printing the deck priced", () => {
    const deck = deckOf([
      entry(solRing),
      entry(ghalta, "command_zone"),
      entry(counterspell),
    ]);

    expect(exportDeck(deck, "arena")).toBe(
      [
        "Commander",
        "1 Ghalta, Primal Hunger (RIX) 130",
        "",
        "Deck",
        "1 Counterspell (MH2) 267",
        "1 Sol Ring (CMM) 396",
      ].join("\n"),
    );
  });

  it("names a double-faced card by its front face alone", () => {
    const deck = deckOf([entry(brutalCathar)]);

    expect(exportDeck(deck, "arena")).toBe("Deck\n1 Brutal Cathar (MID) 7");
  });

  it("keeps a split card whole, because that is its printed name", () => {
    const deck = deckOf([entry(wearTear)]);

    expect(exportDeck(deck, "arena")).toBe("Deck\n1 Wear // Tear (DGM) 135");
  });

  it("falls back to a bare line for a card with no printing on record", () => {
    const deck = deckOf([detaillessEntry("Lightning Bolt")]);

    // An importer picks its own printing for this one. That beats "(undefined) undefined",
    // which no importer accepts at all.
    expect(exportDeck(deck, "arena")).toBe("Deck\n1 Lightning Bolt");
  });

  it("omits a section it has no cards for", () => {
    const deck = deckOf([entry(ghalta, "command_zone")]);

    expect(exportDeck(deck, "arena")).toBe(
      "Commander\n1 Ghalta, Primal Hunger (RIX) 130",
    );
  });
});

describe("CSV", () => {
  it("quotes a name containing a comma", () => {
    const deck = deckOf([entry(eleshNorn)]);

    expect(exportDeck(deck, "csv")).toBe(
      [
        "Quantity,Name,Set,Collector number,Price EUR",
        '1,"Elesh Norn, Grand Cenobite",MM3,9,12.50',
      ].join("\n"),
    );
  });

  it("prices a card with no printing on record at zero rather than failing", () => {
    const deck = deckOf([detaillessEntry("Lightning Bolt")]);

    expect(exportDeck(deck, "csv")).toBe(
      [
        "Quantity,Name,Set,Collector number,Price EUR",
        "1,Lightning Bolt,,,0.00",
      ].join("\n"),
    );
  });
});

describe("the TCGplayer cart link", () => {
  it("joins the headingless lines with a literal double pipe", () => {
    const deck = deckOf([entry(ghalta, "command_zone"), entry(solRing)]);

    expect(tcgplayerMassEntryUrl(deck)).toBe(
      "https://www.tcgplayer.com/massentry?productline=Magic" +
        "&c=1%20Ghalta%2C%20Primal%20Hunger%7C%7C1%20Sol%20Ring",
    );
  });

  it("is nothing at all for an empty deck", () => {
    expect(tcgplayerMassEntryUrl(deckOf([]))).toBeNull();
  });
});

describe("the download filename", () => {
  it("slugs the deck name and takes the format's extension", () => {
    expect(deckExportFilename(deckOf([], "Ghalta Stompy"), "text")).toBe(
      "ghalta-stompy.txt",
    );
    expect(deckExportFilename(deckOf([], "Ghalta Stompy"), "csv")).toBe(
      "ghalta-stompy.csv",
    );
  });

  it("cannot produce a path separator from a deck name", () => {
    expect(deckExportFilename(deckOf([], "Ghalta / Mavren"), "text")).toBe(
      "ghalta-mavren.txt",
    );
    expect(deckExportFilename(deckOf([], "../../etc/passwd"), "text")).toBe(
      "etc-passwd.txt",
    );
  });

  it("names a deck whose title survives no character at all", () => {
    expect(deckExportFilename(deckOf([], "???"), "text")).toBe("deck.txt");
  });
});

describe("the format table", () => {
  it("describes every format the type allows", () => {
    for (const descriptor of DECK_EXPORT_FORMATS) {
      expect(describeDeckExportFormat(descriptor.id)).toBe(descriptor);
    }
  });
});
