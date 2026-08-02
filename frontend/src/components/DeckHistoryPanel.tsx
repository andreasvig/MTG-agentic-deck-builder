import { useEffect, useRef } from "react";

import { Icon } from "./Icon";
import type { DeckHistoryEntry } from "../domain/history";
import { describeDeckCardChange } from "../domain/history";

/**
 * The deck's recorded past, and a way to stand anywhere in it.
 *
 * Every row is one recorded edit — one diff — newest first, and clicking one moves the deck
 * to just after it. Rows below the current position are edits the deck has, rows above it are
 * edits it has stepped back past and can step into again. That is the whole model: the log is
 * the past, and where the deck stands in it is a cursor rather than a length.
 *
 * The deck is not asked whether a jump is possible: `useDeck` plans the replay and refuses
 * whole if any edit on the path cannot be replayed, announcing why. Offering only the rows
 * that would succeed would mean planning every jump on every render.
 */
export function DeckHistoryPanel({
  edits,
  appliedEditId,
  onJump,
  onClose,
}: {
  /** Oldest first, as the log stores them, each carrying who made it. */
  edits: DeckHistoryEntry[];
  /** The edit the deck currently stands on, or `null` for before all of them. */
  appliedEditId: string | null;
  onJump: (editId: string | null) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !panelRef.current?.contains(target) &&
        // The trigger toggles the panel itself. Closing here as well would reopen it on
        // the same click, which reads as the button doing nothing.
        !(target instanceof Element && target.closest(".history-button"))
      ) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  // Newest first, because a question about the deck's past is almost always about the
  // recent past. The stored order is the order travel walks, so it is reversed here and
  // nowhere else.
  const rows = [...edits].reverse();

  return (
    <div className="history-panel" ref={panelRef} aria-label="Recorded deck history">
      <header>
        <Icon name="history" aria-hidden="true" size={15} />
        <h2>History</h2>
        <button
          className="icon-button icon-button--compact"
          ref={closeRef}
          type="button"
          aria-label="Close deck history"
          onClick={onClose}
        >
          <Icon name="close" aria-hidden="true" size={15} />
        </button>
      </header>

      {rows.length === 0 ? (
        <p className="history-panel__empty">
          Nothing recorded yet. Every change you or the agent makes lands here.
        </p>
      ) : (
        <ol className="history-panel__list">
          {rows.map((held) => (
            <HistoryRow
              held={held}
              current={held.entry.id === appliedEditId}
              key={held.entry.id}
              onJump={onJump}
            />
          ))}
          <li
            className={`history-row ${
              appliedEditId === null ? "history-row--current" : ""
            }`}
          >
            <button
              type="button"
              aria-current={appliedEditId === null ? "true" : undefined}
              onClick={() => onJump(null)}
            >
              <span className="history-row__head">
                <strong>Before any edits</strong>
                {appliedEditId === null ? (
                  <Icon name="check"
                    aria-label="The deck stands here"
                    className="history-row__here"
                    size={14}
                  />
                ) : null}
              </span>
              <span className="history-row__lines">
                The deck as it was when recording started.
              </span>
            </button>
          </li>
        </ol>
      )}
    </div>
  );
}

function HistoryRow({
  held,
  current,
  onJump,
}: {
  held: DeckHistoryEntry;
  current: boolean;
  onJump: (editId: string | null) => void;
}) {
  const { entry, actor } = held;
  return (
    <li className={`history-row ${current ? "history-row--current" : ""}`}>
      <button
        type="button"
        aria-current={current ? "true" : undefined}
        onClick={() => onJump(entry.id)}
      >
        <span className="history-row__head">
          <strong>{actor === "agent" ? "Agent" : "You"}</strong>
          <time dateTime={entry.at}>{clockFace(entry.at)}</time>
          {current ? (
            <Icon name="check"
              aria-label="The deck stands here"
              className="history-row__here"
              size={14}
            />
          ) : null}
        </span>
        {entry.reason ? (
          <span className="history-row__reason">{entry.reason}</span>
        ) : null}
        <span className="history-row__lines">{describeEntry(entry)}</span>
      </button>
    </li>
  );
}

/**
 * Everything one entry changed, in one line and from one source.
 *
 * Composed rather than concatenated from two: the stored `summary` already carries the
 * rename, so rendering the summary *and* a rename line printed "renamed to Ramp Lab"
 * twice. The summary stays as the last resort, for a legacy entry whose only changes were
 * to something this build no longer models.
 */
function describeEntry(entry: DeckHistoryEntry["entry"]): string {
  const parts = [
    ...entry.cards.map(describeDeckCardChange),
    ...(entry.name ? [`renamed to ${entry.name.after}`] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : entry.summary;
}

/**
 * The clock face the edit was made at, dated only when it was not today.
 *
 * A bare `14:02` that silently means last Tuesday is worse than no time at all — the same
 * rule `read_history` follows for the agent, for the same reason.
 */
function clockFace(at: string): string {
  const stamp = new Date(at);
  if (Number.isNaN(stamp.getTime())) {
    return at;
  }
  const time = stamp.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const today = new Date();
  return stamp.toDateString() === today.toDateString()
    ? time
    : `${stamp.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
