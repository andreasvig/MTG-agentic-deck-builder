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
  | FuzzyTitleSearchProvider
  | - local SQLite cards and title aliases
  | - RapidFuzz WRatio scores
  | - threshold-free, numbered six-card pages
  | - local structured filters
  | - debug tracing
  |
  +--> local-data/cards.sqlite3
  |
  | when fewer than six titles clear preview confidence
  v
AgenticCardSearchService
  |-- OpenRouter initial tool selection
  |-- exactly one structured local-catalog tool call
  |-- OpenRouter structured relevant-subset ranking
  `-- in-memory ranked batches and user-triggered Load more continuations
  |
  +--> local-data/search-debug.jsonl (debug only)

Explicit refresh:

Scryfall default_cards -> streaming importer -> atomic cards.sqlite3 swap
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

Uvicorn's FastAPI lifespan creates one shared `SQLiteCardCatalog`, the fuzzy
provider, one local agent search tool, an optional secret-backed OpenRouter
client, the agentic service/session store, and JSONL trace writers. Only the
separate `catalog:sync` command performs Scryfall bulk network access.

## Backend Modules

### `config.py`

`Settings` is the single runtime configuration model. Non-secret title-match
values load from root `config.yaml`; environment variables and `.env` can
override them. Origins and URLs are validated before startup.

### `domain/cards.py`

Strict provider-neutral Pydantic models for:

- Card faces, images, prices, and selected printings.
- Structured search filters and queries.
- Search pages, strategies, scores, and debug summaries.

`extra="forbid"` is deliberate. A public contract addition must be intentional
and reflected in the frontend runtime validator.

### `domain/agentic_search.py`

Strict contracts for the active progressive agentic-search phase:
all-optional local tool fields, exact Oracle-text conditions, merged mana
filters, a reserved disabled semantic field, candidate evidence, final ranked
IDs, and the versioned internal audit trace. The public debug summary projects
it into the seven valuable agent steps. `AgenticCardSearchRequest` and the
additional page metadata form the public progressive HTTP contract.

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
POST /api/v1/cards/search/agentic
GET /api/v1/openapi.json
```

### `providers/cards.py`

Provider protocol plus application-level provider exceptions. Routes and
search orchestration depend on this boundary.

### `providers/scryfall.py`

Owns Scryfall card-object wire models, validation, domain mapping, and the
provider-neutral title-similarity function.

Scryfall-specific response objects must not cross this module boundary.

### `providers/openrouter.py`

Secret-safe async boundary for direct OpenRouter chat completions. Transport
errors retain debug evidence without exposing credentials through public
errors. In debug mode, an agentic `503` carries the sanitized partial trace so
the drawer can show completed, failed, and skipped steps instead of discarding
the evidence.

### `card_catalog.py`

Discovers and streams Scryfall `default_cards`, builds temporary SQLite tables
for all paper printings and canonical Oracle cards, validates the result, and
atomically installs it. `SQLiteCardCatalog` reloads after a swapped file's
modification time changes.

### `search.py`

Owns:

- The one fuzzy-title search operation.
- Complete-catalog fuzzy ranking without a score threshold.
- The stricter preview-confidence score and active agentic handoff decision.
- Local color, mana-value, and EUR filtering.
- Simple numbered pagination after filters.
- Score-ordered card results and trace evidence.

### `search_debug.py`

Builds one structured trace per search and appends complete JSON objects as
JSONL lines.

### `agentic_search.py`

Non-network guards for local-tool result limits and final candidate-subset
ranking. These prevent empty unconstrained tool requests, invented IDs, and
configured-bound violations while allowing irrelevant candidates to be
omitted.

### `agentic_card_search.py`

Executes local structured search, the two-call OpenRouter conversation with one
intervening tool, temporary numeric candidate IDs, relevant-subset validation,
debug adaptation, cached ranked batches, canonical continuation exclusions,
and user-triggered session expansion.

### `agentic_search_debug.py`

Builds and validates complete agent traces, recursively redacts secrets, and
writes untruncated schema-version-2 records as JSONL.

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

Builds fuzzy GET and agentic POST requests, performs fetch calls, maps public
API errors, and validates the complete response at runtime. TypeScript types
alone are not treated as a network boundary.

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

Human-readable projection of the title matcher, ranked candidates, aliases,
scores, and filter outcomes.

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

- Missing, incompatible, or unreadable local catalog becomes HTTP 503 with
  `card_search_unavailable`.
- Invalid min/max pairs become HTTP 422.
- An empty catalog or page beyond its end returns an empty successful page.
- Disabled/full `localStorage` does not make the active deck unusable; current
  memory state continues.

## Current Versus Target Architecture

Current:

```text
Browser localStorage owns decks
FastAPI owns card discovery
Local SQLite owns search reads
Scryfall owns authoritative bulk data and remote images
```

Target:

```text
React UI and agent
  -> typed backend deck/search services
  -> SQLite deck store and derived Scryfall catalog
```

The migration must preserve browser-local libraries and must not allow the
future agent to bypass deck validation or mutation history.
