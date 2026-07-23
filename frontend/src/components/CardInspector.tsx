import {
  AlertTriangle,
  ExternalLink,
  Minus,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";

import type { BackendHealthState } from "../hooks/useBackendHealth";
import type { CardSearchResult, MagicColor } from "../domain/card";
import { formatEuro, getCardPrice } from "../domain/card";
import type { DeckCustomGroup } from "../domain/deck";
import {
  COMMAND_ZONE_GROUP_ID,
  UNASSIGNED_GROUP_ID,
} from "../domain/deck";
import { CardArt } from "./CardArt";
import { ConnectionStatus } from "./ConnectionStatus";

interface CardInspectorProps {
  card: CardSearchResult | null;
  quantity: number;
  groupId?: string;
  customGroups: DeckCustomGroup[];
  showCustomGroupControl: boolean;
  singletonWarning: boolean;
  colorIdentityWarning: boolean;
  commanderColorIdentity: ReadonlySet<MagicColor> | null;
  isMobile: boolean;
  health: BackendHealthState;
  onCheckHealth: () => void;
  onAdd: (card: CardSearchResult) => void;
  onSetQuantity: (scryfallId: string, quantity: number) => void;
  onMove: (scryfallId: string, groupId: string) => void;
  onRemove: (scryfallId: string) => void;
  onClose: () => void;
}

export function CardInspector({
  card,
  quantity,
  groupId,
  customGroups,
  showCustomGroupControl,
  singletonWarning,
  colorIdentityWarning,
  commanderColorIdentity,
  isMobile,
  health,
  onCheckHealth,
  onAdd,
  onSetQuantity,
  onMove,
  onRemove,
  onClose,
}: CardInspectorProps) {
  const inspectorRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isMobile || !card) {
      return;
    }
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = inspectorRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      window.setTimeout(() => previousFocus?.focus(), 0);
    };
  }, [card, isMobile, onClose]);

  return (
    <>
      {isMobile && card ? (
        <button
          className="inspector-backdrop"
          type="button"
          aria-label="Close card inspector"
          onClick={onClose}
        />
      ) : null}
      <aside
        ref={inspectorRef}
        className={`inspector ${isMobile && card ? "inspector--open" : ""}`}
        aria-label="Card inspector"
        role={isMobile && card ? "dialog" : undefined}
        aria-modal={isMobile && card ? true : undefined}
        aria-hidden={isMobile && !card ? true : undefined}
        inert={isMobile && !card ? true : undefined}
      >
        <div className="inspector-heading">
          <span>{card ? "Card details" : "Deck inspector"}</span>
          {card ? (
            <button
              ref={closeButtonRef}
              className="icon-button icon-button--compact"
              type="button"
              aria-label="Close card inspector"
              title="Close"
              onClick={onClose}
            >
              <X aria-hidden="true" size={18} />
            </button>
          ) : null}
        </div>

        {card ? (
          <div className="card-inspector-content">
            <CardArt card={card} size="normal" loading="eager" />
            <div className="card-inspector-title">
              <div>
                <h2>{card.name}</h2>
                <span className="mana-line">{card.mana_cost}</span>
              </div>
              <a
                className="icon-button icon-button--compact"
                href={card.scryfall_url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${card.name} on Scryfall`}
                title="Open on Scryfall"
              >
                <ExternalLink aria-hidden="true" size={16} />
              </a>
            </div>
            <p className="type-line">{card.type_line}</p>
            <p className="oracle-text">
              {card.oracle_text ??
                card.card_faces
                  .map((face) =>
                    [face.name, face.oracle_text].filter(Boolean).join("\n"),
                  )
                  .join("\n\n")}
            </p>

            {singletonWarning ? (
              <div className="singleton-warning" role="status">
                <AlertTriangle aria-hidden="true" size={16} />
                Commander is a singleton format. This oracle card appears more
                than once.
              </div>
            ) : null}

            {colorIdentityWarning ? (
              <div className="singleton-warning" role="status">
                <AlertTriangle aria-hidden="true" size={16} />
                {formatColorIdentity(card.color_identity)} is outside this
                deck's {formatColorIdentity(commanderColorIdentity)} commander
                color identity.
              </div>
            ) : null}

            <dl className="printing-details printing-details--inspector">
              <div>
                <dt>Set</dt>
                <dd>
                  {card.set_name} ({card.set_code.toUpperCase()}) #
                  {card.collector_number}
                </dd>
              </div>
              <div>
                <dt>Rarity</dt>
                <dd>{card.rarity}</dd>
              </div>
              <div>
                <dt>Commander</dt>
                <dd>{formatLegality(card.legalities.commander)}</dd>
              </div>
              <div>
                <dt>Finish</dt>
                <dd>{card.finishes.join(", ")}</dd>
              </div>
              <div>
                <dt>Daily EUR estimate</dt>
                <dd>{formatEuro(getCardPrice(card))}</dd>
              </div>
            </dl>

            {quantity > 0 ? (
              <div className="inspector-editor">
                <div>
                  <label htmlFor="inspector-quantity">Quantity</label>
                  <div className="quantity-control">
                    <button
                      type="button"
                      aria-label={`Decrease ${card.name} quantity`}
                      onClick={() =>
                        onSetQuantity(card.scryfall_id, quantity - 1)
                      }
                    >
                      <Minus aria-hidden="true" size={15} />
                    </button>
                    <input
                      id="inspector-quantity"
                      type="number"
                      min={1}
                      value={quantity}
                      onChange={(event) =>
                        onSetQuantity(
                          card.scryfall_id,
                          Number(event.target.value),
                        )
                      }
                    />
                    <button
                      type="button"
                      aria-label={`Increase ${card.name} quantity`}
                      onClick={() =>
                        onSetQuantity(card.scryfall_id, quantity + 1)
                      }
                    >
                      <Plus aria-hidden="true" size={15} />
                    </button>
                  </div>
                </div>
                {showCustomGroupControl ? (
                  <label>
                    Custom group
                    <select
                      value={groupId ?? UNASSIGNED_GROUP_ID}
                      aria-label={`Move ${card.name} to custom group`}
                      onChange={(event) =>
                        onMove(card.scryfall_id, event.target.value)
                      }
                    >
                      <option value={COMMAND_ZONE_GROUP_ID}>
                        Command zone
                      </option>
                      <option value={UNASSIGNED_GROUP_ID}>
                        Not assigned
                      </option>
                      {customGroups.map((customGroup) => (
                        <option value={customGroup.id} key={customGroup.id}>
                          {customGroup.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <button
                  className="remove-button"
                  type="button"
                  onClick={() => onRemove(card.scryfall_id)}
                >
                  <Trash2 aria-hidden="true" size={16} />
                  Remove from deck
                </button>
              </div>
            ) : (
              <button
                className="primary-button inspector-add"
                type="button"
                onClick={() => onAdd(card)}
              >
                <Plus aria-hidden="true" size={16} />
                Add to deck
              </button>
            )}
          </div>
        ) : (
          <div className="inspector-empty">
            <h2>Select a card</h2>
            <p>
              Card text, printing details, price, quantity and custom group
              controls appear here.
            </p>
          </div>
        )}

        <ConnectionStatus health={health} onRefresh={onCheckHealth} />
      </aside>
    </>
  );
}

function formatLegality(value: string | undefined): string {
  if (!value) {
    return "Unknown";
  }
  return value.replaceAll("_", " ").replace(/^./, (letter) =>
    letter.toUpperCase(),
  );
}

function formatColorIdentity(
  colors: Iterable<MagicColor> | null,
): string {
  if (colors === null) {
    return "unknown";
  }
  const formatted = [...colors].join("");
  return formatted || "colorless";
}
