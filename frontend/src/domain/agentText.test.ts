import { describe, expect, it } from "vitest";

import { parseAgentText, type AgentTextToken } from "./agentText";

const LINKS = [
  { name: "Sol Ring", oracle_id: "sol-ring-id" },
  { name: "Ghalta, Primal Hunger", oracle_id: "ghalta-id" },
];

/** Everything the reader ends up seeing, in order, whatever kind of node holds it. */
function words(tokens: AgentTextToken[]): string {
  return tokens
    .map((token) => {
      switch (token.kind) {
        case "text":
          return token.text;
        case "card":
          return token.name;
        case "symbol":
          return token.symbol.notation;
        default:
          return words(token.children);
      }
    })
    .join("");
}

describe("parseAgentText", () => {
  it("turns a braced name the catalog resolved into a card", () => {
    expect(parseAgentText("Play {Sol Ring} early.", LINKS)).toEqual([
      { kind: "text", text: "Play " },
      { kind: "card", name: "Sol Ring", oracleId: "sol-ring-id" },
      { kind: "text", text: " early." },
    ]);
  });

  it("draws a mana symbol rather than reading it as a card name", () => {
    // Braces meant mana in Magic long before they meant a link here, and the agent
    // quotes rules text, so both arrive through the same syntax.
    const tokens = parseAgentText("It taps for {C}{C}, not {G}.", LINKS);

    expect(tokens.map((token) => token.kind)).toEqual([
      "text",
      "symbol",
      "symbol",
      "text",
      "symbol",
      "text",
    ]);
    expect(tokens.filter((token) => token.kind === "symbol")).toEqual([
      { kind: "symbol", symbol: { notation: "{C}", file: "C.svg", label: "one colorless mana" } },
      { kind: "symbol", symbol: { notation: "{C}", file: "C.svg", label: "one colorless mana" } },
      { kind: "symbol", symbol: { notation: "{G}", file: "G.svg", label: "one green mana" } },
    ]);
  });

  it("matches a symbol whatever case the agent used", () => {
    // Printed rules text is uppercase; the agent's typing is not always.
    const [token] = parseAgentText("Costs {t} to activate.");
    expect(token).toEqual({ kind: "text", text: "Costs " });
    expect(parseAgentText("{t}")[0]).toMatchObject({
      kind: "symbol",
      symbol: { notation: "{T}" },
    });
  });

  it("leaves a braced run that is neither a symbol nor a name exactly as written", () => {
    // The agent mistyping a symbol is still not a card name. Dropping the braces off
    // it would silently rewrite a cost; showing them is merely ugly.
    expect(parseAgentText("Pay {W/U/B} somehow.", LINKS)).toEqual([
      { kind: "text", text: "Pay {W/U/B} somehow." },
    ]);
  });

  it("still renders a braced name the catalog did not resolve, without a card", () => {
    // The agent meant a card. Showing the reader a stray `{` would be worse than
    // showing the name and having nothing to open.
    expect(parseAgentText("Try {Sol Rong}.", LINKS)).toEqual([
      { kind: "text", text: "Try " },
      { kind: "card", name: "Sol Rong", oracleId: null },
      { kind: "text", text: "." },
    ]);
  });

  it("matches a name to its link whatever case the agent used", () => {
    const [token] = parseAgentText("{sol ring}", LINKS);
    // The agent's casing varies; the catalog's does not.
    expect(token).toEqual({ kind: "card", name: "sol ring", oracleId: "sol-ring-id" });
  });

  it("reads bold and italic, preferring bold over an empty italic", () => {
    expect(parseAgentText("**73%** of *these* decks")).toEqual([
      { kind: "strong", children: [{ kind: "text", text: "73%" }] },
      { kind: "text", text: " of " },
      { kind: "emphasis", children: [{ kind: "text", text: "these" }] },
      { kind: "text", text: " decks" },
    ]);
  });

  it("renders the same words with and without links, so a stream converges", () => {
    // Nothing is resolved while a turn streams. The visible words must already be
    // final, or the message would silently rewrite itself when it commits.
    const streaming = parseAgentText("Play {Sol Ring} for {1}.");
    const committed = parseAgentText("Play {Sol Ring} for {1}.", LINKS);

    expect(words(streaming)).toBe(words(committed));
    expect(words(committed)).toBe("Play Sol Ring for {1}.");
  });

  it("keeps an unclosed marker as plain text rather than swallowing the rest", () => {
    // Mid-stream a chunk can end anywhere. A greedy match would blank the answer
    // until the closing character arrived.
    expect(parseAgentText("Play {Sol Ri")).toEqual([
      { kind: "text", text: "Play {Sol Ri" },
    ]);
    expect(parseAgentText("It is **very")).toEqual([
      { kind: "text", text: "It is **very" },
    ]);
  });

  it("does not let a brace span a line break", () => {
    // Two separate braces on two lines are not one enormous card name.
    const tokens = parseAgentText("{Sol Ring}\nand {Ghalta, Primal Hunger}", LINKS);
    expect(tokens.filter((token) => token.kind === "card")).toHaveLength(2);
  });

  it("returns nothing for empty text", () => {
    expect(parseAgentText("")).toEqual([]);
  });
});

describe("parseAgentText nesting", () => {
  it("finds a card inside bold, which is how the agent writes its pick", () => {
    // The observed failure: the agent bolds what it recommends, so the card the
    // reader most wants to click was the one rendering as literal braces.
    expect(parseAgentText("Play **{Sol Ring}** now.", LINKS)).toEqual([
      { kind: "text", text: "Play " },
      {
        kind: "strong",
        children: [{ kind: "card", name: "Sol Ring", oracleId: "sol-ring-id" }],
      },
      { kind: "text", text: " now." },
    ]);
  });

  it("finds a card inside italics too, and keeps the words around it", () => {
    expect(parseAgentText("*maybe {Sol Ring}?*", LINKS)).toEqual([
      {
        kind: "emphasis",
        children: [
          { kind: "text", text: "maybe " },
          { kind: "card", name: "Sol Ring", oracleId: "sol-ring-id" },
          { kind: "text", text: "?" },
        ],
      },
    ]);
  });

  it("draws a symbol inside bold as well as outside it", () => {
    expect(parseAgentText("**taps for {C}**")).toEqual([
      {
        kind: "strong",
        children: [
          { kind: "text", text: "taps for " },
          {
            kind: "symbol",
            symbol: { notation: "{C}", file: "C.svg", label: "one colorless mana" },
          },
        ],
      },
    ]);
  });
});
