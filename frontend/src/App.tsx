import {
  BookOpen,
  Boxes,
  Columns3,
  Command,
  LayoutGrid,
  List,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
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
import { formatEuro, getCardImage } from "./domain/card";
import {
  groupIdForEntry,
} from "./domain/deck";
import { useBackendHealth } from "./hooks/useBackendHealth";
import { useDeck } from "./hooks/useDeck";
import { useMediaQuery } from "./hooks/useMediaQuery";

import "./styles.css";

interface SearchRequest {
  targetGroupId?: string;
  targetLabel?: string;
  initialQuery?: string;
}

function App() {
  const {
    deck,
    decks,
    announcement,
    canUndo,
    statistics,
    addCard,
    setQuantity,
    removeCard,
    moveCard,
    addCustomGroup,
    renameDeck,
    createDeck,
    selectDeck,
    undo,
  } = useDeck();
  const { health, check } = useBackendHealth();
  const isMobile = useMediaQuery("(max-width: 860px)");
  const [view, setView] = useState<ViewMode>("visual");
  const [group, setGroup] = useState<GroupMode>("custom");
  const [sort, setSort] = useState<SortMode>("alphabet");
  const [filter, setFilter] = useState("");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(null);
  const [selectedCard, setSelectedCard] = useState<CardSearchResult | null>(null);
  const [toolbarQuery, setToolbarQuery] = useState("");
  const [renamingDeck, setRenamingDeck] = useState(false);
  const [deckNameDraft, setDeckNameDraft] = useState(deck.name);
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
    (
      targetGroupId?: string,
      targetLabel?: string,
      initialQuery?: string,
    ) => {
      returnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      if (isMobile) {
        setSelectedCard(null);
      }
      setSearchRequest({ targetGroupId, targetLabel, initialQuery });
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

  useEffect(() => {
    setRenamingDeck(false);
    setDeckNameDraft(deck.name);
    setSelectedCard(null);
    setFilter("");
  }, [deck.id, deck.name]);

  const submitToolbarSearch = (event: FormEvent) => {
    event.preventDefault();
    const query = toolbarQuery.trim();
    if (!query) {
      return;
    }
    setToolbarQuery("");
    openSearch(undefined, undefined, query);
  };

  const beginDeckRename = () => {
    setDeckNameDraft(deck.name);
    setRenamingDeck(true);
  };

  const finishDeckRename = () => {
    if (deckNameDraft.trim()) {
      renameDeck(deckNameDraft);
    } else {
      setDeckNameDraft(deck.name);
    }
    setRenamingDeck(false);
  };

  const chooseDeck = (deckId: string) => {
    selectDeck(deckId);
    setNavigationOpen(false);
  };

  const startNewDeck = () => {
    createDeck();
    setNavigationOpen(false);
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
          <div className="section-label">Local decks</div>
          <div className="deck-library">
            {decks.map((libraryDeck) => {
              const commander = libraryDeck.cards.find(
                (entry) =>
                  entry.section === "command_zone" && entry.card.details,
              )?.card.details;
              const commanderArt = commander
                ? (commander.image_uris?.art_crop ??
                  commander.card_faces[0]?.image_uris?.art_crop ??
                  getCardImage(commander, "small"))
                : null;
              const cardCount = libraryDeck.cards.reduce(
                (total, entry) => total + entry.quantity,
                0,
              );
              return (
                <button
                  className={`deck-link ${
                    libraryDeck.id === deck.id ? "deck-link--active" : ""
                  }`}
                  type="button"
                  aria-pressed={libraryDeck.id === deck.id}
                  onClick={() => chooseDeck(libraryDeck.id)}
                  key={libraryDeck.id}
                >
                  <span className="deck-thumbnail">
                    {commanderArt && commander ? (
                      <img
                        className="deck-thumbnail__art"
                        src={commanderArt}
                        alt={`${commander.name} commander`}
                      />
                    ) : (
                      <Command aria-hidden="true" size={17} />
                    )}
                  </span>
                  <span>
                    <strong>{libraryDeck.name}</strong>
                    <small>{cardCount} cards · saved locally</small>
                  </span>
                </button>
              );
            })}
          </div>
          <button
            className="create-deck-button"
            type="button"
            onClick={startNewDeck}
          >
            <Plus aria-hidden="true" size={16} />
            Create new deck
          </button>
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
          <div
            className={`deck-identity ${
              renamingDeck ? "deck-identity--editing" : ""
            }`}
            onDoubleClick={beginDeckRename}
          >
            {renamingDeck ? (
              <input
                autoFocus
                value={deckNameDraft}
                maxLength={80}
                aria-label="Deck name"
                onChange={(event) => setDeckNameDraft(event.target.value)}
                onFocus={(event) => {
                  const input = event.currentTarget;
                  input.select();
                  window.requestAnimationFrame(() => {
                    if (input.isConnected) {
                      input.scrollLeft = 0;
                    }
                  });
                }}
                onBlur={finishDeckRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    finishDeckRename();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setDeckNameDraft(deck.name);
                    setRenamingDeck(false);
                  }
                }}
              />
            ) : (
              <span>
                <small>Commander</small>
                <strong>{deck.name}</strong>
              </span>
            )}
            {!renamingDeck ? (
              <button
                className="icon-button icon-button--compact deck-name-edit"
                type="button"
                aria-label="Rename deck"
                title="Rename deck"
                onClick={beginDeckRename}
              >
                <Pencil aria-hidden="true" size={14} />
              </button>
            ) : null}
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
          <form className="quick-add" onSubmit={submitToolbarSearch}>
            <Search aria-hidden="true" size={16} />
            <input
              value={toolbarQuery}
              onChange={(event) => setToolbarQuery(event.target.value)}
              aria-label="Search cards from toolbar"
              placeholder="Search cards"
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={!toolbarQuery.trim()}
            >
              Search
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
              <option value="custom">Custom</option>
              <option value="type">Card types</option>
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
              customGroups={deck.custom_groups}
              view={view}
              group={group}
              sort={sort}
              filter={filter}
              singletonWarnings={statistics.singletonWarnings}
              colorIdentityWarnings={statistics.colorIdentityWarnings}
              onSearch={openSearch}
              onAddCustomGroup={addCustomGroup}
              onSelect={setSelectedCard}
              onSetQuantity={setQuantity}
              onRemove={removeCard}
            />
          </section>

          <CardInspector
            card={selectedCard}
            quantity={selectedEntry?.quantity ?? 0}
            groupId={
              selectedEntry
                ? groupIdForEntry(selectedEntry, deck.custom_groups)
                : undefined
            }
            customGroups={deck.custom_groups}
            showCustomGroupControl={group === "custom"}
            singletonWarning={
              selectedCard
                ? statistics.singletonWarnings.has(selectedCard.oracle_id)
                : false
            }
            colorIdentityWarning={
              selectedCard
                ? statistics.colorIdentityWarnings.has(selectedCard.oracle_id)
                : false
            }
            commanderColorIdentity={statistics.commanderColorIdentity}
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
          targetGroupId={searchRequest.targetGroupId}
          targetLabel={searchRequest.targetLabel}
          entries={deck.cards}
          onAdd={addCard}
          onSetQuantity={setQuantity}
          onClose={closeSearch}
        />
      ) : null}

      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

export default App;
