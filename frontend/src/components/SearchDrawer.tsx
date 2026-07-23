import {
  AlertCircle,
  ChevronRight,
  CirclePlus,
  Minus,
  Plus,
  RotateCw,
  Search,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { CardSearchPage, CardSearchResult } from "../domain/card";
import { formatEuro, getCardPrice } from "../domain/card";
import type { DeckCardEntry, DeckCategory } from "../domain/deck";
import { categoryLabels } from "../domain/deck";
import { apiClient, type ApiClient } from "../lib/api";
import { CardArt } from "./CardArt";

type SearchState =
  | { phase: "idle"; page: null }
  | { phase: "loading"; page: CardSearchPage | null }
  | { phase: "success"; page: CardSearchPage }
  | { phase: "error"; page: CardSearchPage | null; message: string };

interface SearchDrawerProps {
  initialQuery?: string;
  target?: DeckCategory;
  entries: DeckCardEntry[];
  client?: ApiClient;
  onAdd: (card: CardSearchResult, target?: DeckCategory) => void;
  onSetQuantity: (scryfallId: string, quantity: number) => void;
  onClose: () => void;
}

export function SearchDrawer({
  initialQuery = "",
  target,
  entries,
  client = apiClient,
  onAdd,
  onSetQuantity,
  onClose,
}: SearchDrawerProps) {
  const [query, setQuery] = useState(initialQuery);
  const [state, setState] = useState<SearchState>({
    phase: "idle",
    page: null,
  });
  const [selected, setSelected] = useState<CardSearchResult | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const debounceSkipped = useRef(false);

  const runSearch = useCallback(
    async (searchQuery: string, page = 1, append = false) => {
      const normalized = searchQuery.trim();
      if (!normalized) {
        setState({ phase: "idle", page: null });
        setSelected(null);
        return;
      }
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      setState((current) => ({
        phase: "loading",
        page: append ? current.page : null,
      }));
      try {
        const result = await client.searchCards(
          normalized,
          page,
          controller.signal,
        );
        if (activeRequest.current !== controller) {
          return;
        }
        setState((current) => {
          if (
            append &&
            current.page &&
            current.page.query === result.query
          ) {
            return {
              phase: "success",
              page: {
                ...result,
                cards: [...current.page.cards, ...result.cards],
              },
            };
          }
          return { phase: "success", page: result };
        });
        setSelected((current) =>
          append ? (current ?? result.cards[0] ?? null) : (result.cards[0] ?? null),
        );
      } catch (error) {
        if (activeRequest.current !== controller) {
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setState((current) => ({
          phase: "error",
          page: current.page,
          message:
            error instanceof Error
              ? error.message
              : "Card search is temporarily unavailable.",
        }));
      }
    },
    [client],
  );

  useEffect(() => {
    inputRef.current?.focus();
    if (initialQuery.trim()) {
      debounceSkipped.current = true;
      void runSearch(initialQuery);
    }
    return () => activeRequest.current?.abort();
  }, [initialQuery, runSearch]);

  useEffect(() => {
    if (debounceSkipped.current) {
      debounceSkipped.current = false;
      return;
    }
    if (!query.trim()) {
      setState({ phase: "idle", page: null });
      setSelected(null);
      return;
    }
    const timer = window.setTimeout(() => void runSearch(query), 420);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

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
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) {
        event.preventDefault();
        dialogRef.current?.focus();
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
    };
  }, [onClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    debounceSkipped.current = true;
    void runSearch(query);
  };

  const cards = state.page?.cards ?? [];

  return (
    <div className="drawer-layer">
      <button
        className="drawer-backdrop"
        type="button"
        aria-label="Close card search"
        onClick={onClose}
      />
      <section
        ref={dialogRef}
        className="search-drawer"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="search-title"
      >
        <header className="search-drawer__header">
          <div>
            <p className="eyebrow">
              {target ? `Adding to ${categoryLabels[target]}` : "Card search"}
            </p>
            <h2 id="search-title">Find cards</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close card search"
            title="Close"
            onClick={onClose}
          >
            <X aria-hidden="true" size={20} />
          </button>
        </header>

        <form className="search-form" role="search" onSubmit={submit}>
          <Search aria-hidden="true" size={19} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search card name or Scryfall syntax"
            placeholder='Card name or Scryfall syntax, e.g. type:land color:g'
            autoComplete="off"
          />
          {query ? (
            <button
              className="icon-button"
              type="button"
              aria-label="Clear card search"
              title="Clear"
              onClick={() => setQuery("")}
            >
              <X aria-hidden="true" size={17} />
            </button>
          ) : null}
          <button className="primary-button search-submit" type="submit">
            Search
          </button>
        </form>

        <div className="search-drawer__body">
          <div className="search-results" aria-live="polite" aria-busy={state.phase === "loading"}>
            {state.phase === "idle" ? (
              <div className="search-state">
                <Search aria-hidden="true" size={26} />
                <h3>Search Magic cards</h3>
                <p>
                  Use a card name or Scryfall filters. Adding a card keeps this
                  drawer open.
                </p>
              </div>
            ) : null}

            {state.phase === "loading" && cards.length === 0 ? (
              <div className="search-skeletons" aria-label="Searching cards">
                {Array.from({ length: 8 }, (_, index) => (
                  <span className="search-skeleton" key={index} />
                ))}
              </div>
            ) : null}

            {state.phase === "error" && cards.length === 0 ? (
              <div className="search-state search-state--error" role="alert">
                <AlertCircle aria-hidden="true" size={26} />
                <h3>Search could not finish</h3>
                <p>{state.message}</p>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void runSearch(query)}
                >
                  <RotateCw aria-hidden="true" size={16} />
                  Try again
                </button>
              </div>
            ) : null}

            {state.phase === "success" && cards.length === 0 ? (
              <div className="search-state">
                <Search aria-hidden="true" size={26} />
                <h3>No cards found</h3>
                <p>Try a broader name or remove one of the search filters.</p>
              </div>
            ) : null}

            {cards.length > 0 ? (
              <>
                <div className="search-results__meta">
                  <span>{state.page?.total_results.toLocaleString()} results</span>
                  {state.phase === "loading" ? <span>Loading more…</span> : null}
                </div>
                <div className="search-card-grid">
                  {cards.map((card) => {
                    const exactEntry = entries.find(
                      (entry) => entry.card.scryfall_id === card.scryfall_id,
                    );
                    const differentPrinting = entries.some(
                      (entry) =>
                        entry.card.oracle_id === card.oracle_id &&
                        entry.card.scryfall_id !== card.scryfall_id,
                    );
                    const quantity = exactEntry?.quantity ?? 0;
                    return (
                      <article
                        className={`search-card ${selected?.scryfall_id === card.scryfall_id ? "is-selected" : ""}`}
                        key={card.scryfall_id}
                      >
                        <button
                          className="search-card__preview"
                          type="button"
                          aria-label={`Preview ${card.name}, ${card.set_name} printing`}
                          onClick={() => setSelected(card)}
                        >
                          <CardArt card={card} size="small" />
                        </button>
                        <div className="search-card__content">
                          <button
                            className="search-card__name"
                            type="button"
                            onClick={() => setSelected(card)}
                          >
                            <strong>{card.name}</strong>
                            <ChevronRight aria-hidden="true" size={15} />
                          </button>
                          <span className="mana-line">{card.mana_cost || "No mana cost"}</span>
                          <span className="type-line">{card.type_line}</span>
                          <span className="printing-line">
                            {card.set_code.toUpperCase()} #{card.collector_number}
                            {" · "}
                            {card.rarity}
                          </span>
                          <div className="search-card__footer">
                            <strong>{formatEuro(getCardPrice(card))}</strong>
                            {quantity > 0 ? (
                              <div
                                className="quantity-control quantity-control--compact"
                                aria-label={`${card.name} quantity in deck`}
                              >
                                <button
                                  type="button"
                                  aria-label={`Decrease ${card.name} quantity`}
                                  onClick={() =>
                                    onSetQuantity(card.scryfall_id, quantity - 1)
                                  }
                                >
                                  <Minus aria-hidden="true" size={14} />
                                </button>
                                <output aria-label={`${quantity} in deck`}>
                                  {quantity}
                                </output>
                                <button
                                  type="button"
                                  aria-label={`Increase ${card.name} quantity`}
                                  onClick={() =>
                                    onSetQuantity(card.scryfall_id, quantity + 1)
                                  }
                                >
                                  <Plus aria-hidden="true" size={14} />
                                </button>
                              </div>
                            ) : (
                              <button
                                className="add-printing-button"
                                type="button"
                                aria-label={`Add ${card.name} to deck`}
                                onClick={() => onAdd(card, target)}
                              >
                                <CirclePlus aria-hidden="true" size={16} />
                                Add
                              </button>
                            )}
                          </div>
                          {differentPrinting ? (
                            <span className="printing-notice">
                              Different printing already in deck
                            </span>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
                {state.page?.has_more ? (
                  <button
                    className="secondary-button load-more"
                    type="button"
                    disabled={state.phase === "loading"}
                    onClick={() =>
                      void runSearch(query, (state.page?.page ?? 1) + 1, true)
                    }
                  >
                    {state.phase === "loading" ? "Loading…" : "Load more"}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>

          <aside className="search-preview" aria-label="Search card preview">
            {selected ? (
              <>
                <CardArt card={selected} size="normal" loading="eager" />
                <div>
                  <h3>{selected.name}</h3>
                  <p className="type-line">{selected.type_line}</p>
                  <p className="oracle-text">
                    {selected.oracle_text ??
                      selected.card_faces
                        .map((face) => face.oracle_text)
                        .filter(Boolean)
                        .join("\n\n")}
                  </p>
                  <dl className="printing-details">
                    <div>
                      <dt>Printing</dt>
                      <dd>
                        {selected.set_name} #{selected.collector_number}
                      </dd>
                    </div>
                    <div>
                      <dt>Finish</dt>
                      <dd>{selected.finishes.join(", ")}</dd>
                    </div>
                    <div>
                      <dt>EUR estimate</dt>
                      <dd>{formatEuro(getCardPrice(selected))}</dd>
                    </div>
                  </dl>
                </div>
              </>
            ) : (
              <div className="search-preview__empty">
                Select a result to inspect its printing.
              </div>
            )}
          </aside>
        </div>
      </section>
    </div>
  );
}
