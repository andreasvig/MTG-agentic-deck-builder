import { Fragment } from "react";

import {
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "../domain/markdown";
import { CardSymbolIcon } from "./CardText";

/**
 * Markdown prose, rendered.
 *
 * The deck brief is written in Markdown by the user and by the agent, so it is read
 * as Markdown rather than shown as source: a bullet is a list item, `**power**` is
 * bold, and a card name is the name — no braces. Whatever the parser does not model
 * arrives as the text that was typed, which is the right outcome for a field somebody
 * is editing by hand.
 */
export function MarkdownText({ text }: { text: string }) {
  return (
    <>
      {parseMarkdown(text).map((block, index) => (
        <Fragment key={index}>{renderBlock(block)}</Fragment>
      ))}
    </>
  );
}

function renderBlock(block: MarkdownBlock) {
  if (block.kind === "heading") {
    // Not an `h1`–`h6`: see `MarkdownBlock`. A brief's `##` is emphasis, and a real
    // heading here would sit above the page's own.
    return <p className="markdown__heading">{renderInline(block.children)}</p>;
  }
  if (block.kind === "list") {
    const items = block.items.map((item, index) => (
      <li key={index}>{renderInline(item)}</li>
    ));
    return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
  }
  return <p>{renderInline(block.children)}</p>;
}

function renderInline(tokens: MarkdownInline[]) {
  return tokens.map((token, index) => {
    const key = `${index}-${token.kind}`;
    if (token.kind === "strong") {
      return <strong key={key}>{renderInline(token.children)}</strong>;
    }
    if (token.kind === "emphasis") {
      return <em key={key}>{renderInline(token.children)}</em>;
    }
    if (token.kind === "code") {
      return (
        <code key={key} className="markdown__code">
          {token.text}
        </code>
      );
    }
    if (token.kind === "symbol") {
      // A brief may name a cost — "keep the curve under {2}{G}" — and it is drawn
      // the same way every other cost in the interface is.
      return <CardSymbolIcon key={key} symbol={token.symbol} />;
    }
    return <Fragment key={key}>{token.text}</Fragment>;
  });
}
