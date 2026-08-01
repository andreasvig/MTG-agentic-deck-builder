import type { DeckAgentCardLink } from "./agent";
import { cardSymbol, type CardSymbol } from "./cardSymbols";

/**
 * One run of an agent answer, ready to render.
 *
 * The agent writes card names in braces and short Markdown for emphasis. Turning
 * that into nodes is a parse rather than a string replace because a card name is
 * clickable: it has to become an element, not styled text.
 */
export type AgentTextToken =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: AgentTextToken[] }
  | { kind: "emphasis"; children: AgentTextToken[] }
  | { kind: "card"; name: string; oracleId: string | null }
  | { kind: "symbol"; symbol: CardSymbol };

// Bold before italic, so `**x**` is not read as an empty italic wrapping `*x*`.
// None of the three may span a line break: an unclosed marker at the end of a
// streaming chunk must stay plain text rather than swallowing the rest of the answer.
const TOKEN_PATTERN = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\{([^{}\n]{1,200})\}/g;

/**
 * A braced run that is shaped like a symbol the table happens not to list.
 *
 * Braces mean mana in Magic long before they meant anything here, and the agent
 * quotes rules text, so `{T}` and `{Sol Ring}` arrive through the same syntax. The
 * symbol table settles almost every case; this catches the agent mistyping one —
 * `{2/P}`, `{W/U/B}` — which is not a card name either. Such a run is left exactly
 * as written, because dropping the braces off something whose meaning depends on
 * them is worse than showing a brace.
 */
const SYMBOL_SHAPED = /^[A-Z0-9/½∞]{1,7}$/;

/**
 * Split an answer into renderable runs.
 *
 * `links` are the names the backend resolved against the catalog. A braced name
 * that is not among them still renders as a card name — the agent meant it as one —
 * but without anything to open, because there is nothing to open it to.
 */
export function parseAgentText(
  text: string,
  links: readonly DeckAgentCardLink[] = [],
): AgentTextToken[] {
  return parseRun(
    text,
    new Map(links.map((link) => [link.name.toLowerCase(), link.oracle_id])),
  );
}

/**
 * Parse one run, descending into emphasis.
 *
 * Emphasis holds tokens rather than text because the agent bolds the cards it
 * recommends — `**{Overwhelming Stampede}**` — and a flat parse renders that as
 * literal braces in bold, which is exactly the card the reader most wants to click.
 * Each nested run is strictly shorter than its parent, so this terminates.
 */
function parseRun(
  text: string,
  oracleIdByName: Map<string, string>,
): AgentTextToken[] {
  const tokens: AgentTextToken[] = [];
  let plainFrom = 0;

  const pushPlain = (upTo: number) => {
    if (upTo > plainFrom) {
      tokens.push({ kind: "text", text: text.slice(plainFrom, upTo) });
    }
  };

  // `lastIndex` is reset per run because the pattern is a shared global regex and
  // the recursion reuses it.
  const pattern = new RegExp(TOKEN_PATTERN.source, TOKEN_PATTERN.flags);
  for (
    let match = pattern.exec(text);
    match !== null;
    match = pattern.exec(text)
  ) {
    const [whole, strong, emphasis, braced] = match;
    const symbol = braced === undefined ? null : cardSymbol(braced);
    if (symbol === null && braced !== undefined && SYMBOL_SHAPED.test(braced)) {
      // Neither a symbol we can draw nor a name we could look up. Leave the run
      // in the surrounding text, braces and all.
      continue;
    }
    pushPlain(match.index);
    if (strong !== undefined) {
      tokens.push({ kind: "strong", children: parseRun(strong, oracleIdByName) });
    } else if (emphasis !== undefined) {
      tokens.push({ kind: "emphasis", children: parseRun(emphasis, oracleIdByName) });
    } else if (symbol !== null) {
      tokens.push({ kind: "symbol", symbol });
    } else if (braced !== undefined) {
      const name = braced.trim();
      tokens.push({
        kind: "card",
        name,
        oracleId: oracleIdByName.get(name.toLowerCase()) ?? null,
      });
    }
    plainFrom = match.index + whole.length;
  }
  pushPlain(text.length);
  return tokens;
}
