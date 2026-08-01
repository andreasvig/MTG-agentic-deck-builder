import { describe, expect, it } from "vitest";

import { CARD_SYMBOLS } from "./cardSymbols.generated";
import { cardSymbol, cardSymbolSource, parseCardText } from "./cardSymbols";

describe("cardSymbol", () => {
  it("recognises the symbols rules text is actually written in", () => {
    expect(cardSymbol("G")).toEqual({
      notation: "{G}",
      file: "G.svg",
      label: "one green mana",
    });
    expect(cardSymbol("T")?.label).toBe("tap this permanent");
    expect(cardSymbol("W/U")?.file).toBe("WU.svg");
    expect(cardSymbol("2/B")?.file).toBe("2B.svg");
    expect(cardSymbol("G/P")?.file).toBe("GP.svg");
    expect(cardSymbol("15")?.file).toBe("15.svg");
  });

  it("normalises the agent's casing to the printed spelling", () => {
    expect(cardSymbol("t")).toEqual(cardSymbol("T"));
    expect(cardSymbol("w/u")?.notation).toBe("{W/U}");
  });

  it("knows a card name is not a symbol", () => {
    // The whole point of a table rather than a shape test: `{Sol Ring}` and `{T}`
    // reach the parser through identical syntax.
    expect(cardSymbol("Sol Ring")).toBeNull();
    expect(cardSymbol("W/U/B")).toBeNull();
    expect(cardSymbol("")).toBeNull();
  });

  it("serves artwork from this origin rather than from Scryfall", () => {
    // Rules text is symbol-dense, and the sync exists so a card renders without the
    // network. A URL pointing back out would quietly undo that.
    const source = cardSymbolSource(cardSymbol("G")!);
    expect(source).toBe("/card-symbols/G.svg");
    expect(source).not.toContain("scryfall");
  });
});

describe("the synced symbol table", () => {
  it("covers the symbols every Commander deck contains", () => {
    // A missing entry here shows up as literal braces on a card, so the sync failing
    // half way should fail a test rather than a reading.
    for (const notation of ["{W}", "{U}", "{B}", "{R}", "{G}", "{C}", "{X}", "{T}", "{0}"]) {
      expect(CARD_SYMBOLS[notation]).toBeDefined();
    }
    expect(Object.keys(CARD_SYMBOLS).length).toBeGreaterThan(60);
  });
});

describe("parseCardText", () => {
  it("splits an ability into the words and the symbols", () => {
    expect(parseCardText("{T}: Add {G}.")).toEqual([
      { kind: "symbol", symbol: cardSymbol("T") },
      { kind: "text", text: ": Add " },
      { kind: "symbol", symbol: cardSymbol("G") },
      { kind: "text", text: "." },
    ]);
  });

  it("reads a mana cost as nothing but symbols", () => {
    expect(parseCardText("{2}{G}{G}").map((token) => token.kind)).toEqual([
      "symbol",
      "symbol",
      "symbol",
    ]);
  });

  it("leaves anything the table does not know exactly as written", () => {
    // Card text is the one place a literal brace beats a silent edit: the meaning of
    // a cost lives in its braces.
    expect(parseCardText("Pay {W/U/B} or {}.")).toEqual([
      { kind: "text", text: "Pay {W/U/B} or {}." },
    ]);
  });

  it("keeps the line breaks that separate a card's abilities", () => {
    // A rules box is read line by line, and `white-space: pre-line` only preserves
    // breaks the parser hands back in the first place.
    expect(parseCardText("Flying\n{T}: Draw a card.")).toEqual([
      { kind: "text", text: "Flying\n" },
      { kind: "symbol", symbol: cardSymbol("T") },
      { kind: "text", text: ": Draw a card." },
    ]);
  });

  it("returns nothing for empty text", () => {
    expect(parseCardText("")).toEqual([]);
  });
});
