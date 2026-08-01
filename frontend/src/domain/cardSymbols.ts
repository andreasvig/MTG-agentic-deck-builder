import { CARD_SYMBOLS, type CardSymbolAsset } from "./cardSymbols.generated";

/**
 * Card text, split into the parts that read as words and the parts that read as
 * symbols.
 *
 * Magic writes its costs and abilities in braces — `{2}{G}`, `{T}`, `{W/U}` — and a
 * player reads those as pictures, not as letters. Every place this application shows
 * a mana cost or an ability parses through here so the reader sees the same thing in
 * a deck row, in the inspector and in an answer from the agent.
 */
export type CardTextToken =
  | { kind: "text"; text: string }
  | { kind: "symbol"; symbol: CardSymbol };

export interface CardSymbol {
  /** The braced notation, canonicalised to Scryfall's spelling. */
  readonly notation: string;
  readonly file: string;
  readonly label: string;
}

/**
 * A braced run, bounded well above the longest real symbol (`{1000000}`).
 *
 * The bound and the table are what keep this safe — a run cannot cross a brace, and
 * anything the table does not list is left alone whatever it looked like. Excluding
 * the newline changes no outcome today, and is kept only so this reads the same as
 * the answer parser in `agentText.ts`, where an unclosed marker mid-stream really
 * can swallow the rest of a chunk.
 */
const BRACED = /\{([^{}\n]{1,20})\}/g;

/** Where the synced SVGs are served from. See `scripts/sync-card-symbols.mjs`. */
const SYMBOL_BASE = `${import.meta.env.BASE_URL}card-symbols/`;

/**
 * Look a braced run up in Scryfall's symbol table.
 *
 * The table is the whole test: a symbol is a symbol because Scryfall lists it, not
 * because it is short or uppercase. That matters most in agent prose, where `{Sol
 * Ring}` and `{T}` arrive through the same syntax. Casing is normalised because the
 * agent's varies and printed rules text's does not.
 */
export function cardSymbol(braced: string): CardSymbol | null {
  const notation = `{${braced.toUpperCase()}}`;
  const asset: CardSymbolAsset | undefined = CARD_SYMBOLS[notation];
  return asset ? { notation, file: asset.file, label: asset.label } : null;
}

/** The served path for a symbol's artwork. */
export function cardSymbolSource(symbol: CardSymbol): string {
  return `${SYMBOL_BASE}${symbol.file}`;
}

/**
 * Split rules text — or a mana cost — into words and symbols.
 *
 * A braced run the table does not know stays exactly as written. Card text is the
 * one place where showing the reader a literal `{`, ugly as it is, beats quietly
 * dropping the braces off something whose meaning depends on them.
 */
export function parseCardText(text: string): CardTextToken[] {
  const tokens: CardTextToken[] = [];
  let plainFrom = 0;

  const pattern = new RegExp(BRACED.source, BRACED.flags);
  for (
    let match = pattern.exec(text);
    match !== null;
    match = pattern.exec(text)
  ) {
    const symbol = cardSymbol(match[1]);
    if (!symbol) {
      continue;
    }
    if (match.index > plainFrom) {
      tokens.push({ kind: "text", text: text.slice(plainFrom, match.index) });
    }
    tokens.push({ kind: "symbol", symbol });
    plainFrom = match.index + match[0].length;
  }

  if (text.length > plainFrom) {
    tokens.push({ kind: "text", text: text.slice(plainFrom) });
  }
  return tokens;
}
