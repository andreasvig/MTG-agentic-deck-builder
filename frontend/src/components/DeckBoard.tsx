import {
  AlertTriangle,
  CirclePlus,
  Minus,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo } from "react";

import type { CardSearchResult } from "../domain/card";
import {
  formatEuro,
  getCardPrice,
  primaryCardType,
} from "../domain/card";
import type { DeckCardEntry, DeckCategory } from "../domain/deck";
import {
  categoryForEntry,
  categoryLabels,
  categoryOrder,
} from "../domain/deck";
import { CardArt } from "./CardArt";

export type ViewMode = "visual" | "list";
export type GroupMode = "category" | "type";
export type SortMode = "alphabet" | "mana" | "price";

interface DeckBoardProps {
  entries: DeckCardEntry[];
  view: ViewMode;
  group: GroupMode;
  sort: SortMode;
  filter: string;
  singletonWarnings: Set<string>;
  onSearch: (target?: DeckCategory) => void;
  onSelect: (card: CardSearchResult) => void;
  onSetQuantity: (scryfallId: string, quantity: number) => void;
  onRemove: (scryfallId: string) => void;
}

interface CardGroup {
  id: string;
  label: string;
  target?: DeckCategory;
  entries: DeckCardEntry[];
}

export function DeckBoard({
  entries,
  view,
  group,
  sort,
  filter,
  singletonWarnings,
  onSearch,
  onSelect,
  onSetQuantity,
  onRemove,
}: DeckBoardProps) {
  const groups = useMemo(
    () => makeGroups(entries, group, sort, filter),
    [entries, filter, group, sort],
  );
  const visibleEntries = groups.flatMap((cardGroup) => cardGroup.entries);

  if (entries.length === 0) {
    return (
      <div className="deck-empty">
        <span className="deck-empty__mark" aria-hidden="true">
          <Search size={25} />
        </span>
        <h2>Start with your commander</h2>
        <p>
          Search any printing, choose a commander, or begin filling the
          mainboard.
        </p>
        <div>
          <button
            className="primary-button"
            type="button"
            onClick={() => onSearch("command_zone")}
          >
            <CirclePlus aria-hidden="true" size={17} />
            Choose commander
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => onSearch()}
          >
            <Search aria-hidden="true" size={16} />
            Browse cards
          </button>
        </div>
      </div>
    );
  }

  if (visibleEntries.length === 0) {
    return (
      <div className="deck-empty deck-empty--filter">
        <Search aria-hidden="true" size={23} />
        <h2>No cards match “{filter}”</h2>
        <p>Clear the local filter to see the complete deck.</p>
      </div>
    );
  }

  if (view === "list") {
    return (
      <div className="deck-list" aria-label="Deck card list">
        <div className="deck-list__head" aria-hidden="true">
          <span>Qty</span>
          <span>Card</span>
          <span>Type</span>
          <span>Category</span>
          <span>Mana</span>
          <span>EUR</span>
          <span>Actions</span>
        </div>
        {groups.map((cardGroup) =>
          cardGroup.entries.length > 0 ? (
            <section className="deck-list__group" key={cardGroup.id}>
              <GroupHeader group={cardGroup} onSearch={onSearch} />
              {cardGroup.entries.map((entry) => (
                <ListRow
                  entry={entry}
                  warning={singletonWarnings.has(entry.card.oracle_id)}
                  key={entry.card.scryfall_id}
                  onSelect={onSelect}
                  onSetQuantity={onSetQuantity}
                  onRemove={onRemove}
                />
              ))}
            </section>
          ) : null,
        )}
      </div>
    );
  }

  return (
    <div className="visual-groups" aria-label="Deck visual groups">
      {groups.map((cardGroup) => (
        <section className="visual-group" key={cardGroup.id}>
          <GroupHeader group={cardGroup} onSearch={onSearch} />
          {cardGroup.entries.length > 0 ? (
            <div className="visual-card-grid">
              {cardGroup.entries.map((entry) => {
                const card = entry.card.details;
                if (!card) {
                  return null;
                }
                const warning = singletonWarnings.has(entry.card.oracle_id);
                return (
                  <article className="deck-card" key={entry.card.scryfall_id}>
                    <button
                      className="deck-card__art"
                      type="button"
                      onClick={() => onSelect(card)}
                      aria-label={`Inspect ${card.name}`}
                    >
                      <CardArt card={card} />
                      {entry.quantity > 1 ? (
                        <span className="deck-card__quantity">
                          {entry.quantity}×
                        </span>
                      ) : null}
                      {warning ? (
                        <span
                          className="deck-card__warning"
                          title="Commander is a singleton format"
                        >
                          <AlertTriangle aria-label="Singleton warning" size={15} />
                        </span>
                      ) : null}
                    </button>
                    <div className="deck-card__meta">
                      <button type="button" onClick={() => onSelect(card)}>
                        {card.name}
                      </button>
                      <span>{formatEuro(getCardPrice(card), "—")}</span>
                    </div>
                    <div className="deck-card__actions">
                      <button
                        type="button"
                        aria-label={`Decrease ${card.name} quantity`}
                        onClick={() =>
                          onSetQuantity(card.scryfall_id, entry.quantity - 1)
                        }
                      >
                        <Minus aria-hidden="true" size={14} />
                      </button>
                      <output aria-label={`${entry.quantity} ${card.name} in deck`}>
                        {entry.quantity}
                      </output>
                      <button
                        type="button"
                        aria-label={`Increase ${card.name} quantity`}
                        onClick={() =>
                          onSetQuantity(card.scryfall_id, entry.quantity + 1)
                        }
                      >
                        <Plus aria-hidden="true" size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Inspect and move ${card.name}`}
                        title="Card options"
                        onClick={() => onSelect(card)}
                      >
                        <MoreHorizontal aria-hidden="true" size={15} />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <button
              className="visual-group__empty"
              type="button"
              onClick={() => onSearch(cardGroup.target)}
            >
              <CirclePlus aria-hidden="true" size={18} />
              Add to {cardGroup.label.toLowerCase()}
            </button>
          )}
        </section>
      ))}
    </div>
  );
}

function GroupHeader({
  group,
  onSearch,
}: {
  group: CardGroup;
  onSearch: (target?: DeckCategory) => void;
}) {
  const quantity = group.entries.reduce(
    (total, entry) => total + entry.quantity,
    0,
  );
  const subtotal = group.entries.reduce(
    (total, entry) =>
      total + getCardPrice(entry.card.details as CardSearchResult) * entry.quantity,
    0,
  );
  return (
    <header className="group-header">
      <span className={`group-marker group-marker--${group.target ?? "type"}`} />
      <h2>{group.label}</h2>
      <span>{quantity} cards</span>
      <strong>{formatEuro(subtotal, "—")}</strong>
      <button
        className="icon-button icon-button--compact"
        type="button"
        aria-label={`Add card to ${group.label}`}
        title={`Add to ${group.label}`}
        onClick={() => onSearch(group.target)}
      >
        <CirclePlus aria-hidden="true" size={16} />
      </button>
    </header>
  );
}

function ListRow({
  entry,
  warning,
  onSelect,
  onSetQuantity,
  onRemove,
}: {
  entry: DeckCardEntry;
  warning: boolean;
  onSelect: (card: CardSearchResult) => void;
  onSetQuantity: (scryfallId: string, quantity: number) => void;
  onRemove: (scryfallId: string) => void;
}) {
  const card = entry.card.details;
  if (!card) {
    return null;
  }
  return (
    <div className="deck-list__row">
      <label className="list-quantity">
        <span className="sr-only">{card.name} quantity</span>
        <input
          type="number"
          min={1}
          value={entry.quantity}
          onChange={(event) =>
            onSetQuantity(card.scryfall_id, Number(event.target.value))
          }
        />
      </label>
      <button
        className="list-card-name"
        type="button"
        onClick={() => onSelect(card)}
      >
        <span className="list-art">
          <CardArt card={card} size="small" />
        </span>
        <span>
          <strong>{card.name}</strong>
          <small>
            {card.set_code.toUpperCase()} #{card.collector_number}
          </small>
        </span>
        {warning ? (
          <AlertTriangle
            className="list-warning"
            aria-label="Singleton warning"
            size={15}
          />
        ) : null}
      </button>
      <span className="list-type">{card.type_line}</span>
      <span>{categoryLabels[categoryForEntry(entry)]}</span>
      <span className="mana-line">{card.mana_cost || "—"}</span>
      <span>{formatEuro(getCardPrice(card) * entry.quantity, "—")}</span>
      <div className="list-actions">
        <button
          className="icon-button icon-button--compact"
          type="button"
          aria-label={`Inspect and move ${card.name}`}
          title="Card options"
          onClick={() => onSelect(card)}
        >
          <MoreHorizontal aria-hidden="true" size={16} />
        </button>
        <button
          className="icon-button icon-button--compact icon-button--danger"
          type="button"
          aria-label={`Remove ${card.name}`}
          title="Remove"
          onClick={() => onRemove(card.scryfall_id)}
        >
          <Trash2 aria-hidden="true" size={15} />
        </button>
      </div>
    </div>
  );
}

function makeGroups(
  entries: DeckCardEntry[],
  groupMode: GroupMode,
  sortMode: SortMode,
  filter: string,
): CardGroup[] {
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const filtered = entries.filter((entry) => {
    const card = entry.card.details;
    return (
      !normalizedFilter ||
      entry.card.name.toLocaleLowerCase().includes(normalizedFilter) ||
      card?.type_line.toLocaleLowerCase().includes(normalizedFilter) ||
      card?.oracle_text?.toLocaleLowerCase().includes(normalizedFilter) ||
      card?.set_name.toLocaleLowerCase().includes(normalizedFilter)
    );
  });
  const sortEntries = (cards: DeckCardEntry[]) =>
    [...cards].sort((left, right) => compareEntries(left, right, sortMode));

  if (groupMode === "category") {
    return categoryOrder.map((category) => ({
      id: category,
      label: categoryLabels[category],
      target: category,
      entries: sortEntries(
        filtered.filter((entry) => categoryForEntry(entry) === category),
      ),
    }));
  }

  const mainboard = filtered.filter((entry) => entry.section === "mainboard");
  const presentTypes = [
    "Land",
    "Creature",
    "Instant",
    "Sorcery",
    "Artifact",
    "Enchantment",
    "Planeswalker",
    "Battle",
    "Other",
  ].filter((type) =>
    mainboard.some((entry) => primaryCardType(entry.card.details) === type),
  );
  return [
    {
      id: "command_zone",
      label: "Command zone",
      target: "command_zone",
      entries: sortEntries(
        filtered.filter((entry) => entry.section === "command_zone"),
      ),
    },
    ...presentTypes.map((type) => ({
      id: `type-${type}`,
      label: type,
      entries: sortEntries(
        mainboard.filter(
          (entry) => primaryCardType(entry.card.details) === type,
        ),
      ),
    })),
    {
      id: "maybeboard",
      label: "Maybeboard",
      target: "maybeboard",
      entries: sortEntries(
        filtered.filter((entry) => entry.section === "maybeboard"),
      ),
    },
  ];
}

function compareEntries(
  left: DeckCardEntry,
  right: DeckCardEntry,
  sortMode: SortMode,
): number {
  if (sortMode === "mana") {
    return (
      (left.card.details?.mana_value ?? 0) -
        (right.card.details?.mana_value ?? 0) ||
      left.card.name.localeCompare(right.card.name)
    );
  }
  if (sortMode === "price") {
    return (
      getCardPrice(right.card.details as CardSearchResult) -
        getCardPrice(left.card.details as CardSearchResult) ||
      left.card.name.localeCompare(right.card.name)
    );
  }
  return left.card.name.localeCompare(right.card.name);
}
