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
  CardSubtypeMatch,
  CardTagFilter,
  CardTagMatch,
  EdhrecCommanderContext,
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
import { ApiError, apiClient, type ApiClient } from "../lib/api";
import { CardArt } from "./CardArt";
import { CardEnrichmentPanel } from "./CardEnrichmentPanel";
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
const CARD_TYPES = [
  "Artifact",
  "Battle",
  "Creature",
  "Enchantment",
  "Instant",
  "Kindred",
  "Land",
  "Planeswalker",
  "Sorcery",
] as const;
const SEARCH_DEBUG_STORAGE_KEY = "manabase.search-debug";
const EMPTY_TAG_FILTERS: CardTagFilter[] = [];

interface SearchDrawerProps {
  initialQuery?: string;
  initialTags?: CardTagFilter[];
  targetGroupId?: string;
  targetLabel?: string;
  entries: DeckCardEntry[];
  client?: ApiClient;
  suspended?: boolean;
  onAdd: (card: CardSearchResult, targetGroupId?: string) => void;
  onOpenCard?: (card: CardSearchResult) => void;
  onSetQuantity: (scryfallId: string, quantity: number) => void;
  onClose: () => void;
}

export function SearchDrawer({
  initialQuery = "",
  initialTags = EMPTY_TAG_FILTERS,
  targetGroupId,
  targetLabel,
  entries,
  client = apiClient,
  suspended = false,
  onAdd,
  onOpenCard,
  onSetQuantity,
  onClose,
}: SearchDrawerProps) {
  const [query, setQuery] = useState(initialQuery);
  const [filters, setFilters] = useState<CardSearchFilters>(() => ({
    ...EMPTY_CARD_SEARCH_FILTERS,
    colors: [],
    tags: initialTags,
  }));
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(
    () => window.localStorage.getItem(SEARCH_DEBUG_STORAGE_KEY) === "true",
  );
  const [enhanceWithEdhrec, setEnhanceWithEdhrec] = useState(true);
  const [edhrecContext, setEdhrecContext] =
    useState<EdhrecCommanderContext | null>(null);
  const [edhrecTheme, setEdhrecTheme] = useState<string | null>(null);
  const [edhrecContextLoading, setEdhrecContextLoading] = useState(false);
  const [state, setState] = useState<SearchState>({
    phase: "idle",
    page: null,
  });
  const [selected, setSelected] = useState<CardSearchResult | null>(null);
  const [tagQuery, setTagQuery] = useState("");
  const [tagMatches, setTagMatches] = useState<CardTagMatch[]>([]);
  const [tagSearchLoading, setTagSearchLoading] = useState(false);
  const [subtypeQuery, setSubtypeQuery] = useState("");
  const [subtypeMatches, setSubtypeMatches] = useState<CardSubtypeMatch[]>([]);
  const [subtypeSearchLoading, setSubtypeSearchLoading] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const activeTagRequest = useRef<AbortController | null>(null);
  const activeSubtypeRequest = useRef<AbortController | null>(null);
  const activeEdhrecRequest = useRef<AbortController | null>(null);
  const stateRef = useRef<SearchState>(state);
  stateRef.current = state;
  const debounceSkipped = useRef(false);
  const debugEnabledRef = useRef(debugEnabled);
  debugEnabledRef.current = debugEnabled;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const commanderColorIdentity = useMemo(
    () => getCommanderColorIdentity(entries),
    [entries],
  );
  const commanderEntries = useMemo(
    () => entries.filter((entry) => entry.section === "command_zone"),
    [entries],
  );
  const commanderOracleId =
    commanderEntries.length === 1
      ? commanderEntries[0]?.card.oracle_id ?? null
      : null;
  const edhrecEnabled = enhanceWithEdhrec && commanderOracleId !== null;
  const edhrecRef = useRef({
    enabled: edhrecEnabled,
    commanderOracleId,
    theme: edhrecTheme,
  });
  edhrecRef.current = {
    enabled: edhrecEnabled,
    commanderOracleId,
    theme: edhrecTheme,
  };
  const effectiveFilters = useMemo<CardSearchFilters>(
    () => ({
      ...filters,
      commanderColorIdentity:
        commanderColorIdentity === null
          ? null
          : [...commanderColorIdentity],
    }),
    [commanderColorIdentity, filters],
  );
  const filtersRef = useRef(effectiveFilters);
  filtersRef.current = effectiveFilters;

  const runSearch = useCallback(
    async (
      searchQuery: string,
      page = 1,
      append = false,
    ) => {
      const normalized = searchQuery.trim();
      if (
        !normalized &&
        !hasFilterOnlyIntent(
          filtersRef.current,
          edhrecRef.current.enabled,
        )
      ) {
        setState({ phase: "idle", page: null });
        setSelected(null);
        return;
      }
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      const existingPage = stateRef.current.page;
      let retainedPage = append ? existingPage : null;
      const needsAgenticContinuation =
        append && existingPage !== null && !existingPage.has_more;
      setState((current) =>
        needsAgenticContinuation && current.page
          ? { phase: "agentic", page: current.page }
          : {
              phase: "loading",
              page: append ? current.page : null,
            },
      );
      try {
        const storedAgentSession =
          append &&
          existingPage?.strategy === "agentic" &&
          existingPage.search_session_id
            ? existingPage.search_session_id
            : null;
        const shownOracleIds =
          append && existingPage
            ? existingPage.cards.map((card) => card.oracle_id)
            : [];
        const agenticQuery =
          normalized || describeFilterOnlyIntent(filtersRef.current);
        const agenticEnhancements = edhrecRef.current.commanderOracleId
          ? {
              enhanceWithEdhrec: edhrecRef.current.enabled,
              commanderOracleId: edhrecRef.current.commanderOracleId,
              ...(edhrecRef.current.theme
                ? { edhrecTheme: edhrecRef.current.theme }
                : {}),
            }
          : null;
        const result = storedAgentSession || needsAgenticContinuation
          ? agenticEnhancements
            ? await client.searchCardsAgentic?.(
                agenticQuery,
                page,
                controller.signal,
                filtersRef.current,
                debugEnabledRef.current,
                storedAgentSession,
                shownOracleIds,
                agenticEnhancements,
              )
            : await client.searchCardsAgentic?.(
                agenticQuery,
                page,
                controller.signal,
                filtersRef.current,
                debugEnabledRef.current,
                storedAgentSession,
                shownOracleIds,
              )
          : !normalized &&
              edhrecRef.current.enabled &&
              edhrecRef.current.commanderOracleId
            ? await client.searchCards(
                normalized,
                page,
                controller.signal,
                filtersRef.current,
                debugEnabledRef.current,
                {
                  enhanceWithEdhrec: true,
                  commanderOracleId: edhrecRef.current.commanderOracleId,
                  ...(edhrecRef.current.theme
                    ? { edhrecTheme: edhrecRef.current.theme }
                    : {}),
                },
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
          const shownIds = result.cards.map((card) => card.oracle_id);
          const agentResult = agenticEnhancements
            ? await client.searchCardsAgentic(
                agenticQuery,
                1,
                controller.signal,
                filtersRef.current,
                debugEnabledRef.current,
                null,
                shownIds,
                agenticEnhancements,
              )
            : await client.searchCardsAgentic(
                agenticQuery,
                1,
                controller.signal,
                filtersRef.current,
                debugEnabledRef.current,
                null,
                shownIds,
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
            current.page
          ) {
            return {
              phase: "success",
              page: {
                ...result,
                cards: [
                  ...current.page.cards,
                  ...result.cards.filter(
                    (candidate) =>
                      !current.page?.cards.some(
                        (shown) => shown.oracle_id === candidate.oracle_id,
                      ),
                  ),
                ],
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
        setState((current) => {
          const previousPage = retainedPage ?? current.page;
          const failedDebug = error instanceof ApiError ? error.debug : null;
          return {
            phase: "error",
            page:
              previousPage && failedDebug
                ? {
                    ...previousPage,
                    debug: failedDebug,
                    debug_runs: [
                      ...previousPage.debug_runs.filter(
                        (run) => run.trace_id !== failedDebug.trace_id,
                      ),
                      failedDebug,
                    ],
                  }
                : previousPage,
            message:
              error instanceof Error
                ? error.message
                : "Card search is temporarily unavailable.",
          };
        });
      }
    },
    [client],
  );
  const filterSignature = JSON.stringify(effectiveFilters);
  const enhancementSignature =
    `${edhrecEnabled}:${commanderOracleId ?? ""}:${edhrecTheme ?? ""}`;

  useEffect(() => {
    if (!suspendedRef.current) {
      inputRef.current?.focus();
    }
    if (initialQuery.trim() || initialTags.length > 0) {
      debounceSkipped.current = true;
      void runSearch(initialQuery);
    }
    return () => {
      activeRequest.current?.abort();
      activeTagRequest.current?.abort();
      activeSubtypeRequest.current?.abort();
      activeEdhrecRequest.current?.abort();
    };
  }, [initialQuery, initialTags, runSearch]);

  useEffect(() => {
    if (!suspended) {
      inputRef.current?.focus();
    }
  }, [suspended]);

  useEffect(() => {
    activeEdhrecRequest.current?.abort();
    setEdhrecTheme(null);
    if (commanderOracleId === null || !client.getCommanderEdhrecContext) {
      setEdhrecContext(null);
      setEdhrecContextLoading(false);
      return;
    }
    const controller = new AbortController();
    activeEdhrecRequest.current = controller;
    setEdhrecContextLoading(true);
    void client
      .getCommanderEdhrecContext(commanderOracleId, controller.signal)
      .then((context) => {
        if (!controller.signal.aborted) {
          setEdhrecContext(context);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setEdhrecContext({
            status: "unavailable",
            source: null,
            commander_oracle_id: commanderOracleId,
            commander_name: commanderEntries[0]?.card.name ?? null,
            themes: [],
            message:
              error instanceof Error
                ? error.message
                : "EDHREC commander themes are temporarily unavailable.",
          });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setEdhrecContextLoading(false);
        }
      });
    return () => controller.abort();
  }, [client, commanderEntries, commanderOracleId]);

  useEffect(() => {
    if (debounceSkipped.current) {
      debounceSkipped.current = false;
      return;
    }
    if (!query.trim() && !hasFilterOnlyIntent(filters, edhrecEnabled)) {
      activeRequest.current?.abort();
      activeRequest.current = null;
      setState({ phase: "idle", page: null });
      setSelected(null);
      return;
    }
    const timer = window.setTimeout(() => void runSearch(query), 420);
    return () => window.clearTimeout(timer);
  }, [query, filterSignature, enhancementSignature, edhrecEnabled, runSearch]);

  useEffect(() => {
    const normalized = tagQuery.trim();
    const searchTags = client.searchCardTags;
    if (!normalized || !searchTags) {
      activeTagRequest.current?.abort();
      activeTagRequest.current = null;
      setTagMatches([]);
      setTagSearchLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      activeTagRequest.current?.abort();
      const controller = new AbortController();
      activeTagRequest.current = controller;
      setTagSearchLoading(true);
      void searchTags(normalized, controller.signal)
        .then((matches) => {
          if (!controller.signal.aborted) {
            setTagMatches(
              matches.filter(
                (match) =>
                  !filtersRef.current.tags.some(
                    (selectedTag) => selectedTag.id === match.id,
                  ),
              ),
            );
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setTagMatches([]);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setTagSearchLoading(false);
          }
        });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [client, tagQuery]);

  useEffect(() => {
    const normalized = subtypeQuery.trim();
    const searchSubtypes = client.searchCardSubtypes;
    if (!normalized || !searchSubtypes) {
      activeSubtypeRequest.current?.abort();
      activeSubtypeRequest.current = null;
      setSubtypeMatches([]);
      setSubtypeSearchLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      activeSubtypeRequest.current?.abort();
      const controller = new AbortController();
      activeSubtypeRequest.current = controller;
      setSubtypeSearchLoading(true);
      void searchSubtypes(normalized, controller.signal)
        .then((matches) => {
          if (!controller.signal.aborted) {
            setSubtypeMatches(
              matches.filter(
                (match) =>
                  !filtersRef.current.subtypes.some(
                    (selectedSubtype) =>
                      selectedSubtype.toLocaleLowerCase() ===
                      match.name.toLocaleLowerCase(),
                  ),
              ),
            );
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setSubtypeMatches([]);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setSubtypeSearchLoading(false);
          }
        });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [client, subtypeQuery]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (suspendedRef.current) {
        return;
      }
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
    Number(filters.includeNonCommanderLegal) +
    Number(filters.includeOutsideCommanderColorIdentity) +
    filters.tags.length +
    filters.cardTypes.length +
    filters.subtypes.length +
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

  const toggleCardType = (cardType: string) => {
    setFilters((current) => ({
      ...current,
      cardTypes: current.cardTypes.includes(cardType)
        ? current.cardTypes.filter((candidate) => candidate !== cardType)
        : [...current.cardTypes, cardType],
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

  const addTagFilter = (tag: CardTagFilter) => {
    setFilters((current) => ({
      ...current,
      tags: current.tags.some((selectedTag) => selectedTag.id === tag.id)
        ? current.tags
        : [...current.tags, tag],
    }));
    setTagQuery("");
    setTagMatches([]);
  };

  const addSubtypeFilter = (subtype: string) => {
    setFilters((current) => ({
      ...current,
      subtypes: current.subtypes.some(
        (selectedSubtype) =>
          selectedSubtype.toLocaleLowerCase() === subtype.toLocaleLowerCase(),
      )
        ? current.subtypes
        : [...current.subtypes, subtype],
    }));
    setSubtypeQuery("");
    setSubtypeMatches([]);
  };

  const searchOnlyTag = (tag: CardTagFilter) => {
    setQuery("");
    setFilters({
      ...EMPTY_CARD_SEARCH_FILTERS,
      colors: [],
      tags: [tag],
    });
    setFiltersOpen(true);
    setTagQuery("");
    setTagMatches([]);
  };

  const toggleDebug = (enabled: boolean) => {
    debugEnabledRef.current = enabled;
    setDebugEnabled(enabled);
    window.localStorage.setItem(SEARCH_DEBUG_STORAGE_KEY, String(enabled));
    if (
      query.trim() ||
      hasFilterOnlyIntent(filtersRef.current, edhrecRef.current.enabled)
    ) {
      void runSearch(query);
    }
  };

  return (
    <div
      className="drawer-layer"
      aria-hidden={suspended || undefined}
      inert={suspended || undefined}
    >
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

            <fieldset className="filter-fieldset filter-fieldset--range filter-fieldset--mana">
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

            <fieldset className="filter-fieldset filter-fieldset--range filter-fieldset--price">
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

            <fieldset className="filter-fieldset filter-fieldset--card-types">
              <legend>Required card types</legend>
              <div className="card-type-filter">
                {CARD_TYPES.map((cardType) => (
                  <label key={cardType}>
                    <input
                      type="checkbox"
                      aria-label={cardType}
                      checked={filters.cardTypes.includes(cardType)}
                      onChange={() => toggleCardType(cardType)}
                    />
                    <span>{cardType}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="filter-fieldset filter-fieldset--subtypes">
              <legend>Required subtypes</legend>
              <div className="token-filter">
                {filters.subtypes.length > 0 ? (
                  <div className="token-filter__selected">
                    {filters.subtypes.map((subtype) => (
                      <button
                        type="button"
                        aria-label={`Remove ${subtype} subtype`}
                        onClick={() =>
                          setFilters((current) => ({
                            ...current,
                            subtypes: current.subtypes.filter(
                              (selectedSubtype) => selectedSubtype !== subtype,
                            ),
                          }))
                        }
                        key={subtype}
                      >
                        {subtype}
                        <X aria-hidden="true" size={10} />
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="token-filter__picker">
                  <input
                    type="search"
                    value={subtypeQuery}
                    disabled={!client.searchCardSubtypes}
                    aria-label="Search card subtypes"
                    placeholder="Find a subtype…"
                    autoComplete="off"
                    onChange={(event) => setSubtypeQuery(event.target.value)}
                  />
                  {subtypeQuery.trim() ? (
                    <div
                      className="token-filter__matches"
                      aria-label="Matching card subtypes"
                    >
                      {subtypeSearchLoading ? (
                        <span>Finding subtypes…</span>
                      ) : subtypeMatches.length > 0 ? (
                        subtypeMatches.map((subtype) => (
                          <button
                            type="button"
                            aria-label={`Add ${subtype.name} subtype`}
                            onClick={() => addSubtypeFilter(subtype.name)}
                            key={subtype.name}
                          >
                            <span>{subtype.name}</span>
                            <small>
                              {Math.round(subtype.match_score * 100)}%
                            </small>
                          </button>
                        ))
                      ) : (
                        <span>No matching subtypes</span>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            </fieldset>

            <fieldset className="filter-fieldset filter-fieldset--exceptions">
              <legend>Show exceptions</legend>
              <div className="filter-check-group">
                <label>
                  <input
                    type="checkbox"
                    checked={filters.includeNonCommanderLegal}
                    onChange={(event) =>
                      setFilters((current) => ({
                        ...current,
                        includeNonCommanderLegal: event.target.checked,
                      }))
                    }
                  />
                  Show non-Commander-legal cards
                </label>
                <label
                  title={
                    commanderColorIdentity === null
                      ? "Add a commander to establish the deck color identity."
                      : undefined
                  }
                >
                  <input
                    type="checkbox"
                    disabled={commanderColorIdentity === null}
                    checked={filters.includeOutsideCommanderColorIdentity}
                    onChange={(event) =>
                      setFilters((current) => ({
                        ...current,
                        includeOutsideCommanderColorIdentity:
                          event.target.checked,
                      }))
                    }
                  />
                  Show cards outside commander color identity
                </label>
              </div>
            </fieldset>

            <fieldset className="filter-fieldset filter-fieldset--enhancements">
              <legend>Recommendations</legend>
              <div className="filter-check-group">
                <label
                  title={
                    commanderEntries.length === 0
                      ? "Add a commander to enable EDHREC ranking."
                      : commanderEntries.length > 1
                        ? "EDHREC enhancement currently supports a single commander."
                        : undefined
                  }
                >
                  <input
                    type="checkbox"
                    checked={enhanceWithEdhrec}
                    disabled={commanderOracleId === null}
                    onChange={(event) =>
                      setEnhanceWithEdhrec(event.target.checked)
                    }
                  />
                  Enhance with EDHREC
                </label>
                {enhanceWithEdhrec && commanderOracleId !== null ? (
                  <label className="edhrec-theme-picker">
                    <span>Deck theme</span>
                    <select
                      aria-label="EDHREC deck theme"
                      value={edhrecTheme ?? ""}
                      disabled={
                        edhrecContextLoading ||
                        edhrecContext?.status !== "applied"
                      }
                      onChange={(event) =>
                        setEdhrecTheme(event.target.value || null)
                      }
                    >
                      <option value="">
                        {edhrecContextLoading
                          ? "Loading themes…"
                          : "All commander decks"}
                      </option>
                      {edhrecContext?.themes.map((theme) => (
                        <option value={theme.slug} key={theme.slug}>
                          {theme.name} ({theme.deck_count} decks)
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {enhanceWithEdhrec &&
                edhrecContext?.status === "unavailable" ? (
                  <p
                    className="filter-inline-error"
                    role="status"
                    aria-live="polite"
                  >
                    {edhrecContext.message ??
                      "EDHREC commander themes are unavailable. Local search still works."}
                  </p>
                ) : null}
              </div>
            </fieldset>

            <fieldset className="filter-fieldset filter-fieldset--tags">
              <legend>Required tags</legend>
              <div className="tag-filter">
                {filters.tags.length > 0 ? (
                  <div className="tag-filter__selected">
                    {filters.tags.map((tag) => (
                      <button
                        type="button"
                        aria-label={`Remove ${tag.name} tag`}
                        onClick={() =>
                          setFilters((current) => ({
                            ...current,
                            tags: current.tags.filter(
                              (selectedTag) => selectedTag.id !== tag.id,
                            ),
                          }))
                        }
                        key={tag.id}
                      >
                        {tag.name}
                        <X aria-hidden="true" size={10} />
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="tag-filter__picker">
                  <input
                    type="search"
                    value={tagQuery}
                    disabled={!client.searchCardTags}
                    aria-label="Search card tags"
                    placeholder="Find a tag…"
                    autoComplete="off"
                    onChange={(event) => setTagQuery(event.target.value)}
                  />
                  {tagQuery.trim() ? (
                    <div
                      className="tag-filter__matches"
                      aria-label="Matching card tags"
                    >
                      {tagSearchLoading ? (
                        <span>Finding tags…</span>
                      ) : tagMatches.length > 0 ? (
                        tagMatches.map((tag) => (
                          <button
                            type="button"
                            aria-label={`Add ${tag.name} tag`}
                            onClick={() =>
                              addTagFilter({ id: tag.id, name: tag.name })
                            }
                            key={tag.id}
                          >
                            <span>{tag.name}</span>
                            <small>
                              {Math.round(tag.match_score * 100)}%
                            </small>
                          </button>
                        ))
                      ) : (
                        <span>No matching tags</span>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
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
              <div
                className={[
                  "search-state",
                  "search-state--error",
                  state.page?.debug ? "search-state--with-trace" : "",
                ].join(" ")}
                role="alert"
              >
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

            {state.page?.debug_runs.length
              ? state.page.debug_runs.map((debug) => (
                  <SearchTracePanel debug={debug} key={debug.trace_id} />
                ))
              : state.page?.debug
                ? <SearchTracePanel debug={state.page.debug} />
                : null}

            {state.page?.edhrec.status === "unavailable" ? (
              <div className="search-enhancement-error" role="alert">
                <AlertCircle aria-hidden="true" size={17} />
                <span>
                  <strong>EDHREC enhancement failed</strong>
                  <small>
                    {state.page.edhrec.message ??
                      "Results use normal local sorting."}
                  </small>
                </span>
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
                          state.page?.strategy === "fuzzy" &&
                          !state.page.agentic_required &&
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
            {state.page ? (
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
                {state.phase === "loading" || state.phase === "agentic"
                  ? "Loading…"
                  : "Load more"}
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
                  <CardEnrichmentPanel
                    key={selected.oracle_id}
                    oracleId={selected.oracle_id}
                    client={client}
                    onOpenCard={onOpenCard}
                    onSelectTag={searchOnlyTag}
                  />
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

function hasFilterOnlyIntent(
  filters: CardSearchFilters,
  edhrecEnabled = false,
): boolean {
  return (
    edhrecEnabled ||
    filters.tags.length > 0 ||
    filters.cardTypes.length > 0 ||
    filters.subtypes.length > 0
  );
}

function describeFilterOnlyIntent(filters: CardSearchFilters): string {
  if (
    filters.tags.length > 0 &&
    filters.cardTypes.length === 0 &&
    filters.subtypes.length === 0
  ) {
    return `cards tagged ${filters.tags
      .map((tag) => `"${tag.name}"`)
      .join(" and ")}`;
  }
  const parts: string[] = [];
  if (filters.cardTypes.length > 0) {
    parts.push(`types ${filters.cardTypes.join(" and ")}`);
  }
  if (filters.subtypes.length > 0) {
    parts.push(`subtypes ${filters.subtypes.join(" and ")}`);
  }
  if (filters.tags.length > 0) {
    parts.push(`tags ${filters.tags.map((tag) => tag.name).join(" and ")}`);
  }
  return `cards matching required ${parts.join("; ")}`;
}
