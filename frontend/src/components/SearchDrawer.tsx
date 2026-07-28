import {
  AlertCircle,
  Bug,
  ChevronRight,
  CirclePlus,
  Minus,
  Plus,
  RotateCw,
  Search,
  Settings2,
  Sparkles,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  CardSearchFilters,
  CardSearchPage,
  CardSearchResult,
  MagicColor,
} from "../domain/card";
import {
  EMPTY_CARD_SEARCH_FILTERS,
  formatEuro,
  getCardPrice,
} from "../domain/card";
import type { DeckCardEntry } from "../domain/deck";
import {
  COMMAND_ZONE_GROUP_ID,
  getCommanderColorIdentity,
  isWithinCommanderColorIdentity,
} from "../domain/deck";
import { apiClient, type ApiClient } from "../lib/api";
import { CardArt } from "./CardArt";
import { SearchTracePanel } from "./SearchTracePanel";

type SearchState =
  | { phase: "idle"; page: null }
  | { phase: "loading"; page: CardSearchPage | null }
  | { phase: "agentic"; page: CardSearchPage }
  | { phase: "success"; page: CardSearchPage }
  | { phase: "error"; page: CardSearchPage | null; message: string };

const COLOR_FILTERS: Array<{ color: MagicColor; label: string }> = [
  { color: "W", label: "White" },
  { color: "U", label: "Blue" },
  { color: "B", label: "Black" },
  { color: "R", label: "Red" },
  { color: "G", label: "Green" },
];
const SEARCH_DEBUG_STORAGE_KEY = "manabase.search-debug";

interface SearchDrawerProps {
  initialQuery?: string;
  targetGroupId?: string;
  targetLabel?: string;
  entries: DeckCardEntry[];
  client?: ApiClient;
  onAdd: (card: CardSearchResult, targetGroupId?: string) => void;
  onSetQuantity: (scryfallId: string, quantity: number) => void;
  onClose: () => void;
}

