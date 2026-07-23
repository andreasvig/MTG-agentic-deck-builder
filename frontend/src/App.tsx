import { useState } from "react";
import {
  Archive,
  BarChart3,
  BookOpen,
  Boxes,
  ChevronDown,
  CirclePlus,
  Columns3,
  Command,
  List,
  Menu,
  MoreHorizontal,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";

import { ConnectionStatus } from "./components/ConnectionStatus";
import { useBackendHealth } from "./hooks/useBackendHealth";

import "./styles.css";

type ViewMode = "columns" | "list";

interface EmptyCategory {
  name: string;
  count: number;
  tone: "plum" | "gold" | "green" | "blue";
}

const categories: EmptyCategory[] = [
  { name: "Command zone", count: 0, tone: "plum" },
  { name: "Lands", count: 0, tone: "gold" },
  { name: "Creatures", count: 0, tone: "green" },
  { name: "Other spells", count: 0, tone: "blue" },
];

function App() {
  const [viewMode, setViewMode] = useState<ViewMode>("columns");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const { health, check } = useBackendHealth();

  return (
    <div className="app-shell">
      <aside className={`sidebar ${navigationOpen ? "sidebar--open" : ""}`}>
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <WandSparkles size={19} />
          </div>
          <span>Manabase</span>
          <button
            className="icon-button sidebar-close"
            type="button"
            aria-label="Close navigation"
            title="Close navigation"
            onClick={() => setNavigationOpen(false)}
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>

        <nav className="primary-nav" aria-label="Primary">
          <a className="nav-item nav-item--active" href="#decks">
            <Boxes aria-hidden="true" size={18} />
            Decks
          </a>
          <a className="nav-item" href="#cards">
            <BookOpen aria-hidden="true" size={18} />
            Card library
          </a>
          <a className="nav-item" href="#archive">
            <Archive aria-hidden="true" size={18} />
            Archive
          </a>
        </nav>

        <div className="sidebar-section">
          <div className="section-label">
            <span>Local decks</span>
            <button
              className="icon-button icon-button--dark"
              type="button"
              aria-label="Create deck"
              title="Create deck"
            >
              <CirclePlus aria-hidden="true" size={17} />
            </button>
          </div>
          <button className="deck-link deck-link--active" type="button">
            <span className="deck-thumbnail">
              <Command aria-hidden="true" size={17} />
            </span>
            <span>
              <strong>Untitled Commander</strong>
              <small>0 cards</small>
            </span>
          </button>
        </div>

        <div className="sidebar-footer">
          <a className="nav-item" href="#settings">
            <Settings aria-hidden="true" size={18} />
            Settings
          </a>
        </div>
      </aside>

      {navigationOpen ? (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavigationOpen(false)}
        />
      ) : null}

      <main className="workspace">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            type="button"
            aria-label="Open navigation"
            title="Open navigation"
            onClick={() => setNavigationOpen(true)}
          >
            <Menu aria-hidden="true" size={20} />
          </button>
          <button className="deck-identity" type="button">
            <span>
              <small>Commander deck</small>
              <strong>Untitled Commander</strong>
            </span>
            <ChevronDown aria-hidden="true" size={16} />
          </button>
          <div className="topbar-actions">
            <button
              className="icon-button"
              type="button"
              aria-label="Search cards"
              title="Search cards"
            >
              <Search aria-hidden="true" size={19} />
            </button>
            <button className="primary-button" type="button">
              <CirclePlus aria-hidden="true" size={17} />
              Add card
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="Deck actions"
              title="Deck actions"
            >
              <MoreHorizontal aria-hidden="true" size={20} />
            </button>
          </div>
        </header>

        <div className="workspace-body">
          <section className="deck-canvas" aria-labelledby="deck-heading">
            <div className="canvas-toolbar">
              <div>
                <p className="eyebrow">Mainboard</p>
                <div className="title-line">
                  <h1 id="deck-heading">Deck workspace</h1>
                  <span className="card-count">0 / 100</span>
                </div>
              </div>
              <div className="segmented-control" aria-label="Deck view">
                <button
                  className={viewMode === "columns" ? "is-active" : ""}
                  type="button"
                  aria-pressed={viewMode === "columns"}
                  onClick={() => setViewMode("columns")}
                >
                  <Columns3 aria-hidden="true" size={16} />
                  Columns
                </button>
                <button
                  className={viewMode === "list" ? "is-active" : ""}
                  type="button"
                  aria-pressed={viewMode === "list"}
                  onClick={() => setViewMode("list")}
                >
                  <List aria-hidden="true" size={16} />
                  List
                </button>
              </div>
            </div>

            {viewMode === "columns" ? (
              <div className="category-grid">
                {categories.map((category) => (
                  <section
                    className="category-column"
                    key={category.name}
                    aria-label={`${category.name}: ${category.count} cards`}
                  >
                    <header>
                      <span
                        className={`category-marker category-marker--${category.tone}`}
                        aria-hidden="true"
                      />
                      <h2>{category.name}</h2>
                      <span>{category.count}</span>
                      <button
                        className="icon-button icon-button--compact"
                        type="button"
                        aria-label={`Add card to ${category.name}`}
                        title={`Add card to ${category.name}`}
                      >
                        <CirclePlus aria-hidden="true" size={15} />
                      </button>
                    </header>
                    <div className="category-empty">
                      <span aria-hidden="true">
                        <Sparkles size={18} />
                      </span>
                      <p>No cards</p>
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <div className="list-view">
                <div className="list-head" aria-hidden="true">
                  <span>Card</span>
                  <span>Category</span>
                  <span>Mana</span>
                  <span>Price</span>
                </div>
                <div className="list-empty">
                  <List aria-hidden="true" size={20} />
                  <p>No cards in mainboard</p>
                  <button className="secondary-button" type="button">
                    <CirclePlus aria-hidden="true" size={16} />
                    Add card
                  </button>
                </div>
              </div>
            )}
          </section>

          <aside className="inspector" aria-label="Deck inspector">
            <div className="inspector-heading">
              <span>Inspector</span>
              <button
                className="icon-button icon-button--compact"
                type="button"
                aria-label="Inspector actions"
                title="Inspector actions"
              >
                <MoreHorizontal aria-hidden="true" size={18} />
              </button>
            </div>

            <ConnectionStatus health={health} onRefresh={() => void check()} />

            <section className="inspector-section">
              <div className="inspector-title">
                <ShieldCheck aria-hidden="true" size={17} />
                <h2>Validation</h2>
              </div>
              <div className="validation-row">
                <span className="status-dot status-dot--muted" />
                <span>Commander</span>
                <strong>Missing</strong>
              </div>
              <div className="validation-row">
                <span className="status-dot status-dot--muted" />
                <span>Deck size</span>
                <strong>0 / 100</strong>
              </div>
              <div className="validation-row">
                <span className="status-dot status-dot--muted" />
                <span>Color identity</span>
                <strong>Unset</strong>
              </div>
            </section>

            <section className="inspector-section">
              <div className="inspector-title">
                <BarChart3 aria-hidden="true" size={17} />
                <h2>Summary</h2>
              </div>
              <dl className="summary-grid">
                <div>
                  <dt>Avg. mana</dt>
                  <dd>-</dd>
                </div>
                <div>
                  <dt>Lands</dt>
                  <dd>0</dd>
                </div>
                <div>
                  <dt>Colors</dt>
                  <dd>-</dd>
                </div>
                <div>
                  <dt>Est. price</dt>
                  <dd>-</dd>
                </div>
              </dl>
            </section>

            <button className="agent-button" type="button" disabled>
              <Sparkles aria-hidden="true" size={17} />
              Deck assistant
              <span>Later</span>
            </button>
          </aside>
        </div>
      </main>
    </div>
  );
}

export default App;
