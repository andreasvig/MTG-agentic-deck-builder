import {
  AlertTriangle,
  Check,
  CirclePlus,
  GripVertical,
  Minus,
  MoreHorizontal,
  Plus,
  Trash2,
  X,
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
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { CardSearchResult } from "../domain/card";
import {
  formatEuro,
  getCardPrice,
  primaryCardType,
} from "../domain/card";
import type { DeckCardEntry, DeckCustomGroup } from "../domain/deck";
import {
  COMMAND_ZONE_GROUP_ID,
  groupIdForEntry,
  groupName,
  UNASSIGNED_GROUP_ID,
} from "../domain/deck";
import { CardArt } from "./CardArt";

export type ViewMode = "visual" | "list";
export type GroupMode = "custom" | "type";
export type SortMode = "alphabet" | "mana" | "price";

interface DeckBoardProps {
  entries: DeckCardEntry[];
  customGroups: DeckCustomGroup[];
  view: ViewMode;
  group: GroupMode;
  sort: SortMode;
  singletonWarnings: Set<string>;
  colorIdentityWarnings: Set<string>;
  onSearch: (targetGroupId?: string, targetLabel?: string) => void;
  onAddCustomGroup: (name: string, moveScryfallId?: string) => void;
  onSelect: (card: CardSearchResult) => void;
  onSetQuantity: (scryfallId: string, quantity: number) => void;
  onMove: (scryfallId: string, groupId: string) => void;
  onRemove: (scryfallId: string) => void;
}

interface CardGroup {
  id: string;
  label: string;
  marker: "command_zone" | "unassigned" | "custom" | "type";
  targetGroupId?: string;
  entries: DeckCardEntry[];
}

export function DeckBoard({
  entries,
  customGroups,
  view,
  group,
  sort,
  singletonWarnings,
  colorIdentityWarnings,
  onSearch,
  onAddCustomGroup,
  onSelect,
  onSetQuantity,
  onMove,
  onRemove,
}: DeckBoardProps) {
  const dragEnabled = group === "custom";
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor),
  );
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const [pendingNewGroupCardId, setPendingNewGroupCardId] = useState<
    string | null
  >(null);
  const groups = useMemo(
    () => makeGroups(entries, customGroups, group, sort),
    [customGroups, entries, group, sort],
  );
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
    const targetType = event.over.data.current?.type;
    if (targetType === "new-group") {
      setPendingNewGroupCardId(scryfallId);
      return;
    }
    const targetGroupId = event.over.data.current?.groupId;
    const currentGroupId = event.active.data.current?.groupId;
    if (
      targetType === "group" &&
      typeof targetGroupId === "string" &&
      targetGroupId !== currentGroupId
    ) {
      onMove(scryfallId, targetGroupId);
    }
  };

  const board =
    view === "list" ? (
      <div className="deck-list" aria-label="Deck card list">
        <div className="deck-list__head" aria-hidden="true">
          <span>Qty</span>
          <span>Card</span>
          <span>Type</span>
          <span>Custom group</span>
          <span>Mana</span>
          <span>EUR</span>
          <span>Actions</span>
        </div>
        {groups.map((cardGroup) =>
          cardGroup.entries.length > 0 || dragEnabled ? (
            <DroppableListGroup
              group={cardGroup}
              enabled={dragEnabled}
              key={cardGroup.id}
            >
              <GroupHeader group={cardGroup} onSearch={onSearch} />
              {cardGroup.entries.length > 0 ? (
                cardGroup.entries.map((entry) => (
                  <ListRow
                    entry={entry}
                    groupId={cardGroup.id}
                    customGroups={customGroups}
                    dragEnabled={dragEnabled}
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
                <div className="deck-list__empty-group">Drop cards here</div>
              )}
            </DroppableListGroup>
          ) : null,
        )}
        {dragEnabled ? (
          <AddGroupSlot
            compact
            dropEnabled
            pendingCardId={pendingNewGroupCardId}
            onAdd={onAddCustomGroup}
            onPendingHandled={() => setPendingNewGroupCardId(null)}
          />
        ) : null}
      </div>
    ) : (
      <div className="visual-groups" aria-label="Deck visual groups">
        {groups.map((cardGroup) => (
          <DroppableVisualGroup
            group={cardGroup}
            enabled={dragEnabled}
            key={cardGroup.id}
          >
            <GroupHeader group={cardGroup} onSearch={onSearch} />
            {cardGroup.entries.length > 0 ? (
              <div className="visual-card-grid">
                {cardGroup.entries.map((entry) => (
                  <VisualCard
                    entry={entry}
                    groupId={cardGroup.id}
                    dragEnabled={dragEnabled}
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
                onClick={() =>
                  onSearch(cardGroup.targetGroupId, cardGroup.label)
                }
              >
                <CirclePlus aria-hidden="true" size={18} />
                Add to {cardGroup.label.toLowerCase()}
              </button>
            )}
          </DroppableVisualGroup>
        ))}
        {dragEnabled ? (
          <AddGroupSlot
            dropEnabled
            pendingCardId={pendingNewGroupCardId}
            onAdd={onAddCustomGroup}
            onPendingHandled={() => setPendingNewGroupCardId(null)}
          />
        ) : null}
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
  enabled,
  children,
}: {
  group: CardGroup;
  enabled: boolean;
  children: ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `group:${group.id}`,
    disabled: !enabled,
    data: { type: "group", groupId: group.id },
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
  enabled,
  children,
}: {
  group: CardGroup;
  enabled: boolean;
  children: ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `group:${group.id}`,
    disabled: !enabled,
    data: { type: "group", groupId: group.id },
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
  groupId,
  dragEnabled,
  warning,
  onSelect,
  onSetQuantity,
}: {
  entry: DeckCardEntry;
  groupId: string;
  dragEnabled: boolean;
  warning: ValidationWarning | null;
  onSelect: (card: CardSearchResult) => void;
  onSetQuantity: (scryfallId: string, quantity: number) => void;
}) {
  const card = entry.card.details;
  const { attributes, isDragging, listeners, setNodeRef } = useDraggable({
    id: `card:${entry.card.scryfall_id}`,
    disabled: !dragEnabled,
    data: {
      type: "card",
      scryfallId: entry.card.scryfall_id,
      groupId,
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
        {dragEnabled ? (
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
        ) : (
          <button
            type="button"
            aria-label={`Inspect ${card.name} details`}
            title="Card details"
            onClick={() => onSelect(card)}
          >
            <MoreHorizontal aria-hidden="true" size={15} />
          </button>
        )}
      </div>
    </article>
  );
}

function GroupHeader({
  group,
  onSearch,
}: {
  group: CardGroup;
  onSearch: (targetGroupId?: string, targetLabel?: string) => void;
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
      <span className={`group-marker group-marker--${group.marker}`} />
      <h2>{group.label}</h2>
      <span>{quantity} cards</span>
      <strong>{formatEuro(subtotal, "—")}</strong>
      <button
        className="icon-button icon-button--compact"
        type="button"
        aria-label={`Add card to ${group.label}`}
        title={`Add to ${group.label}`}
        onClick={() => onSearch(group.targetGroupId, group.label)}
      >
        <CirclePlus aria-hidden="true" size={16} />
      </button>
    </header>
  );
}

function AddGroupSlot({
  compact = false,
  dropEnabled,
  pendingCardId,
  onAdd,
  onPendingHandled,
}: {
  compact?: boolean;
  dropEnabled: boolean;
  pendingCardId: string | null;
  onAdd: (name: string, moveScryfallId?: string) => void;
  onPendingHandled: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const editorRef = useRef<HTMLFormElement>(null);
  const { isOver, setNodeRef } = useDroppable({
    id: "new-custom-group",
    disabled: !dropEnabled,
    data: { type: "new-group" },
  });

  useEffect(() => {
    if (pendingCardId) {
      setEditing(true);
    }
  }, [pendingCardId]);

  useEffect(() => {
    if (!editing) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (typeof editor?.scrollIntoView === "function") {
        editor.scrollIntoView({
          block: "nearest",
          inline: "start",
        });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [compact, editing]);

  const cancel = () => {
    setEditing(false);
    setName("");
    onPendingHandled();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      return;
    }
    onAdd(name, pendingCardId ?? undefined);
    cancel();
  };

  if (!editing) {
    return (
      <button
        ref={setNodeRef}
        className={`add-group-slot ${
          compact ? "add-group-slot--compact" : ""
        } ${isOver ? "add-group-slot--over" : ""}`}
        type="button"
        data-drop-target="new-group"
        onClick={() => setEditing(true)}
      >
        <CirclePlus aria-hidden="true" size={19} />
        Add custom group
      </button>
    );
  }

  return (
    <form
      ref={(node) => {
        editorRef.current = node;
        setNodeRef(node);
      }}
      className={`add-group-slot add-group-slot--editing ${
        compact ? "add-group-slot--compact" : ""
      } ${isOver ? "add-group-slot--over" : ""}`}
      data-drop-target="new-group"
      onSubmit={submit}
    >
      <label>
        <span>Group name</span>
        <input
          autoFocus
          value={name}
          maxLength={40}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
        />
      </label>
      <div>
        <button
          className="icon-button icon-button--compact"
          type="submit"
          disabled={!name.trim()}
          aria-label="Create custom group"
          title="Create group"
        >
          <Check aria-hidden="true" size={16} />
        </button>
        <button
          className="icon-button icon-button--compact"
          type="button"
          aria-label="Cancel custom group"
          title="Cancel"
          onClick={cancel}
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>
    </form>
  );
}

function ListRow({
  entry,
  groupId,
  customGroups,
  dragEnabled,
  warning,
  onSelect,
  onSetQuantity,
  onRemove,
}: {
  entry: DeckCardEntry;
  groupId: string;
  customGroups: DeckCustomGroup[];
  dragEnabled: boolean;
  warning: ValidationWarning | null;
  onSelect: (card: CardSearchResult) => void;
  onSetQuantity: (scryfallId: string, quantity: number) => void;
  onRemove: (scryfallId: string) => void;
}) {
  const card = entry.card.details;
  const { attributes, isDragging, listeners, setNodeRef } = useDraggable({
    id: `card:${entry.card.scryfall_id}`,
    disabled: !dragEnabled,
    data: {
      type: "card",
      scryfallId: entry.card.scryfall_id,
      groupId,
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
      <span>{groupName(groupIdForEntry(entry, customGroups), customGroups)}</span>
      <span className="mana-line">{card.mana_cost || "—"}</span>
      <span>{formatEuro(getCardPrice(card) * entry.quantity, "—")}</span>
      <div className="list-actions">
        {dragEnabled ? (
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
        ) : (
          <button
            className="icon-button icon-button--compact"
            type="button"
            aria-label={`Inspect ${card.name} details`}
            title="Card details"
            onClick={() => onSelect(card)}
          >
            <MoreHorizontal aria-hidden="true" size={16} />
          </button>
        )}
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
  customGroups: DeckCustomGroup[],
  groupMode: GroupMode,
  sortMode: SortMode,
): CardGroup[] {
  const sortEntries = (cards: DeckCardEntry[]) =>
    [...cards].sort((left, right) => compareEntries(left, right, sortMode));

  if (groupMode === "custom") {
    const definitions = [
      {
        id: COMMAND_ZONE_GROUP_ID,
        label: "Command zone",
        marker: "command_zone" as const,
      },
      {
        id: UNASSIGNED_GROUP_ID,
        label: "Not assigned",
        marker: "unassigned" as const,
      },
      ...customGroups.map((customGroup) => ({
        id: customGroup.id,
        label: customGroup.name,
        marker: "custom" as const,
      })),
    ];
    return definitions.map((definition) => ({
      ...definition,
      targetGroupId: definition.id,
      entries: sortEntries(
        entries.filter(
          (entry) =>
            groupIdForEntry(entry, customGroups) === definition.id,
        ),
      ),
    }));
  }

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
      id: COMMAND_ZONE_GROUP_ID,
      label: "Command zone",
      marker: "command_zone",
      targetGroupId: COMMAND_ZONE_GROUP_ID,
      entries: sortEntries(
        entries.filter((entry) => entry.section === "command_zone"),
      ),
    },
    ...presentTypes.map((type) => ({
      id: `type-${type}`,
      label: type,
      marker: "type" as const,
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
      getCardPrice(right.card.details as CardSearchResult) -
        getCardPrice(left.card.details as CardSearchResult) ||
      left.card.name.localeCompare(right.card.name)
    );
  }
  return left.card.name.localeCompare(right.card.name);
}
