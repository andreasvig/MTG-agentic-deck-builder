import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "./components/Icon";
import { CardInspector } from "./components/CardInspector";
import { DeckAgentPanel } from "./components/DeckAgentPanel";
import { DeckBoard, type SortMode, type ViewMode } from "./components/DeckBoard";
import { DeckHistoryPanel } from "./components/DeckHistoryPanel";
import { DeleteDeckDialog } from "./components/DeleteDeckDialog";
import { ExportDeckDialog } from "./components/ExportDeckDialog";
import { SearchDrawer } from "./components/SearchDrawer";
import type { CardSearchResult, CardTagFilter } from "./domain/card";
import { formatEuro, getCardImage } from "./domain/card";
import type { DeckAgentAppliedEdit, DeckAgentDeckEdit } from "./domain/agent";
import {
  refusedDeckEdit,
  summarizeDeckEditRecord,
  toDeckAgentHistory,
  toDeckSnapshot,
} from "./domain/agent";
import type { Deck, DeckSection } from "./domain/deck";
import { DECK_HISTORY_STORAGE_KEY } from "./domain/history";
import { useBackendHealth } from "./hooks/useBackendHealth";
import { useDebugMode } from "./hooks/useDebugMode";
import type { DeckEdit, DeckEditChange } from "./hooks/useDeck";
import { useDeck } from "./hooks/useDeck";
import { useMediaQuery } from "./hooks/useMediaQuery";

import "./styles.css";