export function SearchDrawer({
  initialQuery = "",
  targetGroupId,
  targetLabel,
  entries,
  client = apiClient,
  onAdd,
  onSetQuantity,
  onClose,
}: SearchDrawerProps) {
  const [query, setQuery] = useState(initialQuery);
  const [filters, setFilters] = useState<CardSearchFilters>(() => ({
    ...EMPTY_CARD_SEARCH_FILTERS,
    colors: [],
  }));
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(
    () => window.localStorage.getItem(SEARCH_DEBUG_STORAGE_KEY) === "true",
  );
  const [state, setState] = useState<SearchState>({
    phase: "idle",
    page: null,
  });
  const [selected, setSelected] = useState<CardSearchResult | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const stateRef = useRef<SearchState>(state);
  stateRef.current = state;
  const debounceSkipped = useRef(false);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const debugEnabledRef = useRef(debugEnabled);
  debugEnabledRef.current = debugEnabled;
  const commanderColorIdentity = useMemo(
    () => getCommanderColorIdentity(entries),
    [entries],
  );

  const runSearch = useCallback(
    async (
      searchQuery: string,
      page = 1,
      append = false,
    ) => {
      const normalized = searchQuery.trim();
      if (!normalized) {
        setState({ phase: "idle", page: null });
        setSelected(null);
        return;
      }
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      const existingPage = stateRef.current.page;
      let retainedPage = append ? existingPage : null;
      setState((current) => ({
        phase: "loading",
        page: append ? current.page : null,
      }));
      try {
        const storedAgentSession =
          append &&
          existingPage?.strategy === "agentic" &&
          existingPage.search_session_id
            ? existingPage.search_session_id
            : null;
        const result = storedAgentSession
          ? await client.searchCardsAgentic?.(
              normalized,
              page,
              controller.signal,
              filtersRef.current,
              debugEnabledRef.current,
              storedAgentSession,
            )
          : await client.searchCards(
              normalized,
              page,
              controller.signal,
              filtersRef.current,
              debugEnabledRef.current,
            );
        if (!result) {
          throw new Error("Agentic card search is not available.");
        }
        if (activeRequest.current !== controller) {
          return;
        }
        if (result.agentic_required && page === 1 && !append) {
          retainedPage = result;
          const nextState: SearchState = { phase: "agentic", page: result };
          stateRef.current = nextState;
          setState(nextState);
          setSelected(result.cards[0] ?? null);
          if (!client.searchCardsAgentic) {
            throw new Error("Agentic card search is not available.");
          }
          const agentResult = await client.searchCardsAgentic(
            normalized,
            1,
            controller.signal,
            filtersRef.current,
            debugEnabledRef.current,
          );
          if (activeRequest.current !== controller) {
            return;
          }
          setState({ phase: "success", page: agentResult });
          setSelected(agentResult.cards[0] ?? result.cards[0] ?? null);
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
                debug: result.debug ?? current.page.debug,
                name_match_scores: {
                  ...current.page.name_match_scores,
                  ...result.name_match_scores,
                },
                title_confidence_scores: {
                  ...current.page.title_confidence_scores,
                  ...result.title_confidence_scores,
                },
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
          page: retainedPage ?? current.page,
          message:
            error instanceof Error
              ? error.message
              : "Card search is temporarily unavailable.",
        }));
      }
    },
    [client],
  );
  const filterSignature = JSON.stringify(filters);

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
      activeRequest.current?.abort();
      activeRequest.current = null;
      setState({ phase: "idle", page: null });
      setSelected(null);
      return;
    }
    const timer = window.setTimeout(() => void runSearch(query), 420);
    return () => window.clearTimeout(timer);
  }, [query, filterSignature, runSearch]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (settingsOpen) {
          setSettingsOpen(false);
          return;
        }
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
  }, [onClose, settingsOpen]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void runSearch(query);
  };

  const cards = state.page?.cards ?? [];
  const activeFilterCount =
    filters.colors.length +
    Number(filters.includeColorless) +
    [
      filters.manaValueMin,
      filters.manaValueMax,
      filters.priceEurMin,
      filters.priceEurMax,
    ].filter((value) => value !== null).length;

  const toggleColor = (color: MagicColor) => {
    setFilters((current) => ({
      ...current,
      colors: current.colors.includes(color)
        ? current.colors.filter((candidate) => candidate !== color)
        : [...current.colors, color],
    }));
  };

  const setNumberFilter = (
    key:
      | "manaValueMin"
      | "manaValueMax"
      | "priceEurMin"
      | "priceEurMax",
    value: string,
  ) => {
    const parsed = value === "" ? null : Number(value);
    setFilters((current) => ({
      ...current,
      [key]: parsed !== null && Number.isFinite(parsed) ? parsed : null,
    }));
  };

  const resetFilters = () =>
    setFilters({ ...EMPTY_CARD_SEARCH_FILTERS, colors: [] });

  const toggleDebug = (enabled: boolean) => {
    debugEnabledRef.current = enabled;
    setDebugEnabled(enabled);
    window.localStorage.setItem(SEARCH_DEBUG_STORAGE_KEY, String(enabled));
    if (query.trim()) {
      void runSearch(query);
    }
  };

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
              {targetLabel ? `Adding to ${targetLabel}` : "Card search"}
            </p>
            <h2 id="search-title">Find cards</h2>
          </div>
          <div className="search-drawer__header-actions">
            <button
              className={`icon-button ${settingsOpen ? "is-active" : ""}`}
              type="button"
              aria-label="Search settings"
              aria-expanded={settingsOpen}
              title="Search settings"
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <Settings2 aria-hidden="true" size={18} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="Close card search"
              title="Close"
              onClick={onClose}
            >
              <X aria-hidden="true" size={20} />
            </button>
            {settingsOpen ? (
              <div className="search-settings" aria-label="Search settings">
                <label>
                  <span>
                    <Bug aria-hidden="true" size={15} />
                    Search debug log
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="Search debug log"
                    checked={debugEnabled}
                    onChange={(event) => toggleDebug(event.target.checked)}
                  />
                </label>
              </div>
            ) : null}
          </div>
        </header>

        <form className="search-form" role="search" onSubmit={submit}>
          <Search aria-hidden="true" size={19} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search cards"
            placeholder="Card title or part of a title"
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
          <button
            className={`icon-button filter-toggle ${filtersOpen ? "is-active" : ""}`}
            type="button"
            aria-label={`${filtersOpen ? "Hide" : "Show"} search filters`}
            aria-expanded={filtersOpen}
            title="Filters"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <SlidersHorizontal aria-hidden="true" size={17} />
            {activeFilterCount > 0 ? (
              <span aria-label={`${activeFilterCount} active filters`}>
                {activeFilterCount}
              </span>
            ) : null}
          </button>
          <button className="primary-button search-submit" type="submit">
            Search
          </button>
        </form>

        {filtersOpen ? (
          <section className="search-filters" aria-label="Card search filters">
            <fieldset className="filter-fieldset filter-fieldset--mode">
              <legend>Color identity</legend>
              <div className="filter-radio-group">
                <label>
                  <input
                    type="radio"
                    name="color-match-mode"
                    value="subset"
                    checked={filters.colorMode === "subset"}
                    onChange={() =>
                      setFilters((current) => ({
                        ...current,
                        colorMode: "subset",
                      }))
                    }
                  />
                  Can include
                </label>
                <label>
                  <input
                    type="radio"
                    name="color-match-mode"
                    value="exact"
                    checked={filters.colorMode === "exact"}
                    onChange={() =>
                      setFilters((current) => ({
                        ...current,
                        colorMode: "exact",
                      }))
                    }
                  />
                  Exact
                </label>
              </div>
            </fieldset>

            <fieldset className="filter-fieldset filter-fieldset--colors">
              <legend>Colors</legend>
              <div className="color-filters">
                {COLOR_FILTERS.map(({ color, label }) => (
                  <label
                    className={`color-filter color-filter--${color.toLowerCase()}`}
                    key={color}
                    title={label}
                  >
                    <input
                      type="checkbox"
                      aria-label={label}
                      checked={filters.colors.includes(color)}
                      onChange={() => toggleColor(color)}
                    />
                    <span aria-hidden="true">{color}</span>
                  </label>
                ))}
                <label
                  className="color-filter color-filter--c"
                  title="Colorless"
                >
                  <input
                    type="checkbox"
                    aria-label="Colorless"
                    checked={filters.includeColorless}
                    onChange={(event) =>
                      setFilters((current) => ({
                        ...current,
                        includeColorless: event.target.checked,
                      }))
                    }
                  />
                  <span aria-hidden="true">C</span>
                </label>
              </div>
            </fieldset>

            <fieldset className="filter-fieldset filter-fieldset--range">
              <legend>Mana value</legend>
              <label>
                <span>Min</span>
                <input
                  type="number"
                  aria-label="Minimum mana value"
                  min="0"
                  max={filters.manaValueMax ?? 100}
                  step="1"
                  value={filters.manaValueMin ?? ""}
                  onChange={(event) =>
                    setNumberFilter("manaValueMin", event.target.value)
                  }
                />
              </label>
              <span aria-hidden="true">to</span>
              <label>
                <span>Max</span>
                <input
                  type="number"
                  aria-label="Maximum mana value"
                  min={filters.manaValueMin ?? 0}
                  max="100"
                  step="1"
                  value={filters.manaValueMax ?? ""}
                  onChange={(event) =>
                    setNumberFilter("manaValueMax", event.target.value)
                  }
                />
              </label>
            </fieldset>

            <fieldset className="filter-fieldset filter-fieldset--range">
              <legend>Price EUR</legend>
              <label>
                <span>Min</span>
                <input
                  type="number"
                  aria-label="Minimum price in euros"
                  min="0"
                  max={filters.priceEurMax ?? undefined}
                  step="0.01"
                  value={filters.priceEurMin ?? ""}
                  onChange={(event) =>
                    setNumberFilter("priceEurMin", event.target.value)
                  }
                />
              </label>
              <span aria-hidden="true">to</span>
              <label>
                <span>Max</span>
                <input
                  type="number"
                  aria-label="Maximum price in euros"
                  min={filters.priceEurMin ?? 0}
                  step="0.01"
                  value={filters.priceEurMax ?? ""}
                  onChange={(event) =>
                    setNumberFilter("priceEurMax", event.target.value)
                  }
                />
              </label>
            </fieldset>

            <button
              className="icon-button filter-reset"
              type="button"
              aria-label="Reset search filters"
              title="Reset filters"
              disabled={activeFilterCount === 0}
              onClick={resetFilters}
            >
              <Trash2 aria-hidden="true" size={16} />
            </button>
          </section>
        ) : null}

        <div className="search-drawer__body">
          <div
            className="search-results"
            aria-live="polite"
            aria-busy={
              state.phase === "loading" || state.phase === "agentic"
            }
          >
            {state.phase === "idle" ? (
              <div className="search-state">
                <Search aria-hidden="true" size={26} />
                <h3>Search Magic cards</h3>
              </div>
            ) : null}

            {state.phase === "loading" && cards.length === 0 ? (
              <div className="search-skeletons" aria-label="Searching cards">
                {Array.from({ length: 6 }, (_, index) => (
                  <span className="search-skeleton" key={index} />
                ))}
              </div>
            ) : null}

            {state.phase === "agentic" ? (
              <div
                className="agentic-search-loading"
                role="status"
                aria-label="Agentic search is loading"
              >
                <span className="agentic-search-loading__icon">
                  <Sparkles aria-hidden="true" size={15} />
                </span>
                <span className="agentic-search-loading__copy">
                  <strong>Agentic search loading</strong>
                  <small>Understanding the request and ranking cards</small>
                </span>
                <span className="agentic-search-loading__dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            ) : null}

            {state.phase === "agentic" && cards.length === 0 ? (
              <div
                className="search-skeletons"
                aria-label="Agentic search is ranking cards"
              >
                {Array.from({ length: 6 }, (_, index) => (
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

            {state.page?.debug ? (
              <SearchTracePanel debug={state.page.debug} />
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
                  <span>
                    {state.page?.total_results.toLocaleString()} ranked{" "}
                    {state.page?.total_results === 1 ? "card" : "cards"}
                  </span>
                  {state.page?.interpretation ? (
                    <span className="search-results__intent">
                      {state.page.interpretation}
                    </span>
                  ) : null}
                  {state.phase === "loading" ? <span>Loading more…</span> : null}
                </div>
                {state.phase === "error" ? (
                  <p className="search-warning" role="alert">
                    <AlertCircle aria-hidden="true" size={14} />
                    {state.message}
                  </p>
                ) : null}
                {state.page?.warnings[0] ? (
                  <p className="search-warning" role="status">
                    <AlertCircle aria-hidden="true" size={14} />
                    {state.page.warnings[0]}
                  </p>
                ) : null}
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
                    const titleConfidenceScore =
                      state.page?.title_confidence_scores[card.scryfall_id];
                    const colorIdentityWarning =
                      targetGroupId !== COMMAND_ZONE_GROUP_ID &&
                      !isWithinCommanderColorIdentity(
                        card,
                        commanderColorIdentity,
                      );
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
                          {debugEnabled &&
                          typeof titleConfidenceScore === "number" ? (
                            <span className="search-card__match-score">
                              Title confidence{" "}
                              {Math.round(titleConfidenceScore * 100)}%
                            </span>
                          ) : null}
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
                                onClick={() => onAdd(card, targetGroupId)}
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
                          {colorIdentityWarning ? (
                            <span className="printing-notice">
                              Outside commander color identity
                            </span>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </>
            ) : null}
            {state.page?.has_more ? (
              <button
                className="secondary-button load-more"
                type="button"
                disabled={
                  state.phase === "loading" || state.phase === "agentic"
                }
                onClick={() =>
                  void runSearch(
                    query,
                    (state.page?.page ?? 1) + 1,
                    true,
                  )
                }
              >
                {state.phase === "loading" ? "Loading…" : "Load more"}
              </button>
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
