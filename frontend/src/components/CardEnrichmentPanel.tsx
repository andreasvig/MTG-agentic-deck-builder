import { ExternalLink, Tags } from "lucide-react";
import { useEffect, useState } from "react";

import type {
  CardEnrichment,
  CardSearchResult,
  CardTag,
  CardTagFilter,
  RelatedOracleCard,
} from "../domain/card";
import { apiClient, type ApiClient } from "../lib/api";

type EnrichmentState =
  | { phase: "loading"; enrichment: null; message: null }
  | { phase: "success"; enrichment: CardEnrichment; message: null }
  | { phase: "error"; enrichment: null; message: string };

interface CardEnrichmentPanelProps {
  oracleId: string;
  client?: ApiClient;
  onOpenCard?: (card: CardSearchResult) => void;
  onSelectTag?: (tag: CardTagFilter) => void;
}

export function CardEnrichmentPanel({
  oracleId,
  client = apiClient,
  onOpenCard,
  onSelectTag,
}: CardEnrichmentPanelProps) {
  const [state, setState] = useState<EnrichmentState>({
    phase: "loading",
    enrichment: null,
    message: null,
  });
  const [openingCardId, setOpeningCardId] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);

  useEffect(() => {
    if (!client.getCardEnrichment) {
      return;
    }
    const controller = new AbortController();
    setState({ phase: "loading", enrichment: null, message: null });
    void client
      .getCardEnrichment(oracleId, controller.signal)
      .then((enrichment) => {
        if (!controller.signal.aborted) {
          setState({ phase: "success", enrichment, message: null });
        }
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        setState({
          phase: "error",
          enrichment: null,
          message:
            error instanceof Error
              ? error.message
              : "Card tags are temporarily unavailable.",
        });
      });
    return () => controller.abort();
  }, [client, oracleId]);

  if (!client.getCardEnrichment) {
    return null;
  }
  if (state.phase === "loading") {
    return (
      <section className="card-enrichment card-enrichment--loading" role="status">
        <Tags aria-hidden="true" size={13} />
        Loading card tags…
      </section>
    );
  }
  if (state.phase === "error") {
    return (
      <p className="card-enrichment__unavailable" role="status">
        {state.message}
      </p>
    );
  }

  const { enrichment } = state;
  const hasRelationships =
    enrichment.similar_cards.length > 0 ||
    enrichment.references.length > 0;
  if (enrichment.tags.length === 0 && !hasRelationships) {
    return null;
  }

  return (
    <section className="card-enrichment" aria-label="Scryfall Tagger details">
      {enrichment.tags.length > 0 ? (
        <div className="card-enrichment__group">
          <h4>
            Card tags <span>{enrichment.tags.length}</span>
          </h4>
          <div className="card-enrichment__tags">
            {enrichment.tags.map((tag) => (
              <TagChip
                tag={tag}
                onSelect={onSelectTag}
                key={tag.id}
              />
            ))}
          </div>
        </div>
      ) : null}
      <RelatedCards
        heading="Similar cards"
        cards={enrichment.similar_cards}
        client={client}
        openingCardId={openingCardId}
        onOpenCard={onOpenCard}
        onStartOpening={setOpeningCardId}
        onNavigationError={setNavigationError}
      />
      <RelatedCards
        heading="References"
        cards={enrichment.references}
        client={client}
        openingCardId={openingCardId}
        onOpenCard={onOpenCard}
        onStartOpening={setOpeningCardId}
        onNavigationError={setNavigationError}
      />
      {navigationError ? (
        <p className="card-enrichment__navigation-error" role="status">
          {navigationError}
        </p>
      ) : null}
    </section>
  );
}

function TagChip({
  tag,
  onSelect,
}: {
  tag: CardTag;
  onSelect?: (tag: CardTagFilter) => void;
}) {
  if (!onSelect) {
    return <span title={tag.description ?? undefined}>{tag.name}</span>;
  }
  return (
    <button
      type="button"
      title={
        tag.description
          ? `${tag.description} Search this tag`
          : `Search cards tagged ${tag.name}`
      }
      onClick={() => onSelect({ id: tag.id, name: tag.name })}
    >
      {tag.name}
    </button>
  );
}

function RelatedCards({
  heading,
  cards,
  client,
  openingCardId,
  onOpenCard,
  onStartOpening,
  onNavigationError,
}: {
  heading: string;
  cards: RelatedOracleCard[];
  client: ApiClient;
  openingCardId: string | null;
  onOpenCard?: (card: CardSearchResult) => void;
  onStartOpening: (oracleId: string | null) => void;
  onNavigationError: (message: string | null) => void;
}) {
  if (cards.length === 0) {
    return null;
  }
  return (
    <div className="card-enrichment__group">
      <h4>{heading}</h4>
      <div className="card-enrichment__links">
        {cards.map((card) => {
          const canOpenLocally = Boolean(onOpenCard && client.getCard);
          return canOpenLocally ? (
            <button
              type="button"
              disabled={openingCardId !== null}
              onClick={async () => {
                onStartOpening(card.oracle_id);
                onNavigationError(null);
                try {
                  const resolved = await client.getCard?.(card.oracle_id);
                  if (resolved) {
                    onOpenCard?.(resolved);
                  }
                } catch (error) {
                  onNavigationError(
                    error instanceof Error
                      ? error.message
                      : "That related card could not be opened.",
                  );
                } finally {
                  onStartOpening(null);
                }
              }}
              key={card.oracle_id}
            >
              <span>
                {card.name}
                {openingCardId === card.oracle_id ? " — opening…" : ""}
              </span>
            </button>
          ) : (
            <a
              href={scryfallOracleUrl(card.oracle_id)}
              target="_blank"
              rel="noreferrer"
              key={card.oracle_id}
            >
              <span>{card.name}</span>
              <ExternalLink aria-hidden="true" size={11} />
            </a>
          );
        })}
      </div>
    </div>
  );
}

function scryfallOracleUrl(oracleId: string): string {
  return `https://scryfall.com/search?q=${encodeURIComponent(`oracleid:${oracleId}`)}`;
}
