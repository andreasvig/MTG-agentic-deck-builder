import { describe, expect, it } from "vitest";

import {
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "./markdown";

/** Everything the reader ends up seeing in one run, whatever node holds it. */
function words(tokens: MarkdownInline[]): string {
  return tokens
    .map((token) => {
      switch (token.kind) {
        case "text":
        case "code":
          return token.text;
        case "symbol":
          return token.symbol.notation;
        default:
          return words(token.children);
      }
    })
    .join("");
}

/** The block kinds in order, which is the shape the renderer turns into elements. */
function kinds(blocks: MarkdownBlock[]): string[] {
  return blocks.map((block) => block.kind);
}

describe("parseMarkdown", () => {
  it("keeps the writer's own line breaks inside one paragraph", () => {
    // Four short lines is how a brief is usually written, and it is one paragraph
    // rather than four: splitting it would put a margin between every line.
    const blocks = parseMarkdown(
      ["cEDH power target.", "Easy to pilot.", "No long combo turns."].join("\n"),
    );

    expect(kinds(blocks)).toEqual(["paragraph"]);
    expect(words((blocks[0] as { children: MarkdownInline[] }).children)).toBe(
      "cEDH power target.\nEasy to pilot.\nNo long combo turns.",
    );
  });

  it("separates paragraphs on a blank line", () => {
    expect(kinds(parseMarkdown("Intent.\n\nConstraints."))).toEqual([
      "paragraph",
      "paragraph",
    ]);
  });

  it("reads a bulleted run as one list, and a lead-in line as its own paragraph", () => {
    const blocks = parseMarkdown(
      ["Constraints:", "- Budget under €150.", "- No stax.", "* No fast mana."].join(
        "\n",
      ),
    );

    expect(kinds(blocks)).toEqual(["paragraph", "list"]);
    const list = blocks[1] as { ordered: boolean; items: MarkdownInline[][] };
    expect(list.ordered).toBe(false);
    expect(list.items.map(words)).toEqual([
      "Budget under €150.",
      "No stax.",
      "No fast mana.",
    ]);
  });

  it("tells a numbered list from a bulleted one, and does not merge the two", () => {
    const blocks = parseMarkdown(["1. Ramp.", "2) Draw.", "- Interaction."].join("\n"));

    expect(kinds(blocks)).toEqual(["list", "list"]);
    expect((blocks[0] as { ordered: boolean }).ordered).toBe(true);
    expect((blocks[1] as { ordered: boolean }).ordered).toBe(false);
    expect((blocks[0] as { items: MarkdownInline[][] }).items.map(words)).toEqual([
      "Ramp.",
      "Draw.",
    ]);
  });

  it("continues a wrapped bullet in the same item", () => {
    // A hand-edited brief wraps. The continuation belongs to the bullet above it,
    // not to a paragraph that would render outside the list.
    const blocks = parseMarkdown(
      ["- Keep the primary line short", "  and easy to explain."].join("\n"),
    );

    expect(kinds(blocks)).toEqual(["list"]);
    expect((blocks[0] as { items: MarkdownInline[][] }).items.map(words)).toEqual([
      "Keep the primary line short\nand easy to explain.",
    ]);
  });

  it("reads a hash line as a heading, with its level dropped", () => {
    // The brief is a few hundred words in a box, so `##` is emphasis rather than
    // document structure — but it must not reach the reader as literal hashes.
    const blocks = parseMarkdown("## Plan\nCombo through Thrasios.");

    expect(kinds(blocks)).toEqual(["heading", "paragraph"]);
    expect(words((blocks[0] as { children: MarkdownInline[] }).children)).toBe("Plan");
  });

  it("nests emphasis, and keeps code literal", () => {
    const [block] = parseMarkdown("**A *wide* board** and `edit_deck_text`.");
    const children = (block as { children: MarkdownInline[] }).children;

    expect(children[0]).toEqual({
      kind: "strong",
      children: [
        { kind: "text", text: "A " },
        { kind: "emphasis", children: [{ kind: "text", text: "wide" }] },
        { kind: "text", text: " board" },
      ],
    });
    expect(children).toContainEqual({ kind: "code", text: "edit_deck_text" });
  });

  it("leaves an underscore alone, because identifiers carry them", () => {
    const [block] = parseMarkdown("Set through edit_deck_text, not by hand.");

    expect((block as { children: MarkdownInline[] }).children).toEqual([
      { kind: "text", text: "Set through edit_deck_text, not by hand." },
    ]);
  });

  it("shows a braced card name as the name, without the braces", () => {
    // The braces are the transcript's convention. A brief saved before that rule was
    // scoped still holds them, and there is nothing to open here either way.
    const [block] = parseMarkdown(
      "Led by {Toggo, Goblin Weaponsmith} and {Tana, the Bloodsower}.",
    );

    expect(words((block as { children: MarkdownInline[] }).children)).toBe(
      "Led by Toggo, Goblin Weaponsmith and Tana, the Bloodsower.",
    );
  });

  it("still draws a mana symbol, and leaves a mistyped one as written", () => {
    const [block] = parseMarkdown("Curve under {2}{G}, never {2/P}.");
    const children = (block as { children: MarkdownInline[] }).children;

    expect(children.filter((token) => token.kind === "symbol")).toHaveLength(2);
    expect(words(children)).toBe("Curve under {2}{G}, never {2/P}.");
  });

  it("reads an empty brief as nothing to render", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n")).toEqual([]);
  });
});
