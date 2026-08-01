import { Fragment, type ReactNode } from "react";

import {
  cardSymbolSource,
  parseCardText,
  type CardSymbol,
} from "../domain/cardSymbols";

interface CardTextProps {
  /** A mana cost, an ability, a whole rules box — anything printed on a card. */
  text: string | null | undefined;
  /** Shown when the card has no such text at all, e.g. a land's absent mana cost. */
  fallback?: ReactNode;
}

/**
 * Card text with its symbols drawn.
 *
 * Every mana cost and every line of rules text in the interface goes through this
 * one component, so `{T}: Add {G}.` reads the same in a deck row, in the inspector
 * and in an answer from the agent. Anything the symbol table does not recognise is
 * left exactly as written.
 */
export function CardText({ text, fallback = null }: CardTextProps) {
  if (!text) {
    return <>{fallback}</>;
  }

  return (
    <>
      {parseCardText(text).map((token, index) =>
        token.kind === "symbol" ? (
          <CardSymbolIcon key={index} symbol={token.symbol} />
        ) : (
          <Fragment key={index}>{token.text}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * One symbol, sized to the text around it.
 *
 * Scryfall's own reading of the symbol is the alternative text, so a cost read aloud
 * comes out as "two generic mana, one green mana" rather than as punctuation. The
 * artwork is served from this origin — see `scripts/sync-card-symbols.mjs`.
 */
export function CardSymbolIcon({ symbol }: { symbol: CardSymbol }) {
  return (
    <img
      className="card-symbol"
      src={cardSymbolSource(symbol)}
      alt={symbol.label}
      draggable={false}
    />
  );
}
