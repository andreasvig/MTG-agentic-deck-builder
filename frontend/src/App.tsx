import {
  AlertTriangle,
  Boxes,
  Bug,
  Columns3,
  Command,
  LayoutGrid,
  List,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings2,
  Trash2,
  Undo2,
  WandSparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CardInspector } from "./components/CardInspector";
import { DeckAgentPanel } from "./components/DeckAgentPanel";
import {
  DeckBoard,
  type GroupMode,
  type SortMode,
  type ViewMode,
} from "./components/DeckBoard";
import { DeleteDeckDialog } from "./components/DeleteDeckDialog";
import { SearchDrawer } from "./components/SearchDrawer";
import type { CardSearchResult, CardTagFilter } from "./domain/card";
import { formatEuro, getCardImage } from "./domain/card";
import { toDeckSnapshot } from "./domain/agent";
import {
  UNASSIGNED_GROUP_ID,
  groupIdForEntry,
  groupName,
} from "./domain/deck";
import { useBackendHealth } from "./hooks/useBackendHealth";
import { useDebugMode } from "./hooks/useDebugMode";
import { useDeck } from "./hooks/useDeck";
import { useMediaQuery } from "./hooks/useMediaQuery";

import "./styles.css";

interface SearchRequest {
  id: number;
  targetGroupId?: string;
  targetLabel?: string;
  initialQuery?: string;
  initialTags?: CardTagFilter[];
}

