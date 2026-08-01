import {
  AlertTriangle,
  CirclePlus,
  GripVertical,
  Minus,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  type DragEndEvent,
  type DragStartEvent,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { type ReactNode, useMemo, useState } from "react";

import type { CardSearchResult } from "../domain/card";
import {
  formatEuro,
  getCardPrice,
  getKnownCardPrice,
  primaryCardType,
} from "../domain/card";
import type { DeckCardEntry, DeckSection } from "../domain/deck";
import { isDeckSection, sectionLabel } from "../domain/deck";
import { CardArt } from "./CardArt";
import { CardText } from "./CardText";

export type ViewMode = "visual" | "list";
export type SortMode = "alphabet" | "mana" | "price";

interface DeckBoardProps {
  entries: DeckCardEntry[];
  view: ViewMode;
  sort: SortMode;
  singletonWarnings: Set<string>;
  colorIdentityWarnings: Set<string>;
  onSearch: (targetSection?: DeckSection, targetLabel?: string) => void;
  onSelect: (card: CardSearchResult) => void;
  onSetQuantity: (scryfallId: string, quantity: number) => void;
  onMove: (scryfallId: string, section: DeckSection) => void;
  onRemove: (scryfallId: string) => void;
}

/**
 * One heading on the board and the cards under it.
 *
 * `section` is what a card dropped here becomes, and it is the reason every group carries one
 * even though most groups are card types: a type is derived from the card and cannot be
 * edited, so dropping a card on `Creature` cannot mean "make this a creature". It means the
 * only thing it can mean — put the card in the deck rather than the command zone.
 */
interface CardGroup {
  id: string;
  label: string;
  marker: "command_zone" | "type";
  section: DeckSection;
  entries: DeckCardEntry[];
}

export function DeckBoard({
  entries,
  view,
  sort,
  singletonWarnings,
  colorIdentityWarnings,
  onSearch,
  onSelect,
  onSetQuantity,
  onMove,
  onRemove,
}: DeckBoardProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor),
  );
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const groups = useMemo(() => makeGroups(entries, sort), [entries, sort]);
  const activeCard = activeCardId
    ? entries.find((entry) => entry.card.scryfall_id === activeCardId)?.card
        .details
    : null;

  const handleDragStart = (event: DragStartEvent) => {
    const scryfallId = event.active.data.current?.scryfallId;
    setActiveCardId(typeof scryfallId === "string" ? scryfallId : null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveCardId(null);
    const scryfallId = event.active.data.current?.scryfallId;
    if (typeof scryfallId !== "string" || !event.over) {
      return;
    }
    const target = event.over.data.current;
    const current = event.active.data.current?.section;
    // A drop is only ever a change of section, and a drop onto the section the card is
    // already in is not a move. `moveCard` declines one anyway, so this is about not asking:
    // dropping a creature back on `Creature` should not spend a history entry to say nothing.
    if (
      target?.type === "group" &&
      isDeckSection(target.section) &&
      target.section !== current
    ) {
      onMove(scryfallId, target.section);
    }
  };

  const board =
    view === "list" ? (
      <div className="deck-list" aria-label="Deck card list">
        <div className="deck-list__head" aria-hidden="true">
          <span>Qty</span>
          <span>Card</span>
          <span>Type</span>
          <span>Mana</span>
          <span>EUR</span>
          <span>Actions</span>
        </div>
        {groups.map((cardGroup) => (
          <DroppableListGroup group={cardGroup} key={cardGroup.id}>
            <GroupHeader group={cardGroup} onSearch={onSearch} />
            {cardGroup.entries.length > 0 ? (
              cardGroup.entries.map((entry) => (
                <ListRow
                  entry={entry}
                  warning={warningCopy(
                    singletonWarnings.has(entry.card.oracle_id),
                    colorIdentityWarnings.has(entry.card.oracle_id),
                  )}
                  key={entry.card.scryfall_id}
                  onSelect={onSelect}
                  onSetQuantity={onSetQuantity}
                  onRemove={onRemove}
                />
              ))
            ) : (
              <div className="deck-list__empty-group">
                {cardGroup.section === "command_zone"
                  ? "Drop a card here to make it the commander"
                  : "Drop cards here"}
              </div>
            )}
          </DroppableListGroup>
        ))}
      </div>
    ) : (
      <div className="visual-groups" aria-label="Deck visual groups">
        {groups.map((cardGroup) => (
          <DroppableVisualGroup group={cardGroup} key={cardGroup.id}>
            <GroupHeader group={cardGroup} onSearch={onSearch} />
            {cardGroup.entries.length > 0 ? (
              <div className="visual-card-grid">
                {cardGroup.entries.map((entry) => (
                  <VisualCard
                    entry={entry}
                    warning={warningCopy(
                      singletonWarnings.has(entry.card.oracle_id),
                      colorIdentityWarnings.has(entry.card.oracle_id),
                    )}
                    key={entry.card.scryfall_id}
                    onSelect={onSelect}
                    onSetQuantity={onSetQuantity}
                  />
                ))}
              </div>
            ) : (
              <button
                className="visual-group__empty"
                type="button"
                onClick={() => onSearch(cardGroup.section, cardGroup.label)}
              >
                <CirclePlus aria-hidden="true" size={18} />
                Add to {cardGroup.label.toLowerCase()}
              </button>
            )}
          </DroppableVisualGroup>
        ))}
      </div>
    );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragCancel={() => setActiveCardId(null)}
      onDragEnd={handleDragEnd}
    >
      {board}
      <DragOverlay dropAnimation={null}>
        {activeCard ? (
          <div className="drag-card-preview">
            <CardArt card={activeCard} size="small" />
            <strong>{activeCard.name}</strong>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function DroppableVisualGroup({
  group,
  children,
}: {
  group: CardGroup;
  children: ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `group:${group.id}`,
    data: { type: "group", section: group.section },
  });
  return (
    <section
      ref={setNodeRef}
      className={`visual-group ${isOver ? "visual-group--over" : ""}`}
      data-group-id={group.id}
    >
      {children}
    </section>
  );
}

function DroppableListGroup({
  group,
  children,
}: {
  group: CardGroup;
  children: ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `group:${group.id}`,
    data: { type: "group", section: group.section },
  });
  return (
    <section
      ref={setNodeRef}
      className={`deck-list__group ${
        isOver ? "deck-list__group--over" : ""
      }`}
      data-group-id={group.id}
    >
      {children}
    </section>
  );
}

function VisualCard({
  entry,
  warning,
  onSelect,
  onSetQuantity,
}: {
  entry: DeckCardEntry;
  warning: ValidationWarning | null;
  onSelect: (card: CardSearchResult) => void;
  onSetQuantity: (scryfallId: string, quantity: number) => void;
}) {
  const card = entry.card.details;
  const { attributes, isDragging, listeners, setNodeRef } = useDraggable({
    id: `card:${entry.card.scryfall_id}`,
    data: {
      type: "card",
      scryfallId: entry.card.scryfall_id,
      // Read from the entry rather than from the group it is rendered under, so a drop
      // compares the card's own placement against the target and never a heading's.
      section: entry.section,
    },
  });
  if (!card) {
    return null;
  }
  return (
    <article
      ref={setNodeRef}
      className={`deck-card ${isDragging ? "deck-card--dragging" : ""}`}
    >
      <button
        className="deck-card__art"
        type="button"
        onClick={() => onSelect(card)}
        aria-label={`Inspect ${card.name}`}
      >
        <CardArt card={card} />
        {entry.quantity > 1 ? (
          <span className="deck-card__quantity">{entry.quantity}×</span>
        ) : null}
        {warning ? (
          <span className="deck-card__warning" title={warning.title}>
            <AlertTriangle aria-label={warning.label} size={15} />
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
          className="card-drag-handle"
          type="button"
          aria-label={`Drag ${card.name}`}
          title="Move card"
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden="true" size={15} />
        </button>
      </div>
    </article>
  );
}

function GroupHeader({
  group,
  onSearch,
}: {
  group: CardGroup;
  onSearch: (targetSection?: DeckSection, targetLabel?: string) => void;
}) {
  const quantity = group.entries.reduce(
    (total, entry) => total + entry.quantity,
    0,
  );
  const subtotal = group.entries.reduce(
    (total, entry) =>
      total + getKnownCardPrice(entry.card.details) * entry.quantity,
    0,
  );
  return (
    <header className="group-header">
      <span className={`group-marker group-marker--${group.marker}`} />
      <h2>{group.label}</h2>
      <span>{quantity} cards</span>
      <strong>{formatEuro(subtotal, "—")}</strong>
      <button
        className="icon-button icon-button--compact"
        type="button"
        aria-label={`Add card to ${group.label}`}
        title={`Add to ${group.label}`}
        onClick={() => onSearch(group.section, group.label)}
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
  warning: ValidationWarning | null;
  onSelect: (card: CardSearchResult) => void;
  onSetQuantity: (scryfallId: string, quantity: number) => void;
  onRemove: (scryfallId: string) => void;
}) {
  const card = entry.card.details;
  const { attributes, isDragging, listeners, setNodeRef } = useDraggable({
    id: `card:${entry.card.scryfall_id}`,
    data: {
      type: "card",
      scryfallId: entry.card.scryfall_id,
      section: entry.section,
    },
  });
  if (!card) {
    return null;
  }
  return (
    <div
      ref={setNodeRef}
      className={`deck-list__row ${
        isDragging ? "deck-list__row--dragging" : ""
      }`}
    >
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
            aria-label={warning.label}
            size={15}
          />
        ) : null}
      </button>
      <span className="list-type">{card.type_line}</span>
      <span className="mana-line">
        <CardText text={card.mana_cost} fallback="—" />
      </span>
      <span>{formatEuro(getCardPrice(card) * entry.quantity, "—")}</span>
      <div className="list-actions">
        {/*
          Both, not one or the other. This used to show the drag handle *or* an inspect
          button depending on the grouping mode, and with drag now unconditional the
          inspect affordance had disappeared from the list entirely — leaving the row's
          name button, whose accessible name is the card and its set, as the only way in.
        */}
        <button
          className="icon-button icon-button--compact"
          type="button"
          aria-label={`Inspect ${card.name} details`}
          title="Card details"
          onClick={() => onSelect(card)}
        >
          <MoreHorizontal aria-hidden="true" size={16} />
        </button>
        <button
          className="icon-button icon-button--compact card-drag-handle"
          type="button"
          aria-label={`Drag ${card.name}`}
          title="Move card"
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden="true" size={16} />
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

/**
 * The board's headings: the command zone first, then one per card type present.
 *
 * The command zone heading is unconditional. It is the only placement a user can change, so
 * it has to be a visible drop target even when it is empty — a deck with no commander is
 * exactly the deck that needs somewhere to put one. Type headings appear only when a card
 * files under them, because a type nothing matches is a heading that can never be dropped
 * on to any effect: dropping a card on `Creature` moves it out of the command zone, and a
 * card that is already in the deck is already there.
 */
function makeGroups(
  entries: DeckCardEntry[],
  sortMode: SortMode,
): CardGroup[] {
  const sortEntries = (cards: DeckCardEntry[]) =>
    [...cards].sort((left, right) => compareEntries(left, right, sortMode));

  const mainboard = entries.filter((entry) => entry.section === "mainboard");
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
      label: sectionLabel("command_zone"),
      marker: "command_zone",
      section: "command_zone",
      entries: sortEntries(
        entries.filter((entry) => entry.section === "command_zone"),
      ),
    },
    ...presentTypes.map((type) => ({
      id: `type-${type}`,
      label: type,
      marker: "type" as const,
      section: "mainboard" as const,
      entries: sortEntries(
        mainboard.filter(
          (entry) => primaryCardType(entry.card.details) === type,
        ),
      ),
    })),
  ];
}

interface ValidationWarning {
  label: string;
  title: string;
}

function warningCopy(
  singletonWarning: boolean,
  colorIdentityWarning: boolean,
): ValidationWarning | null {
  if (singletonWarning && colorIdentityWarning) {
    return {
      label: "Singleton and color identity warning",
      title:
        "This card breaks the singleton rule and is outside the commander color identity.",
    };
  }
  if (colorIdentityWarning) {
    return {
      label: "Color identity warning",
      title: "This card is outside the commander color identity.",
    };
  }
  if (singletonWarning) {
    return {
      label: "Singleton warning",
      title: "Commander is a singleton format.",
    };
  }
  return null;
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
      getKnownCardPrice(right.card.details) -
        getKnownCardPrice(left.card.details) ||
      left.card.name.localeCompare(right.card.name)
    );
  }
  return left.card.name.localeCompare(right.card.name);
}
