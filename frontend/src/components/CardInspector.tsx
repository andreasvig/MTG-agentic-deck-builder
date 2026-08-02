import { useEffect, useRef } from "react";

import type {
  CardSearchResult,
  CardTagFilter,
  MagicColor,
} from "../domain/card";
import { Icon } from "./Icon";
import { formatEuro, getCardPrice } from "../domain/card";
import type { DeckSection } from "../domain/deck";
import { isDeckSection, sectionLabel } from "../domain/deck";
import { apiClient, type ApiClient } from "../lib/api";
import { CardArt } from "./CardArt";
import { CardEnrichmentPanel } from "./CardEnrichmentPanel";
import { CardText } from "./CardText";

interface CardInspectorProps {
  card: CardSearchResult | null;
  quantity: number;
  /** The card's placement, or nothing when the deck does not hold it. */
  section?: DeckSection;
  singletonWarning: boolean;
  colorIdentityWarning: boolean;
  commanderColorIdentity: ReadonlySet<MagicColor> | null;
  client?: ApiClient;
  onAdd: (card: CardSearchResult) => void;
  onSetQuantity: (scryfallId: string, quantity: number) => void;
  onMove: (scryfallId: string, section: DeckSection) => void;
  onRemove: (scryfallId: string) => void;
  onOpenCard?: (card: CardSearchResult) => void;
  onSelectTag?: (tag: CardTagFilter) => void;
  onClose: () => void;
}

export function CardInspector({
  card,
  quantity,
  section,
  singletonWarning,
  colorIdentityWarning,
  commanderColorIdentity,
  client = apiClient,
  onAdd,
  onSetQuantity,
  onMove,
  onRemove,
  onOpenCard,
  onSelectTag,
  onClose,
}: CardInspectorProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const isOpen = card !== null;

  useEffect(() => {
    if (!isOpen) {
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
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
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
  }, [isOpen, onClose]);

  if (!card) {
    return null;
  }

  return (
    <div className="card-modal-layer">
      <button
        className="card-modal-backdrop"
        type="button"
        aria-label="Close card inspector"
        onClick={onClose}
      />
      <section
        ref={dialogRef}
        className="card-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Card details"
      >
        <div className="inspector-heading">
          <span>Card details</span>
          <button
            ref={closeButtonRef}
            className="icon-button icon-button--compact"
            type="button"
            aria-label="Close card inspector"
            title="Close"
            onClick={onClose}
          >
            <Icon name="close" aria-hidden="true" size={18} />
          </button>
        </div>

        <div className="card-inspector-content">
          <div className="card-modal__art">
            <CardArt card={card} size="normal" loading="eager" />
          </div>
          <div className="card-modal__details">
            <div className="card-inspector-title">
              <div>
                <h2>{card.name}</h2>
                <span className="mana-line">
                  <CardText text={card.mana_cost} />
                </span>
              </div>
              <a
                className="icon-button icon-button--compact"
                href={card.scryfall_url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${card.name} on Scryfall`}
                title="Open on Scryfall"
              >
                <Icon name="external" aria-hidden="true" size={16} />
              </a>
            </div>
            <p className="type-line">{card.type_line}</p>
            <p className="oracle-text">
              <CardText
                text={
                  card.oracle_text ??
                  card.card_faces
                    .map((face) =>
                      [face.name, face.oracle_text].filter(Boolean).join("\n"),
                    )
                    .join("\n\n")
                }
              />
            </p>
            <CardEnrichmentPanel
              key={card.oracle_id}
              oracleId={card.oracle_id}
              client={client}
              onOpenCard={onOpenCard}
              onSelectTag={onSelectTag}
            />

            {singletonWarning ? (
              <div className="singleton-warning" role="status">
                <Icon name="warning" aria-hidden="true" size={16} />
                Commander is a singleton format. This oracle card appears more
                than once.
              </div>
            ) : null}

            {colorIdentityWarning ? (
              <div className="singleton-warning" role="status">
                <Icon name="warning" aria-hidden="true" size={16} />
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
                      <Icon name="minus" aria-hidden="true" size={15} />
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
                      <Icon name="plus" aria-hidden="true" size={15} />
                    </button>
                  </div>
                </div>
                {/*
                  Unconditional, and the only control that can make a card the commander.
                  It used to be shown only while the board grouped by custom group, which
                  left card-type grouping — the default, and now the only mode — with no way
                  to fill the command zone except a drag.
                */}
                <label>
                  Placement
                  <select
                    value={section ?? "mainboard"}
                    aria-label={`Move ${card.name} to another part of the deck`}
                    onChange={(event) => {
                      if (isDeckSection(event.target.value)) {
                        onMove(card.scryfall_id, event.target.value);
                      }
                    }}
                  >
                    <option value="command_zone">
                      {sectionLabel("command_zone")}
                    </option>
                    <option value="mainboard">
                      {sectionLabel("mainboard")}
                    </option>
                  </select>
                </label>
                <button
                  className="remove-button"
                  type="button"
                  onClick={() => onRemove(card.scryfall_id)}
                >
                  <Icon name="trash" aria-hidden="true" size={16} />
                  Remove from deck
                </button>
              </div>
            ) : (
              <button
                className="primary-button inspector-add"
                type="button"
                onClick={() => onAdd(card)}
              >
                <Icon name="plus" aria-hidden="true" size={16} />
                Add to deck
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
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
