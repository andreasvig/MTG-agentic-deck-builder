import { useEffect, useState } from "react";

import type {
  CardEnrichment,
  CardSearchResult,
  CardTag,
  CardTagFilter,
  EdhrecSimilarCard,
  RelatedOracleCard,
} from "../domain/card";
import { Icon } from "./Icon";
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
  const edhrecSimilar = useEdhrecSimilarCards(oracleId, client);

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
        <Icon name="tags" aria-hidden="true" size={13} />
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
  // Ordered by what actually helps while building a deck: what to play instead
  // comes first, then the shape variations, then the wording cross-references.
  const relationshipGroups: { heading: string; cards: RelatedOracleCard[] }[] = [
    { heading: "Upgrades", cards: enrichment.upgrades },
    { heading: "Similar cards", cards: enrichment.similar_cards },
    { heading: "Creature versions", cards: enrichment.creature_versions },
    { heading: "Spell versions", cards: enrichment.spell_versions },
    { heading: "Outclasses", cards: enrichment.downgrades },
    { heading: "Variants", cards: enrichment.variants },
    { heading: "Related cards", cards: enrichment.related_cards },
    { heading: "References", cards: enrichment.references },
    // `referenced_by` stays deliberately unrendered — see docs/search.md and the
    // changelog entry that removed it while keeping the data in the contract.
  ];
  // EDHREC goes last despite being useful, because it arrives over the network and
  // appending it keeps it from shifting the local groups once it resolves.
  const groups = [
    ...relationshipGroups,
    { heading: "Similar on EDHREC", cards: edhrecSimilar },
  ];
  // The container draws its own divider, so an empty one would leave a stray rule.
  if (enrichment.tags.length === 0 && groups.every((g) => g.cards.length === 0)) {
    return null;
  }

  return (
    <section className="card-enrichment" aria-label="Card tags and related cards">
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
      {groups.map((group) => (
        <RelatedCards
          heading={group.heading}
          cards={group.cards}
          client={client}
          openingCardId={openingCardId}
          onOpenCard={onOpenCard}
          onStartOpening={setOpeningCardId}
          onNavigationError={setNavigationError}
          key={group.heading}
        />
      ))}
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
              <Icon name="external" aria-hidden="true" size={11} />
            </a>
          );
        })}
      </div>
    </div>
  );
}

/**
 * EDHREC's similar cards, loaded separately because this is a network call behind a
 * 30-day cache rather than a local read. It resolves to an empty list while loading
 * and on failure: the Tagger groups beside it are local and must never be delayed
 * or replaced by an EDHREC outage, so nothing is reported to the reader.
 */
function useEdhrecSimilarCards(
  oracleId: string,
  client: ApiClient,
): RelatedOracleCard[] {
  const [cards, setCards] = useState<EdhrecSimilarCard[]>([]);

  useEffect(() => {
    if (!client.getCardEdhrecSimilar) {
      return;
    }
    const controller = new AbortController();
    setCards([]);
    void client
      .getCardEdhrecSimilar(oracleId, controller.signal)
      .then((similar) => {
        if (!controller.signal.aborted) {
          setCards(similar.status === "applied" ? similar.cards : []);
        }
      })
      .catch(() => {
        // An unreachable EDHREC is not worth reporting next to local data.
      });
    return () => controller.abort();
  }, [client, oracleId]);

  // A published name that matches no local card cannot be opened, so it is left out
  // of the links rather than rendered as a dead control.
  return cards
    .filter((card): card is EdhrecSimilarCard & { oracle_id: string } =>
      Boolean(card.oracle_id),
    )
    .map((card) => ({ oracle_id: card.oracle_id, name: card.name }));
}

function scryfallOracleUrl(oracleId: string): string {
  return `https://scryfall.com/search?q=${encodeURIComponent(`oracleid:${oracleId}`)}`;
}
