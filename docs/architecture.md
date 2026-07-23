# Current Architecture

This document describes the code that runs today. Target architecture is
recorded separately in `plan.md` and proposed ADRs.

## Runtime Topology

```text
Browser
  |
  | React application (127.0.0.1:41737)
  | - deck library and undo history
  | - localStorage persistence
  | - search, editor, dialogs, responsive shell
  |
  | HTTP JSON
  v
FastAPI (127.0.0.1:43127/api/v1)
  |
  | HybridCardSearchProvider
  | - route selection
  | - filters
  | - exact/fuzzy name scores
  | - intent ranking
  | - debug tracing
  |
  +--> Scryfall API
  +--> local FastEmbed model
  +--> OpenRouter API (optional)
  |
  +--> local-data/search-debug.jsonl (debug only)
```

The backend does not currently persist decks. The frontend does not call a
deck API.

## Process Lifecycle

`npm run dev` executes `scripts/dev.mjs`.

The runner:

1. Loads root `.env` through Node's `--env-file-if-exists`.
2. Validates the frontend origin and both port values.
3. Refuses to start if either configured port is occupied.
4. Starts Uvicorn with reload from the backend virtual environment.
5. Starts Vite from the frontend workspace.
6. Injects the resolved API base URL into Vite.
7. Forwards termination and stops both children.

Uvicorn's FastAPI lifespan creates:

- An `httpx2.AsyncClient` for Scryfall.
- `ScryfallCardSearchProvider`.
- Lazy `FastEmbedCardRanker`.
- Optional OpenRouter client and `OpenRouterCardReranker`.
- `JsonlSearchDebugLogger`.
- `HybridCardSearchProvider`, stored on `application.state`.

## Backend Modules

### `config.py`

`Settings` is the single runtime configuration model. It reads environment
variables with the `MTG_` prefix, except `OPENROUTER_API_KEY`, which is also
accepted directly. Origins and URLs are validated before startup.

### `domain/cards.py`

Strict provider-neutral Pydantic models for:

- Card faces, images, prices, and selected printings.
- Structured search filters and queries.
- Search pages, strategies, scores, and debug summaries.

`extra="forbid"` is deliberate. A public contract addition must be intentional
and reflected in the frontend runtime validator.

### `domain/deck.py`

Early backend deck models for stable identities, sections, quantities, and
categories. These are not yet exposed through routes or a repository.

### `api/router.py`

Owns `/api/v1`, health response, and router composition.

### `api/cards.py`

Translates query parameters into `CardSearchQuery`, resolves the provider from
application state, and maps provider errors into stable public HTTP errors.

Current product routes:

```text
GET /api/v1/health
GET /api/v1/cards/search
GET /api/v1/openapi.json
```

### `providers/cards.py`

Provider protocol plus application-level provider exceptions. Routes and
search orchestration depend on this boundary.

### `providers/scryfall.py`

Owns Scryfall wire models, validation, rate-conscious request spacing, card
mapping, name-catalog caching, aliases, and similarity scoring.

Scryfall-specific response objects must not cross this module boundary.

### `search.py`

Owns:

- Route selection.
- Structured filter compilation.
- Deterministic intent compilation.
- Exact and fuzzy name ranking.
- Local embedding ranking.
- Optional OpenRouter reranking.
- Safe reranker degradation and warnings.

The module is intentionally orchestration-heavy at this stage. Split it only
when a new boundary removes real complexity, such as a general query planner or
local search index.

### `search_debug.py`

Builds one structured trace per search and appends complete JSON objects as
JSONL lines. It snapshots result ordering and computes rank deltas.

## Frontend Modules

### `domain/card.ts`

Provider-neutral card and search response types plus presentation-safe helpers.

### `domain/deck.ts`

Browser persistence schema, migration, group placement, primary card type, and
commander color-identity helpers.

Stable IDs:

```text
command_zone
unassigned
```

Persistence keys:

```text
manabase.deck-library.v2
manabase.active-deck.v1   # legacy migration only
```

### `lib/api.ts`

Builds search URLs, performs fetch calls, maps public API errors, and validates
the complete response at runtime. TypeScript types alone are not treated as a
network boundary.

### `hooks/useDeck.ts`

The current deck application service. It owns:

- Library creation and active selection.
- All deck mutations.
- Per-deck current-session undo history.
- `localStorage` persistence.
- User-facing live-region announcements.

Components receive named operations rather than writing storage directly.

### `components/SearchDrawer.tsx`

Search query state, debounce, cancellation, filters, debug preference,
pagination, results, deck membership, pre-add legality warnings, and selected
card preview.

### `components/SearchTracePanel.tsx`

Human-readable projection of structured backend traces. It intentionally
exposes raw LLM request and response JSON only under expandable details.

### `components/DeckBoard.tsx`

Visual/list rendering, custom/type grouping, sorting, drag-and-drop,
keyboard-accessible movement, group creation, and deck-card actions.

### `components/CardInspector.tsx`

Centered card-detail dialog content and custom-group movement controls.
Movement controls are available only in Custom grouping.

### `App.tsx`

Page shell, navigation rail, mobile toolbar, dialogs, menus, and composition of
deck and search services.

## Card Identity

Two identifiers are required:

- `oracle_id`: gameplay identity. Use for singleton warnings and same-card
  comparisons across printings.
- `scryfall_id`: selected-printing identity. Use for image, set, collector
  number, price, exact deck entry, and quantity operations.

Do not collapse these into one ID.

## Deck Placement Model

The current frontend stores:

```text
Deck
  custom_groups[]
  cards[]
    section: command_zone | mainboard
    categories[0]: primary custom group ID
```

Rules:

- Command-zone cards always resolve to `command_zone`.
- Mainboard cards resolve to a known custom group or `unassigned`.
- Card-type grouping is derived from `type_line`.
- Legacy maybeboard placement migrates to mainboard Not assigned.
- Unknown or missing custom-group IDs normalize to Not assigned. A future
  custom-group deletion operation must preserve that invariant.

## API Contract Coupling

`CardSearchPage` is deliberately mirrored:

```text
backend domain model
  -> FastAPI response
  -> frontend TypeScript interface
  -> frontend runtime validator
  -> frontend unit fixture
  -> E2E fixture
```

Changing only one layer causes either server validation failures or frontend
"malformed response" errors. Treat this as one atomic contract change.

## Error Boundaries

- Invalid Scryfall syntax becomes HTTP 400 with `invalid_card_search`.
- Provider/network failure becomes HTTP 503 with
  `card_search_unavailable`.
- Invalid min/max pairs become HTTP 422.
- Local embedding or OpenRouter ranking failure preserves Scryfall ordering and
  adds a warning instead of failing the search.
- Disabled/full `localStorage` does not make the active deck unusable; current
  memory state continues.

## Current Versus Target Architecture

Current:

```text
Browser localStorage owns decks
FastAPI owns card discovery
Scryfall owns card data
```

Target:

```text
React UI and agent
  -> typed backend deck/search services
  -> SQLite deck store and derived Scryfall catalog
  -> Scryfall live fallback
```

The migration must preserve browser-local libraries and must not allow the
future agent to bypass deck validation or mutation history.
