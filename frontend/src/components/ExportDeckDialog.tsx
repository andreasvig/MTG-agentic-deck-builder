import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "./Icon";
import type { Deck } from "../domain/deck";
import type { DeckExportFormat } from "../domain/export";
import {
  DECK_EXPORT_FORMATS,
  deckExportFilename,
  describeDeckExportFormat,
  exportDeck,
  tcgplayerMassEntryUrl,
} from "../domain/export";

/**
 * Where a plain list goes on Cardmarket. Their import is behind a login, so there is no
 * cart link to give — the honest thing is to say which page takes the paste. This is their
 * own documentation of the accepted line shape, and it agrees with what `text` writes.
 */
const CARDMARKET_HELP =
  "https://help.cardmarket.com/en/how-to-add-a-mtg-decklist-to-wants";

interface ExportDeckDialogProps {
  deck: Deck;
  onClose: () => void;
}

export function ExportDeckDialog({ deck, onClose }: ExportDeckDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLTextAreaElement>(null);
  const [format, setFormat] = useState<DeckExportFormat>("text");
  const [copied, setCopied] = useState(false);

  const descriptor = describeDeckExportFormat(format);
  const content = useMemo(() => exportDeck(deck, format), [deck, format]);
  const cartUrl = useMemo(() => tcgplayerMassEntryUrl(deck), [deck]);
  const cardCount = deck.cards.reduce(
    (total, entry) => total + entry.quantity,
    0,
  );

  // A "Copied" label that outlives the click it describes is a lie about the clipboard's
  // current contents, so switching format clears it as well as the timer does.
  useEffect(() => {
    setCopied(false);
  }, [format]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
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
        'button:not([disabled]), a[href], textarea, [tabindex]:not([tabindex="-1"])',
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
  }, [onClose]);

  /**
   * Copy, or leave the list selected so the keyboard can finish the job.
   *
   * `navigator.clipboard` is absent outside a secure context and can be refused by
   * permission even inside one. Neither is an error worth a dialog: the text is already on
   * screen, so the fallback is to select it and let Ctrl+C do what the button could not.
   */
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
    } catch {
      previewRef.current?.select();
    }
  };

  const download = () => {
    const blob = new Blob([content], {
      type: `${descriptor.mimeType};charset=utf-8`,
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = deckExportFilename(deck, format);
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="confirmation-modal-layer">
      <button
        className="confirmation-modal-backdrop"
        type="button"
        aria-label="Close export"
        onClick={onClose}
      />
      <section
        ref={dialogRef}
        className="confirmation-modal export-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-deck-title"
      >
        <button
          ref={closeButtonRef}
          className="icon-button icon-button--compact confirmation-modal__close"
          type="button"
          aria-label="Close export"
          title="Close"
          onClick={onClose}
        >
          <Icon name="close" aria-hidden="true" size={18} />
        </button>
        <h2 id="export-deck-title">Export {deck.name}</h2>
        <p>
          {cardCount} {cardCount === 1 ? "card" : "cards"}. Paste the list into a
          shop or a deck site, or take the file.
        </p>

        <div
          className="segmented-control export-modal__formats"
          aria-label="Export format"
        >
          {DECK_EXPORT_FORMATS.map((entry) => (
            <button
              key={entry.id}
              className={format === entry.id ? "is-active" : ""}
              type="button"
              aria-pressed={format === entry.id}
              onClick={() => setFormat(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <p className="export-modal__destinations">{descriptor.destinations}</p>

        <textarea
          ref={previewRef}
          className="export-modal__preview"
          rows={12}
          readOnly
          spellCheck={false}
          aria-label={`${descriptor.label} export`}
          value={content}
          onFocus={(event) => event.currentTarget.select()}
        />

        <div className="export-modal__buy">
          {cartUrl ? (
            <a
              className="secondary-button"
              href={cartUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              <Icon name="external" aria-hidden="true" size={14} />
              Buy on TCGplayer
            </a>
          ) : null}
          <small>
            On Cardmarket, paste the plain-text list into{" "}
            <a href={CARDMARKET_HELP} target="_blank" rel="noreferrer noopener">
              Wants → add a decklist
            </a>
            .
          </small>
        </div>

        <div className="confirmation-modal__actions">
          <button
            className="secondary-button"
            type="button"
            disabled={content.length === 0}
            onClick={download}
          >
            <Icon name="download" aria-hidden="true" size={15} />
            Download .{descriptor.extension}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={content.length === 0}
            onClick={copy}
          >
            <Icon
              name={copied ? "check" : "copy"}
              aria-hidden="true"
              size={15}
            />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {/* Announced rather than only drawn: the label change is the whole feedback. */}
        <span className="sr-only" role="status">
          {copied ? "Deck list copied to the clipboard." : ""}
        </span>
      </section>
    </div>
  );
}
