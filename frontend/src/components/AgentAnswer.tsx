import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { DeckAgentCardLink } from "../domain/agent";
import { parseAgentText, type AgentTextToken } from "../domain/agentText";
import type { CardSearchResult } from "../domain/card";
import { apiClient, type ApiClient } from "../lib/api";
import { CardArt } from "./CardArt";
import { CardSymbolIcon } from "./CardText";

/** How far from the card name the preview sits, and how far it stays off each edge. */
const PREVIEW_GAP = 12;
const PREVIEW_MARGIN = 8;
const PREVIEW_WIDTH = 244;
const PREVIEW_HEIGHT = 340;

interface AgentAnswerProps {
  text: string;
  links?: readonly DeckAgentCardLink[];
  client?: ApiClient;
  onOpenCard?: (card: CardSearchResult) => void;
}

/**
 * One assistant message, with its card names made into cards.
 *
 * The agent braces every card it names and the backend resolves those braces, so
 * this renders rather than guesses: a name is a link because the catalog said it is
 * a card, not because it looked like one.
 */
export function AgentAnswer({
  text,
  links = [],
  client = apiClient,
  onOpenCard,
}: AgentAnswerProps) {
  // One cache per message, so hovering the same card twice fetches once and a
  // conversation cannot accumulate cards nobody is looking at any more.
  const cards = useRef(new Map<string, CardSearchResult>());

  return (
    <>
      {renderTokens(parseAgentText(text, links), {
        cards: cards.current,
        client,
        onOpenCard,
      })}
    </>
  );
}

interface RenderContext {
  cards: Map<string, CardSearchResult>;
  client: ApiClient;
  onOpenCard?: (card: CardSearchResult) => void;
}

/** Render a run, descending into emphasis so a bolded card is still a card. */
function renderTokens(tokens: AgentTextToken[], context: RenderContext) {
  return tokens.map((token, index) => {
    const key = `${index}-${token.kind}`;
    if (token.kind === "strong") {
      return <strong key={key}>{renderTokens(token.children, context)}</strong>;
    }
    if (token.kind === "emphasis") {
      return <em key={key}>{renderTokens(token.children, context)}</em>;
    }
    if (token.kind === "symbol") {
      // The agent quotes rules text, so its answers carry costs and abilities. They
      // are drawn here the same way the card panels draw them.
      return <CardSymbolIcon key={key} symbol={token.symbol} />;
    }
    if (token.kind === "card") {
      return (
        <CardName
          key={key}
          name={token.name}
          oracleId={token.oracleId}
          cards={context.cards}
          client={context.client}
          onOpenCard={context.onOpenCard}
        />
      );
    }
    return <span key={key}>{token.text}</span>;
  });
}

interface CardNameProps {
  name: string;
  oracleId: string | null;
  cards: Map<string, CardSearchResult>;
  client: ApiClient;
  onOpenCard?: (card: CardSearchResult) => void;
}

function CardName({ name, oracleId, cards, client, onOpenCard }: CardNameProps) {
  const [card, setCard] = useState<CardSearchResult | null>(
    oracleId ? (cards.get(oracleId) ?? null) : null,
  );
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const previewId = useId();
  const live = useRef(true);

  // Set on the way in as well as cleared on the way out. StrictMode mounts, cleans
  // up and mounts again, so a flag only ever cleared stays cleared — and every
  // preview silently stops arriving.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const getCard = client.getCard?.bind(client);

  const load = useCallback(async () => {
    if (!oracleId || !getCard) {
      return;
    }
    if (trigger.current) {
      setAnchor(trigger.current.getBoundingClientRect());
    }
    const cached = cards.get(oracleId);
    if (cached) {
      setCard(cached);
      return;
    }
    try {
      const fetched = await getCard(oracleId);
      cards.set(oracleId, fetched);
      if (live.current) {
        setCard(fetched);
      }
    } catch {
      // A preview that cannot load is not worth reporting: the name still reads,
      // and clicking it still opens the card through its own request.
    }
  }, [cards, getCard, oracleId]);

  const hide = useCallback(() => setAnchor(null), []);

  if (!oracleId || !getCard) {
    // Either the catalog does not know the name, or this client cannot fetch a card
    // at all. Styled the same either way, so the sentence does not change shape when
    // one word of it turns out not to be openable.
    return <span className="deck-agent__card deck-agent__card--unknown">{name}</span>;
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="deck-agent__card"
        aria-describedby={anchor && card ? previewId : undefined}
        onMouseEnter={load}
        onFocus={load}
        onMouseLeave={hide}
        onBlur={hide}
        onClick={() => {
          hide();
          if (card) {
            onOpenCard?.(card);
            return;
          }
          void getCard(oracleId)
            .then((fetched) => {
              cards.set(oracleId, fetched);
              onOpenCard?.(fetched);
            })
            .catch(() => {
              // Nothing to open, and nothing useful to say about it in a sentence.
            });
        }}
      >
        {name}
      </button>
      {anchor && card ? (
        <CardPreview id={previewId} anchor={anchor} card={card} />
      ) : null}
    </>
  );
}

/**
 * The floating card image.
 *
 * Rendered into `document.body` because the transcript scrolls: inside it, the
 * preview would be clipped by the first card name near an edge. Position is computed
 * from the trigger's own rect so it never lands off-screen — the panel lives against
 * the right edge, so it opens leftward when there is no room.
 */
function CardPreview({
  id,
  anchor,
  card,
}: {
  id: string;
  anchor: DOMRect;
  card: CardSearchResult;
}) {
  const spaceOnLeft = anchor.left - PREVIEW_GAP >= PREVIEW_WIDTH + PREVIEW_MARGIN;
  const left = spaceOnLeft
    ? anchor.left - PREVIEW_GAP - PREVIEW_WIDTH
    : Math.min(
        anchor.right + PREVIEW_GAP,
        window.innerWidth - PREVIEW_WIDTH - PREVIEW_MARGIN,
      );
  const top = Math.min(
    Math.max(PREVIEW_MARGIN, anchor.top - PREVIEW_HEIGHT / 2 + anchor.height / 2),
    window.innerHeight - PREVIEW_HEIGHT - PREVIEW_MARGIN,
  );

  return createPortal(
    <div
      id={id}
      role="tooltip"
      className="deck-agent__card-preview"
      style={{
        left: `${Math.max(PREVIEW_MARGIN, left)}px`,
        top: `${Math.max(PREVIEW_MARGIN, top)}px`,
        width: `${PREVIEW_WIDTH}px`,
      }}
    >
      <CardArt card={card} size="normal" loading="eager" />
    </div>,
    document.body,
  );
}
