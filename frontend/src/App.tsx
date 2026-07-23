import {
  BookOpen,
  Boxes,
  CirclePlus,
  Columns3,
  Command,
  LayoutGrid,
  List,
  Menu,
  MoreHorizontal,
  Search,
  Undo2,
  WandSparkles,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { CardInspector } from "./components/CardInspector";
import {
  DeckBoard,
  type GroupMode,
  type SortMode,
  type ViewMode,
} from "./components/DeckBoard";
import { SearchDrawer } from "./components/SearchDrawer";
import type { CardSearchResult } from "./domain/card";
import { formatEuro } from "./domain/card";
import type { DeckCategory } from "./domain/deck";
import { categoryForEntry } from "./domain/deck";
import { useBackendHealth } from "./hooks/useBackendHealth";
import { useDeck } from "./hooks/useDeck";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { apiClient } from "./lib/api";

import "./styles.css";

interface SearchRequest {
  target?: DeckCategory;
  initialQuery?: string;
}

function App() {
  const {
    deck,
    announcement,
    canUndo,
    statistics,
    addCard,
    setQuantity,
    removeCard,
    moveCard,
    undo,
  } = useDeck();
  const { health, check } = useBackendHealth();
  const isMobile = useMediaQuery("(max-width: 860px)");
  const [view, setView] = useState<ViewMode>("visual");
  const [group, setGroup] = useState<GroupMode>("category");
  const [sort, setSort] = useState<SortMode>("alphabet");
  const [filter, setFilter] = useState("");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(null);
  const [selectedCard, setSelectedCard] = useState<CardSearchResult | null>(null);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickState, setQuickState] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const returnFocus = useRef<HTMLElement | null>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarClose = useRef<HTMLButtonElement>(null);

  const selectedEntry = selectedCard
    ? deck.cards.find(
        (entry) => entry.card.scryfall_id === selectedCard.scryfall_id,
      )
    : undefined;

  const openSearch = useCallback(
    (target?: DeckCategory, initialQuery?: string) => {
      returnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      if (isMobile) {
        setSelectedCard(null);
      }
      setSearchRequest({ target, initialQuery });
    },
    [isMobile],
  );

  const closeSearch = useCallback(() => {
    setSearchRequest(null);
    window.setTimeout(() => returnFocus.current?.focus(), 0);
  }, []);

  const closeNavigation = useCallback(() => {
    setNavigationOpen(false);
    window.setTimeout(() => menuTrigger.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!navigationOpen) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sidebarClose.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeNavigation();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = sidebarRef.current?.querySelectorAll<HTMLElement>(
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
    };
  }, [closeNavigation, navigationOpen]);

  const submitQuickAdd = async (event: FormEvent) => {
    event.preventDefault();
    const query = quickQuery.trim();
    if (!query || quickState === "loading") {
      return;
    }
    setQuickState("loading");
    try {
      const result = await apiClient.searchCards(query);
      const card = result.cards[0];
      if (!card) {
        setQuickState("error");
        openSearch(undefined, query);
        return;
      }
      addCard(card);
      setSelectedCard(card);
      setQuickQuery("");
      setQuickState("idle");
    } catch {
      setQuickState("error");
      openSearch(undefined, query);
    }
  };

  const legalityCopy = {
    legal: "Size ready",
    warning: "Needs review",
    building: "Building",
  }[statistics.legality];

  return (
    <div className="app-shell">
      <aside
        ref={sidebarRef}
        className={`sidebar ${navigationOpen ? "sidebar--open" : ""}`}
        aria-hidden={
          searchRequest || (isMobile && !navigationOpen) ? true : undefined
        }
        inert={
          searchRequest || (isMobile && !navigationOpen) ? true : undefined
        }
        role={isMobile && navigationOpen ? "dialog" : undefined}
        aria-modal={isMobile && navigationOpen ? true : undefined}
        aria-label={isMobile && navigationOpen ? "Navigation" : undefined}
      >
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <WandSparkles size={19} />
          </span>
          <span>Manabase</span>
          <button
            ref={sidebarClose}
            className="icon-button sidebar-close"
            type="button"
            aria-label="Close navigation"
            title="Close navigation"
            onClick={closeNavigation}
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>

        <nav className="primary-nav" aria-label="Primary">
          <a className="nav-item nav-item--active" href="#deck">
            <Boxes aria-hidden="true" size={18} />
            Deck editor
          </a>
          <button
            className="nav-item"
            type="button"
            onClick={() => {
              const openedFromMobileNavigation = navigationOpen;
              if (navigationOpen) {
                setNavigationOpen(false);
              }
              openSearch();
              if (openedFromMobileNavigation) {
                returnFocus.current = menuTrigger.current;
              }
            }}
          >
            <BookOpen aria-hidden="true" size={18} />
            Card search
          </button>
        </nav>

        <div className="sidebar-section">
          <div className="section-label">Local deck</div>
          <div className="deck-link deck-link--active">
            <span className="deck-thumbnail">
              <Command aria-hidden="true" size={17} />
            </span>
            <span>
              <strong>{deck.name}</strong>
              <small>{statistics.cardCount} cards · saved locally</small>
            </span>
          </div>
        </div>

        <div className="sidebar-footnote">
          <span
            className={`connection-dot connection-dot--${health.state}`}
            aria-hidden="true"
          />
          {health.state === "online"
            ? "Card service online"
            : health.state === "checking"
              ? "Connecting"
              : "Card service offline"}
        </div>
      </aside>

      {navigationOpen ? (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label="Close navigation"
          onClick={closeNavigation}
        />
      ) : null}

      <main
        className="workspace"
        id="deck"
        inert={
          searchRequest || (isMobile && navigationOpen) ? true : undefined
        }
      >
        <header className="topbar">
          <button
            ref={menuTrigger}
            className="icon-button mobile-menu"
            type="button"
            aria-label="Open navigation"
            aria-expanded={navigationOpen}
            title="Open navigation"
            onClick={() => setNavigationOpen(true)}
          >
            <Menu aria-hidden="true" size={20} />
          </button>
          <div className="deck-identity">
            <span>
              <small>Commander</small>
              <strong>{deck.name}</strong>
            </span>
          </div>
          <div className="deck-metrics" aria-label="Deck summary">
            <span>Commander</span>
            <strong>{statistics.cardCount} / 100</strong>
            <span className={`legality legality--${statistics.legality}`}>
              {legalityCopy}
            </span>
            <strong>{formatEuro(statistics.price, "€0.00")}</strong>
            <small>daily estimate</small>
          </div>
          <div className="topbar-actions">
            <button
              className="secondary-button top-search"
              type="button"
              onClick={() => openSearch()}
            >
              <Search aria-hidden="true" size={17} />
              Search cards
            </button>
            <button
              className="primary-button top-add"
              type="button"
              onClick={() => openSearch()}
            >
              <CirclePlus aria-hidden="true" size={17} />
              Add
            </button>
          </div>
        </header>

        <div className="editor-toolbar" aria-label="Deck controls">
          <button
            className="secondary-button toolbar-search"
            type="button"
            onClick={() => openSearch()}
          >
            <Search aria-hidden="true" size={16} />
            Search
          </button>
          <form className="quick-add" onSubmit={(event) => void submitQuickAdd(event)}>
            <CirclePlus aria-hidden="true" size={16} />
            <input
              value={quickQuery}
              onChange={(event) => {
                setQuickQuery(event.target.value);
                setQuickState("idle");
              }}
              aria-label="Quick add card"
              placeholder="Quick add by name"
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={!quickQuery.trim() || quickState === "loading"}
            >
              {quickState === "loading" ? "Adding…" : "Add"}
            </button>
          </form>
          <div className="segmented-control view-control" aria-label="Deck view">
            <button
              className={view === "visual" ? "is-active" : ""}
              type="button"
              aria-pressed={view === "visual"}
              onClick={() => setView("visual")}
            >
              <Columns3 aria-hidden="true" size={15} />
              Visual
            </button>
            <button
              className={view === "list" ? "is-active" : ""}
              type="button"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <List aria-hidden="true" size={15} />
              List
            </button>
          </div>
          <label className="select-control">
            <span>Group</span>
            <select
              aria-label="Group cards"
              value={group}
              onChange={(event) => setGroup(event.target.value as GroupMode)}
            >
              <option value="category">Category</option>
              <option value="type">Card type</option>
            </select>
          </label>
          <label className="select-control">
            <span>Sort</span>
            <select
              aria-label="Sort cards"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortMode)}
            >
              <option value="alphabet">Alphabetical</option>
              <option value="mana">Mana value</option>
              <option value="price">Price high-low</option>
            </select>
          </label>
          <label className="local-filter">
            <Search aria-hidden="true" size={15} />
            <span className="sr-only">Filter cards in this deck</span>
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter this deck"
            />
            {filter ? (
              <button
                type="button"
                aria-label="Clear local filter"
                onClick={() => setFilter("")}
              >
                <X aria-hidden="true" size={14} />
              </button>
            ) : null}
          </label>
          <button
            className="icon-button undo-button"
            type="button"
            disabled={!canUndo}
            aria-label="Undo last deck change"
            title="Undo"
            onClick={undo}
          >
            <Undo2 aria-hidden="true" size={17} />
          </button>
        </div>

        <div className="workspace-body">
          <section className="deck-canvas" aria-labelledby="deck-heading">
            <div className="canvas-heading">
              <div>
                <p className="eyebrow">Deck editor</p>
                <h1 id="deck-heading">{deck.name}</h1>
              </div>
              <span>{deck.cards.length} unique printings</span>
            </div>
            <DeckBoard
              entries={deck.cards}
              view={view}
              group={group}
              sort={sort}
              filter={filter}
              singletonWarnings={statistics.singletonWarnings}
              onSearch={openSearch}
              onSelect={setSelectedCard}
              onSetQuantity={setQuantity}
              onRemove={removeCard}
            />
          </section>

          <CardInspector
            card={selectedCard}
            quantity={selectedEntry?.quantity ?? 0}
            category={
              selectedEntry ? categoryForEntry(selectedEntry) : undefined
            }
            singletonWarning={
              selectedCard
                ? statistics.singletonWarnings.has(selectedCard.oracle_id)
                : false
            }
            isMobile={isMobile}
            health={health}
            onCheckHealth={() => void check()}
            onAdd={addCard}
            onSetQuantity={setQuantity}
            onMove={moveCard}
            onRemove={removeCard}
            onClose={() => setSelectedCard(null)}
          />
        </div>
      </main>

      <nav
        className="mobile-toolbar"
        aria-label="Deck actions"
        inert={
          searchRequest || (isMobile && navigationOpen) ? true : undefined
        }
      >
        <button type="button" onClick={() => openSearch()}>
          <Search aria-hidden="true" size={20} />
          <span>Search</span>
        </button>
        <button
          type="button"
          onClick={() => openSearch(undefined, quickQuery)}
        >
          <CirclePlus aria-hidden="true" size={20} />
          <span>Quick add</span>
        </button>
        <button
          type="button"
          onClick={() => setView((current) => (current === "visual" ? "list" : "visual"))}
        >
          {view === "visual" ? (
            <List aria-hidden="true" size={20} />
          ) : (
            <LayoutGrid aria-hidden="true" size={20} />
          )}
          <span>Layout</span>
        </button>
        <button type="button" disabled={!canUndo} onClick={undo}>
          <Undo2 aria-hidden="true" size={20} />
          <span>Undo</span>
        </button>
        <button type="button" onClick={() => setNavigationOpen(true)}>
          <MoreHorizontal aria-hidden="true" size={20} />
          <span>More</span>
        </button>
      </nav>

      {searchRequest ? (
        <SearchDrawer
          initialQuery={searchRequest.initialQuery}
          target={searchRequest.target}
          entries={deck.cards}
          onAdd={addCard}
          onSetQuantity={setQuantity}
          onClose={closeSearch}
        />
      ) : null}

      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
        {quickState === "error"
          ? " Quick add opened full card search."
          : ""}
      </div>
    </div>
  );
}

export default App;
