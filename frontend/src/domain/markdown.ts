import { cardSymbol, type CardSymbol } from "./cardSymbols";

/**
 * One run inside a block of Markdown prose.
 *
 * This is the deck brief's syntax, not the agent transcript's: a name here is text,
 * never a link. `agentText.ts` is the parser for the other one, where a braced name
 * has been resolved against the catalog and has a card to open.
 */
export type MarkdownInline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: MarkdownInline[] }
  | { kind: "emphasis"; children: MarkdownInline[] }
  | { kind: "code"; text: string }
  | { kind: "symbol"; symbol: CardSymbol };

/**
 * One block of Markdown prose.
 *
 * A heading carries no level: the brief is a few hundred words inside a labelled box,
 * so `##` is emphasis the writer reached for rather than document structure, and
 * rendering it as a real heading would put an `h3` above the page's `h1`. Depth is
 * dropped rather than the line rendering as a literal `##`.
 */
export type MarkdownBlock =
  | { kind: "heading"; children: MarkdownInline[] }
  | { kind: "paragraph"; children: MarkdownInline[] }
  | { kind: "list"; ordered: boolean; items: MarkdownInline[][] };

// Up to three leading spaces, as Markdown allows, before the marker that decides the
// block. A numbered item accepts `1.` and `1)`; both are written in practice.
const HEADING_LINE = /^ {0,3}(#{1,6})\s+(.*)$/;
const BULLET_LINE = /^ {0,3}[-*+]\s+(.*)$/;
const NUMBERED_LINE = /^ {0,3}\d{1,9}[.)]\s+(.*)$/;

/**
 * Bold before italic, so `**x**` is not read as an empty italic wrapping `*x*`, and
 * code first, so backticked asterisks stay literal. A bold run admits a single `*`,
 * which is what lets `**a *wide* board**` nest rather than fail to match at all. None
 * may span a line break: a lone `*` in one paragraph must not italicise the rest of
 * the brief.
 *
 * `_x_` is deliberately absent. Underscores appear in this project's own prose —
 * `edit_deck_text`, `snake_case` — far more often than as emphasis, and reading them
 * as italics would eat the underscores out of an identifier.
 */
const INLINE_PATTERN =
  /`([^`\n]+)`|\*\*((?:[^*\n]|\*(?!\*))+?)\*\*|\*([^*\n]+)\*|\{([^{}\n]{1,200})\}/g;

/**
 * A braced run shaped like a symbol the table happens not to list — `{2/P}`,
 * `{W/U/B}` mistyped. Left exactly as written, as everywhere else: dropping the
 * braces off something whose meaning depends on them is worse than showing a brace.
 */
const SYMBOL_SHAPED = /^[A-Z0-9/½∞]{1,7}$/;

/**
 * Parse a brief into blocks.
 *
 * Blank lines separate blocks; single newlines inside a paragraph or an item are kept
 * as written, because a brief is often four short lines the writer meant as four
 * lines. The renderer preserves them, so nothing here has to model a hard break.
 */
export function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({
        kind: "paragraph",
        children: parseInline(paragraph.join("\n")),
      });
      paragraph = [];
    }
    if (list !== null) {
      blocks.push({
        kind: "list",
        ordered: list.ordered,
        items: list.items.map((item) => parseInline(item)),
      });
      list = null;
    }
  };

  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = HEADING_LINE.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", children: parseInline(heading[2].trim()) });
      continue;
    }
    const bullet = BULLET_LINE.exec(line);
    const numbered = bullet ? null : NUMBERED_LINE.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const ordered = numbered !== null;
      if (paragraph.length > 0) {
        // A list may open directly under a lead-in line, with no blank line between.
        flush();
      }
      if (list !== null && list.ordered !== ordered) {
        // Switching marker starts a second list rather than mixing the two.
        flush();
      }
      if (list === null) {
        list = { ordered, items: [] };
      }
      list.items.push(item[1]);
      continue;
    }
    if (list !== null) {
      // A plain line after an item continues that item: a wrapped bullet is one
      // bullet, not a bullet followed by a stray paragraph.
      list.items[list.items.length - 1] += `\n${line.trim()}`;
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Parse one run, descending into emphasis so `**bold *and* italic**` nests. */
function parseInline(text: string): MarkdownInline[] {
  const tokens: MarkdownInline[] = [];
  let plainFrom = 0;

  const pushPlain = (upTo: number) => {
    if (upTo > plainFrom) {
      tokens.push({ kind: "text", text: text.slice(plainFrom, upTo) });
    }
  };

  // `lastIndex` is per run because the pattern is a shared global regex and the
  // recursion reuses it.
  const pattern = new RegExp(INLINE_PATTERN.source, INLINE_PATTERN.flags);
  for (
    let match = pattern.exec(text);
    match !== null;
    match = pattern.exec(text)
  ) {
    const [whole, code, strong, emphasis, braced] = match;
    const symbol = braced === undefined ? null : cardSymbol(braced);
    if (symbol === null && braced !== undefined && SYMBOL_SHAPED.test(braced)) {
      continue;
    }
    pushPlain(match.index);
    if (code !== undefined) {
      tokens.push({ kind: "code", text: code });
    } else if (strong !== undefined) {
      tokens.push({ kind: "strong", children: parseInline(strong) });
    } else if (emphasis !== undefined) {
      tokens.push({ kind: "emphasis", children: parseInline(emphasis) });
    } else if (symbol !== null) {
      tokens.push({ kind: "symbol", symbol });
    } else if (braced !== undefined) {
      // A braced card name, which the brief is not written in: the agent braces
      // names for the transcript, where they become links, and a brief saved before
      // that rule was scoped still holds them. Shown as the name, without braces —
      // there is nothing to open here, and `{Toggo, Goblin Weaponsmith}` reads as
      // markup leaking into prose.
      tokens.push({ kind: "text", text: braced.trim() });
    }
    plainFrom = match.index + whole.length;
  }
  pushPlain(text.length);
  return tokens;
}
