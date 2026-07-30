import { Trash2, X } from "lucide-react";
import { useEffect, useRef } from "react";

interface DeleteDeckDialogProps {
  deckName: string;
  cardCount: number;
  isOnlyDeck: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteDeckDialog({
  deckName,
  cardCount,
  isOnlyDeck,
  onCancel,
  onConfirm,
}: DeleteDeckDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancelButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
  }, [onCancel]);

  return (
    <div className="confirmation-modal-layer">
      <button
        className="confirmation-modal-backdrop"
        type="button"
        aria-label="Cancel deck deletion"
        onClick={onCancel}
      />
      <section
        ref={dialogRef}
        className="confirmation-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-deck-title"
        aria-describedby="delete-deck-description"
      >
        <button
          className="icon-button icon-button--compact confirmation-modal__close"
          type="button"
          aria-label="Cancel deck deletion"
          title="Close"
          onClick={onCancel}
        >
          <X aria-hidden="true" size={18} />
        </button>
        <span className="confirmation-modal__icon" aria-hidden="true">
          <Trash2 size={22} />
        </span>
        <h2 id="delete-deck-title">Delete {deckName}?</h2>
        <p id="delete-deck-description">
          This removes the locally saved deck and its {cardCount}{" "}
          {cardCount === 1 ? "card" : "cards"}.
          {isOnlyDeck
            ? " A new empty deck will be created so the editor stays usable."
            : ""}
        </p>
        <p className="confirmation-modal__recovery">
          You can restore it during this session.
        </p>
        <div className="confirmation-modal__actions">
          <button
            ref={cancelButtonRef}
            className="secondary-button"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="danger-button"
            type="button"
            onClick={onConfirm}
          >
            <Trash2 aria-hidden="true" size={16} />
            Delete deck
          </button>
        </div>
      </section>
    </div>
  );
}