interface SearchRequest {
  id: number;
  targetSection?: DeckSection;
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
    canGoBack,
    canGoForward,
    history,
    lastRecordedEditId,
    deletedDeckName,
    statistics,
    addCard,
    applyEdit,
    setQuantity,
    removeCard,
    moveCard,
    renameDeck,
    createDeck,
    selectDeck,
    deleteDeck,
    restoreDeletedDeck,
    clearAnnouncement,
    back,
    forward,
    jumpToEdit,
  } = useDeck();
  const { health } = useBackendHealth();
  const [debugEnabled, setDebugEnabled] = useDebugMode();
  const isMobile = useMediaQuery("(max-width: 860px)");
  const [view, setView] = useState<ViewMode>("visual");
  // Mana cost, not name: a stacked column shows each card's printed top, which
  // is its name AND its cost, so the curve is readable straight down the column.
  const [sort, setSort] = useState<SortMode>("mana");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(null);
  const [selectedCard, setSelectedCard] = useState<CardSearchResult | null>(null);
  const [renamingDeck, setRenamingDeck] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  /*
   * What the deck agent's tools read. Rebuilt from the deck rather than held separately, so a
   * card added mid-conversation is visible on the next question.
   *
   * `updated_at` travels with it because it is the deck's revision, and both halves of the
   * staleness comparison have to be produced by the browser: the panel stamps it onto each
   * tool call as the call is made, and this is the value a later turn's replay is compared
   * against. Omit it and every comparison sees nothing on one side, so the backend's
   * substitution can never fire and a `read_deck` result from before the user moved half the
   * deck comes back to the model as a current observation.
   */
  const deckSnapshot = useMemo(
    () => toDeckSnapshot(deck.name, deck.cards, deck.updated_at),
    [deck.cards, deck.name, deck.updated_at],
  );
  /**
   * Which decks the agent is working on right now, reported by the panel.
   *
   * Held here rather than in the panel because the deck list is here: a turn on a deck the
   * user is not looking at is otherwise invisible, and there is nothing else on screen that
   * would tell them a second agent is still building.
   */
  const [agentTurnDeckIds, setAgentTurnDeckIds] = useState<string[]>([]);

  /**
   * Apply an edit the agent made, as the agent, and describe what became of it.
   *
   * The panel hands over what the backend resolved; translating it into the deck's own
   * typed operation happens here, where both contracts are already in scope. The actor
   * is what makes the history readable — an agent edit opens its own session, so "who
   * did this" has one answer per block rather than one per edit.
   *
   * Translation is a closure handed to the deck rather than a value computed here, so both
   * it and the verdict see the deck the edit is actually being applied to. That is not a
   * nicety: a turn can carry several edits, they arrive in one pass of the stream with no
   * render between them, and the second one is about the deck the first one left behind.
   *
   * What comes back is the block the transcript stores, written from the deck's own record of
   * the edit. Never from `edit`: the counts in it are the backend's belief about the snapshot
   * this browser posted, and a durable block that repeated them would name cards the deck
   * did not move and count copies it did not add.
   *
   * The deck is named rather than assumed, because a turn outlives the user's attention on the
   * deck it was asked about: `deckId` is the turn's deck, and the edit lands there whether or
   * not it is the deck on screen. `useDeck` announces such an edit with the deck's name, since
   * "3 cards added" read against a board it did not happen to is worse than silence.
   */
  const applyAgentEdit = useCallback(
    (edit: DeckAgentDeckEdit, deckId: string): DeckAgentAppliedEdit | null => {
      const outcome = applyEdit(
        // Refused whole rather than in part: an edit missing one of its changes is the
        // half-applied edit the design refuses, because history would then record an intent
        // that did not happen. The deck is never asked, so the reason is worded here — this
        // is the only place that knows the edit got no further than being resolved.
        (open) =>
          toDeckEdit(edit, open) ?? {
            error:
              "That edit named a card this deck cannot identify, so none of it was applied.",
          },
        "agent",
        deckId,
      );
      if (!outcome.applied) {
        return refusedDeckEdit(outcome.reason);
      }
      // Nothing recorded is the deck saying it already matched the edit. The deck announces
      // that itself, and it is the whole of what happened: there is no change to describe,
      // so the transcript stays silent rather than claiming one.
      return outcome.recorded
        ? summarizeDeckEditRecord(
            outcome.recorded.diff,
            edit.reason,
            outcome.recorded.editId,
          )
        : null;
    },
    [applyEdit],
  );

  /**
   * The deck's recorded history, read from the browser at the moment a turn is sent.
   *
   * `useDeck` writes the log in an effect, so it is current by the time a question can
   * be asked — but not during the render that changed the deck, which is why this is a
   * function the panel calls rather than a value it is handed.
   */
  const readDeckHistory = useCallback(() => {
    let raw: string | null = null;
    try {
      raw = window.localStorage?.getItem(DECK_HISTORY_STORAGE_KEY) ?? null;
    } catch {
      // A deck whose history cannot be read is a deck with none to post.
    }
    return toDeckAgentHistory(raw, deck.id);
  }, [deck.id]);

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
      targetSection?: DeckSection,
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
        targetSection,
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
            <Icon name="brand" size={25} />
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
            <Icon name="close" aria-hidden="true" size={18} />
          </button>
        </div>

        <nav className="primary-nav" aria-label="Primary">
          <a className="nav-item nav-item--active" href="#deck">
            <Icon name="deck" aria-hidden="true" size={18} />
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
                      <Icon name="command" aria-hidden="true" size={17} />
                    )}
                  </span>
                  <span>
                    <strong>{libraryDeck.name}</strong>
                    <small>{cardCount} cards · saved locally</small>
                  </span>
                  {/*
                    * The agent is working on this deck, whether or not it is the one open.
                    * A background turn has no other surface at all: without this the only
                    * evidence that a second deck is still building is the deck changing
                    * under the user later. Labelled rather than decorative, because a dot
                    * that only a sighted user is told about is not a surface either.
                    */}
                  {agentTurnDeckIds.includes(libraryDeck.id) ? (
                    <span
                      className="deck-link__working"
                      title="The deck agent is working on this deck"
                    >
                      <span className="sr-only">Deck agent working</span>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <button
            className="create-deck-button"
            type="button"
            onClick={startNewDeck}
          >
            <Icon name="plus" aria-hidden="true" size={16} />
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
            <Icon name="menu" aria-hidden="true" size={20} />
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
                  <Icon name="pencil" aria-hidden="true" size={14} />
                </button>
                <button
                  className="icon-button icon-button--compact deck-delete"
                  type="button"
                  aria-label={`Delete ${deck.name}`}
                  title="Delete deck"
                  onClick={() => setDeleteDialogOpen(true)}
                >
                  <Icon name="trash" aria-hidden="true" size={14} />
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
            <Icon name="plus" aria-hidden="true" size={16} />
            Add cards
          </button>
          <div className="segmented-control view-control" aria-label="Deck view">
            <button
              className={view === "visual" ? "is-active" : ""}
              type="button"
              aria-pressed={view === "visual"}
              onClick={() => setView("visual")}
            >
              <Icon name="columns" aria-hidden="true" size={15} />
              Visual
            </button>
            <button
              className={view === "list" ? "is-active" : ""}
              type="button"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <Icon name="list" aria-hidden="true" size={15} />
              List
            </button>
          </div>
          <label className="select-control">
            <span>Sort</span>
            <select
              aria-label="Sort cards"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortMode)}
            >
              <option value="alphabet">Alphabetical</option>
              <option value="mana">Mana cost</option>
              <option value="price">Price high-low</option>
            </select>
          </label>
          <button
            className="secondary-button export-button"
            type="button"
            disabled={deck.cards.length === 0}
            aria-haspopup="dialog"
            title="Export deck"
            onClick={() => setExportOpen(true)}
          >
            <Icon name="download" aria-hidden="true" size={15} />
            Export
          </button>
          <div className="time-travel">
            <button
              className="icon-button undo-button"
              type="button"
              disabled={!canGoBack}
              aria-label="Undo last deck change"
              title="Back"
              onClick={back}
            >
              <Icon name="undo" aria-hidden="true" size={17} />
            </button>
            <button
              className={`icon-button history-button ${
                historyOpen ? "is-active" : ""
              }`}
              type="button"
              aria-label="Deck history"
              aria-expanded={historyOpen}
              title="History"
              onClick={() => setHistoryOpen((open) => !open)}
            >
              <Icon name="history" aria-hidden="true" size={17} />
            </button>
            <button
              className="icon-button redo-button"
              type="button"
              disabled={!canGoForward}
              aria-label="Redo next deck change"
              title="Forward"
              onClick={forward}
            >
              <Icon name="redo" aria-hidden="true" size={17} />
            </button>
            {historyOpen ? (
              <DeckHistoryPanel
                edits={history.edits}
                appliedEditId={history.appliedEditId}
                onJump={jumpToEdit}
                onClose={() => setHistoryOpen(false)}
              />
            ) : null}
          </div>
          <div className="interface-settings">
            <button
              className={`icon-button ${settingsOpen ? "is-active" : ""}`}
              type="button"
              aria-label="Settings"
              aria-expanded={settingsOpen}
              title="Settings"
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <Icon name="settings" aria-hidden="true" size={17} />
            </button>
            {settingsOpen ? (
              <div className="interface-settings__panel" aria-label="Settings">
                <label>
                  <span>
                    <Icon name="bug" aria-hidden="true" size={15} />
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
                <Icon name="warning" aria-hidden="true" size={17} />
                <span>{statistics.commandZoneProblem}</span>
              </div>
            ) : null}
            <DeckBoard
              entries={deck.cards}
              view={view}
              sort={sort}
              singletonWarnings={statistics.singletonWarnings}
              colorIdentityWarnings={statistics.colorIdentityWarnings}
              onSearch={openSearch}
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
            onDeckEdit={applyAgentEdit}
            onUndoDeckEdit={back}
            undoableEditId={lastRecordedEditId}
            readDeckHistory={readDeckHistory}
            onActiveTurnsChange={setAgentTurnDeckIds}
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
          <Icon name="plus" aria-hidden="true" size={20} />
          <span>Add cards</span>
        </button>
        <button
          type="button"
          onClick={() => setView((current) => (current === "visual" ? "list" : "visual"))}
        >
          {view === "visual" ? (
            <Icon name="list" aria-hidden="true" size={20} />
          ) : (
            <Icon name="grid" aria-hidden="true" size={20} />
          )}
          <span>Layout</span>
        </button>
        <button type="button" disabled={!canGoBack} onClick={back}>
          <Icon name="undo" aria-hidden="true" size={20} />
          <span>Undo</span>
        </button>
        <button type="button" disabled={!canGoForward} onClick={forward}>
          <Icon name="redo" aria-hidden="true" size={20} />
          <span>Redo</span>
        </button>
        <button type="button" onClick={() => setNavigationOpen(true)}>
          <Icon name="more" aria-hidden="true" size={20} />
          <span>More</span>
        </button>
      </nav>

      <CardInspector
        card={selectedCard}
        quantity={selectedEntry?.quantity ?? 0}
        section={selectedEntry?.section}
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
          targetSection={searchRequest.targetSection}
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

      {exportOpen ? (
        <ExportDeckDialog deck={deck} onClose={() => setExportOpen(false)} />
      ) : null}

      {announcementTone === "error" ? (
        <div className="deck-toast deck-toast--error" role="alert">
          <Icon name="warning" aria-hidden="true" size={18} />
          <span>{announcement}</span>
          <button
            className="icon-button icon-button--compact"
            type="button"
            aria-label="Dismiss deck warning"
            onClick={clearAnnouncement}
          >
            <Icon name="close" aria-hidden="true" size={16} />
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

/**
 * Translate a resolved agent edit into the deck's own typed edit, or refuse it whole.
 *
 * One thing has to be resolved here and nowhere else: a change that only cuts or moves
 * carries no card payload — it does not need to, because the deck already holds the card —
 * so the payload comes from the deck itself, and a card the deck cannot produce one for
 * refuses the entire edit rather than silently dropping that change.
 *
 * That reading is of `deck` as it is at the moment the edit is applied, which is why this
 * takes it as an argument rather than closing over one: the printing a cut names may have
 * left the deck since the turn was sent.
 *
 * An absent `section` means "leave placement alone" and is passed through as absent. It is
 * never read as the mainboard: the same field carries an ordinary quantity change on a card
 * that happens to be the commander, so filling it in would take the user's commander out of
 * the command zone on the next quantity edit — invisible in the tool result, and the deck's
 * own validators would allow it.
 */
function toDeckEdit(edit: DeckAgentDeckEdit, deck: Deck): DeckEdit | null {
  const changes: DeckEditChange[] = [];
  for (const change of edit.changes) {
    const held = deck.cards.find(
      (entry) => entry.card.scryfall_id === change.scryfall_id,
    );
    const card = change.card ?? held?.card.details;
    if (!card) {
      return null;
    }
    changes.push({
      card,
      quantity: change.quantity,
      ...(change.section ? { section: change.section } : {}),
    });
  }
  return { reason: edit.reason, changes };
}

export default App;