function App() {
  const {
    deck,
    decks,
    announcement,
    announcementTone,
    canUndo,
    deletedDeckName,
    statistics,
    addCard,
    setQuantity,
    removeCard,
    moveCard,
    addCustomGroup,
    renameDeck,
    createDeck,
    selectDeck,
    deleteDeck,
    restoreDeletedDeck,
    clearAnnouncement,
    undo,
  } = useDeck();
  const { health } = useBackendHealth();
  const [debugEnabled, setDebugEnabled] = useDebugMode();
  const isMobile = useMediaQuery("(max-width: 860px)");
  const [view, setView] = useState<ViewMode>("visual");
  const [group, setGroup] = useState<GroupMode>("type");
  const [sort, setSort] = useState<SortMode>("alphabet");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(null);
  const [selectedCard, setSelectedCard] = useState<CardSearchResult | null>(null);
  const [renamingDeck, setRenamingDeck] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // What the deck agent's tools read. Rebuilt from the deck rather than held
  // separately, so a card added mid-conversation is visible on the next question.
  const deckSnapshot = useMemo(
    () =>
      toDeckSnapshot(deck.name, deck.cards, (entry) => {
        const groupId = groupIdForEntry(entry, deck.custom_groups);
        return groupId === UNASSIGNED_GROUP_ID
          ? undefined
          : groupName(groupId, deck.custom_groups);
      }),
    [deck.cards, deck.custom_groups, deck.name],
  );

  const [deckNameDraft, setDeckNameDraft] = useState(deck.name);
  const returnFocus = useRef<HTMLElement | null>(null);
  const nextSearchRequestId = useRef(1);
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
      initialTags?: CardTagFilter[],
    ) => {
      returnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      if (isMobile) {
        setSelectedCard(null);
      }
      setSearchRequest({
        id: nextSearchRequestId.current++,
        targetGroupId,
        targetLabel,
        initialQuery,
        initialTags,
      });
    },
    [isMobile],
  );

  const closeSearch = useCallback(() => {
    setSearchRequest(null);
    window.setTimeout(() => returnFocus.current?.focus(), 0);
  }, []);

  const closeCard = useCallback(() => {
    setSelectedCard(null);
  }, []);

  const closeDeleteDialog = useCallback(() => {
    setDeleteDialogOpen(false);
  }, []);

  const openTagSearch = useCallback((tag: CardTagFilter) => {
    setSelectedCard(null);
    setSearchRequest({
      id: nextSearchRequestId.current++,
      initialQuery: "",
      initialTags: [tag],
    });
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
    setDeleteDialogOpen(false);
    setDeckNameDraft(deck.name);
    setSelectedCard(null);
  }, [deck.id, deck.name]);

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

  const confirmDeleteDeck = useCallback(() => {
    deleteDeck(deck.id);
    setDeleteDialogOpen(false);
  }, [deck.id, deleteDeck]);

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
          searchRequest ||
          selectedCard ||
          deleteDialogOpen ||
          (isMobile && !navigationOpen)
            ? true
            : undefined
        }
        inert={
          searchRequest ||
          selectedCard ||
          deleteDialogOpen ||
          (isMobile && !navigationOpen)
            ? true
            : undefined
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
          searchRequest ||
          selectedCard ||
          deleteDialogOpen ||
          (isMobile && navigationOpen)
            ? true
            : undefined
        }
        aria-hidden={
          searchRequest ||
          selectedCard ||
          deleteDialogOpen ||
          (isMobile && navigationOpen)
            ? true
            : undefined
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
              <span className="deck-identity__actions">
                <button
                  className="icon-button icon-button--compact deck-name-edit"
                  type="button"
                  aria-label="Rename deck"
                  title="Rename deck"
                  onClick={beginDeckRename}
                >
                  <Pencil aria-hidden="true" size={14} />
                </button>
                <button
                  className="icon-button icon-button--compact deck-delete"
                  type="button"
                  aria-label={`Delete ${deck.name}`}
                  title="Delete deck"
                  onClick={() => setDeleteDialogOpen(true)}
                >
                  <Trash2 aria-hidden="true" size={14} />
                </button>
              </span>
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
            className="secondary-button add-cards-button"
            type="button"
            onClick={() => openSearch()}
          >
            <Plus aria-hidden="true" size={16} />
            Add cards
          </button>
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
          <div className="interface-settings">
            <button
              className={`icon-button ${settingsOpen ? "is-active" : ""}`}
              type="button"
              aria-label="Settings"
              aria-expanded={settingsOpen}
              title="Settings"
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <Settings2 aria-hidden="true" size={17} />
            </button>
            {settingsOpen ? (
              <div className="interface-settings__panel" aria-label="Settings">
                <label>
                  <span>
                    <Bug aria-hidden="true" size={15} />
                    Debug mode
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="Debug mode"
                    checked={debugEnabled}
                    onChange={(event) => setDebugEnabled(event.target.checked)}
                  />
                </label>
                <small>
                  Shows the search trace and what each agent call costs.
                </small>
              </div>
            ) : null}
          </div>
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
            {statistics.commandZoneProblem ? (
              <div className="command-zone-warning" role="status">
                <AlertTriangle aria-hidden="true" size={17} />
                <span>{statistics.commandZoneProblem}</span>
              </div>
            ) : null}
            <DeckBoard
              entries={deck.cards}
              customGroups={deck.custom_groups}
              view={view}
              group={group}
              sort={sort}
              singletonWarnings={statistics.singletonWarnings}
              colorIdentityWarnings={statistics.colorIdentityWarnings}
              onSearch={openSearch}
              onAddCustomGroup={addCustomGroup}
              onSelect={setSelectedCard}
              onSetQuantity={setQuantity}
              onMove={moveCard}
              onRemove={removeCard}
            />
          </section>
          <DeckAgentPanel
            debugEnabled={debugEnabled}
            deckId={deck.id}
            deck={deckSnapshot}
            onOpenCard={setSelectedCard}
          />
        </div>
      </main>

      <nav
        className="mobile-toolbar"
        aria-label="Deck actions"
        inert={
          searchRequest ||
          selectedCard ||
          deleteDialogOpen ||
          (isMobile && navigationOpen)
            ? true
            : undefined
        }
      >
        <button type="button" onClick={() => openSearch()}>
          <Plus aria-hidden="true" size={20} />
          <span>Add cards</span>
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
        onOpenCard={setSelectedCard}
        onSelectTag={openTagSearch}
        onAdd={addCard}
        onSetQuantity={setQuantity}
        onMove={moveCard}
        onRemove={removeCard}
        onClose={closeCard}
      />

      {searchRequest ? (
        <SearchDrawer
          key={searchRequest.id}
          initialQuery={searchRequest.initialQuery}
          initialTags={searchRequest.initialTags}
          targetGroupId={searchRequest.targetGroupId}
          targetLabel={searchRequest.targetLabel}
          entries={deck.cards}
          suspended={selectedCard !== null}
          debugEnabled={debugEnabled}
          onAdd={addCard}
          onOpenCard={setSelectedCard}
          onSetQuantity={setQuantity}
          onClose={closeSearch}
        />
      ) : null}

      {deleteDialogOpen ? (
        <DeleteDeckDialog
          deckName={deck.name}
          cardCount={statistics.cardCount}
          isOnlyDeck={decks.length === 1}
          onCancel={closeDeleteDialog}
          onConfirm={confirmDeleteDeck}
        />
      ) : null}

      {announcementTone === "error" ? (
        <div className="deck-toast deck-toast--error" role="alert">
          <AlertTriangle aria-hidden="true" size={18} />
          <span>{announcement}</span>
          <button
            className="icon-button icon-button--compact"
            type="button"
            aria-label="Dismiss deck warning"
            onClick={clearAnnouncement}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      ) : null}

      {deletedDeckName ? (
        <div className="deck-toast deck-toast--deleted" role="status">
          <span>{deletedDeckName} deleted.</span>
          <button type="button" onClick={restoreDeletedDeck}>
            Undo
          </button>
        </div>
      ) : null}

      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

export default App;
