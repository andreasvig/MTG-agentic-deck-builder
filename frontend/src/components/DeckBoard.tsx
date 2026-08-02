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

import { Icon } from "./Icon";
import type { CardSearchResult } from "../domain/card";
import {
  CARD_MOVE_DRAG_TYPE,
  CARD_NAME_DRAG_TYPE,
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
          <DroppableVisualGroup
            group={cardGroup}
            key={cardGroup.id}
            onMove={onMove}
          >
            <GroupHeader group={cardGroup} onSearch={onSearch} />
            {cardGroup.entries.length > 0 ? (
              <div className="deck-stack">
                {cardGroup.entries.map((entry) => (
                  <StackCard
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
                <Icon name="plusCircle" aria-hidden="true" size={18} />
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

/**
 * A heading and its stack, and a drop target for a card dragged out of another one.
 *
 * Native, unlike the list's group below, because the card it accepts is dragged
 * natively: a stacked card is picked up by its own art, and the browser turns that into
 * a drag of its own before any library gets a pointer move to work with. The two sides
 * meet at `CARD_MOVE_DRAG_TYPE` and nowhere else.
 *
 * `dragover` can see the *names* of the types on the drag but not their values, which is
 * exactly enough: the group knows a card is coming and lights up, and only on the drop
 * does it learn which card and where it came from.
 */
function DroppableVisualGroup({
  group,
  onMove,
  children,
}: {
  group: CardGroup;
  onMove: (scryfallId: string, section: DeckSection) => void;
  children: ReactNode;
}) {
  const [isOver, setIsOver] = useState(false);
  return (
    <section
      className={`visual-group ${isOver ? "visual-group--over" : ""}`}
      data-group-id={group.id}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(CARD_MOVE_DRAG_TYPE)) {
          return;
        }
        // Both, and in this order: without the `preventDefault` the browser refuses the
        // drop no matter what the handler below would have done with it.
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setIsOver(true);
      }}
      onDragLeave={(event) => {
        // A drag crossing a card inside the group fires `dragleave` on the section too.
        // The pointer has only really left when what it entered is outside.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        setIsOver(false);
      }}
      onDrop={(event) => {
        const moved = readCardMove(event.dataTransfer.getData(CARD_MOVE_DRAG_TYPE));
        if (!moved) {
          return;
        }
        event.preventDefault();
        setIsOver(false);
        // A drop onto the section the card is already in is not a move. `moveCard`
        // declines one anyway, so this is about not asking: dropping a creature back on
        // `Creature` should not spend a history entry to say nothing.
        if (moved.section !== group.section) {
          onMove(moved.scryfallId, group.section);
        }
      }}
    >
      {children}
    </section>
  );
}

/**
 * The move payload, back out of the drag.
 *
 * Anything can be dropped on a page, so this parses rather than trusts: a drag carrying
 * this type but not this shape is treated as no card at all, and the drop falls through
 * to the browser.
 */
function readCardMove(
  payload: string,
): { scryfallId: string; section: DeckSection } | null {
  if (!payload) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const { scryfallId, section } = parsed as Record<string, unknown>;
    if (typeof scryfallId !== "string" || !isDeckSection(section)) {
      return null;
    }
    return { scryfallId, section };
  } catch {
    return null;
  }
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

/**
 * One card in a stacked column, showing its own printed top and nothing added over it.
 *
 * A card knows how to introduce itself: the name and the mana cost are printed across
 * the top of every Magic card, in the same places on all of them, so the column reveals
 * exactly that band of each card and lets the artwork below it be covered. Anything the
 * application draws over that band — a strip repeating the name, a handle to grab —
 * competes with the one part of the card that is always on screen. The count and any
 * warning sit *outside* the corners for the same reason.
 *
 * The card is picked up by its art, and the drag means two things depending on where it
 * is let go: dropped on a group it moves there, dropped on the chat it becomes a
 * question about the card. One gesture, because the browser will not give a natively
 * dragged element a second one.
 *
 * The opening is CSS, in `.deck-stack` — nothing here knows whether it is the hovered
 * card. A card that opened by re-rendering would have to own which sibling is open, and
 * every mouse move across a column would re-render the column.
 */
function StackCard({
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
  if (!card) {
    return null;
  }
  return (
    <article className="stack-card">
      <div className="stack-card__art">
        <button
          className="stack-card__open"
          type="button"
          aria-label={`Inspect ${card.name}`}
          onClick={() => onSelect(card)}
          /*
           * `draggable` sits on the button rather than on the image because the image is
           * not always an image: a printing with no art renders as its name, and that
           * card is exactly as draggable as any other.
           */
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(CARD_NAME_DRAG_TYPE, card.name);
            event.dataTransfer.setData(
              CARD_MOVE_DRAG_TYPE,
              JSON.stringify({
                scryfallId: entry.card.scryfall_id,
                // The entry's own section, not the group it is rendered under, so a drop
                // compares the card's placement against the target and never a heading's.
                section: entry.section,
              }),
            );
            event.dataTransfer.setData("text/plain", card.name);
            // Both, because where it lands decides which it was.
            event.dataTransfer.effectAllowed = "copyMove";
          }}
        >
          <CardArt card={card} />
        </button>
        {/*
          * Outside the corner rather than inside it, and small. The band this sits on is
          * the card's printed title, so a badge placed *in* it covers the first letters
          * of a name — on the one card in the column whose name you were reading.
          *
          * Hidden from assistive technology, not because the count does not matter but
          * because the `output` below announces it already. The eye needs it on a closed
          * card because the count is the only thing the printing does not say; the ear
          * does not need it twice on the same card.
          */}
        <span className="stack-card__count" aria-hidden="true">
          {entry.quantity}
        </span>
        {/*
          * The other corner, and unlike the count it is announced: a warning nobody can
          * see until they hover is a warning about a card they had no reason to hover.
          * Both badges are `pointer-events: none` in the stylesheet, so neither puts a
          * dead spot on the corner of a card you are trying to pick up.
          */}
        {warning ? (
          <span className="stack-card__warning" title={warning.title}>
            <Icon name="warning" aria-label={warning.label} size={11} />
          </span>
        ) : null}
      </div>
      {/*
        * Under the card, not over it. Over the art these covered the bottom of the one
        * card in the column that was open — the card you had just asked to see.
        */}
      <div className="stack-card__controls">
        <button
          type="button"
          aria-label={`Decrease ${card.name} quantity`}
          onClick={() => onSetQuantity(card.scryfall_id, entry.quantity - 1)}
        >
          <Icon name="minus" aria-hidden="true" size={14} />
        </button>
        <output aria-label={`${entry.quantity} ${card.name} in deck`}>
          {entry.quantity}
        </output>
        <button
          type="button"
          aria-label={`Increase ${card.name} quantity`}
          onClick={() => onSetQuantity(card.scryfall_id, entry.quantity + 1)}
        >
          <Icon name="plus" aria-hidden="true" size={14} />
        </button>
        <span className="stack-card__price">
          {formatEuro(getCardPrice(card) * entry.quantity, "—")}
        </span>
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
        <Icon name="plusCircle" aria-hidden="true" size={16} />
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
          <Icon name="warning"
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
          <Icon name="more" aria-hidden="true" size={16} />
        </button>
        <button
          className="icon-button icon-button--compact card-drag-handle"
          type="button"
          aria-label={`Drag ${card.name}`}
          title="Move card"
          {...attributes}
          {...listeners}
        >
          <Icon name="grip" aria-hidden="true" size={16} />
        </button>
        <button
          className="icon-button icon-button--compact icon-button--danger"
          type="button"
          aria-label={`Remove ${card.name}`}
          title="Remove"
          onClick={() => onRemove(card.scryfall_id)}
        >
          <Icon name="trash" aria-hidden="true" size={15} />
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

const COLORS = ["W", "U", "B", "R", "G"];
/** {X}, and the {Y}/{Z} a handful of old cards use alongside it. */
const VARIABLES = ["X", "Y", "Z"];

interface ManaCostShape {
  /** How many variable symbols: `{0}` has none, `{X}` one, `{X}{X}` two. */
  variables: number;
  /** How many coloured pips. */
  pips: number;
  /** Those pips as WUBRG indices, ascending. */
  colors: string;
}

/**
 * The shape of a mana cost, for ordering cards that cost the same amount.
 *
 * Mana value alone leaves a curve column in name order, which puts `{2}{G}`
 * between two `{G}{G}` cards. Worse at the top of the column: a variable
 * symbol counts as zero, so `{0}`, `{X}` and `{X}{X}` all report mana value 0
 * and eighteen cards that cost three visibly different things came out
 * interleaved alphabetically.
 *
 * So the variable count is the first tiebreak — every `{X}` card at a value
 * sits together and every `{X}{X}` card after them — then the coloured-pip
 * count, then the pips themselves, which keeps cards costing exactly the same
 * thing adjacent.
 *
 * Indices rather than letters for the pips, because the string is compared
 * directly and WUBRG is not alphabetical: `"R"` must sort before `"G"`, and
 * `"3"` does before `"4"`.
 */
function manaCostShape(cost: string | null | undefined): ManaCostShape {
  // Split and double-faced cards print both halves, and `mana_value` is the
  // front face's — so the shape has to come from the front face too.
  const front = (cost ?? "").split("//")[0];
  const symbols = [...front.matchAll(/\{([^}]+)\}/g)].map(([, symbol]) =>
    symbol.toUpperCase(),
  );
  const pips = symbols
    // A hybrid or Phyrexian symbol is one coloured pip ({G/W}, {2/W}, {W/P});
    // generic, {X}, {C} and {S} are not coloured at all. A hybrid files under
    // the earliest of its halves in WUBRG rather than the one printed first,
    // so {G/W} and {W/G} are the same shape.
    .map((symbol) => {
      const colors = symbol
        .split("/")
        .map((part) => COLORS.indexOf(part))
        .filter((index) => index >= 0);
      return colors.length > 0 ? Math.min(...colors) : undefined;
    })
    .filter((index): index is number => index !== undefined)
    .sort((a, b) => a - b);
  return {
    // Counted per symbol rather than per distinct letter: {X}{X} is two.
    variables: symbols.filter((symbol) => VARIABLES.includes(symbol)).length,
    pips: pips.length,
    colors: pips.join(""),
  };
}

function compareEntries(
  left: DeckCardEntry,
  right: DeckCardEntry,
  sortMode: SortMode,
): number {
  if (sortMode === "mana") {
    const leftShape = manaCostShape(left.card.details?.mana_cost);
    const rightShape = manaCostShape(right.card.details?.mana_cost);
    return (
      (left.card.details?.mana_value ?? 0) -
        (right.card.details?.mana_value ?? 0) ||
      leftShape.variables - rightShape.variables ||
      leftShape.pips - rightShape.pips ||
      leftShape.colors.localeCompare(rightShape.colors) ||
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
