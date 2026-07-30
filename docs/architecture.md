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
  | - local Commander, deck-identity, type, subtype, tag, color, mana, and price filters
  | - debug tracing
  |
  +--> local-data/cards.sqlite3
  +--> local-data/card-semantic.sqlite3
  |
  | blank-query browse with one commander and EDHREC enabled
  +--> EdhrecCommanderService
       |-- fresh 30-day cache read or one commander-page fetch
       |-- Scryfall printing ID -> local Oracle ID normalization
       `--> local-data/card-edhrec.sqlite3 (raw JSON + normalized rows)
  |
  | when fewer than six titles clear preview confidence
  v
AgenticCardSearchService
  |-- OpenRouter initial tool selection
  |-- exactly one structured local-catalog tool call
  |     `-- hard filters -> local semantic sort -> candidate limit
  |-- OpenRouter structured relevant-subset ranking
  `-- in-memory ranked batches and user-triggered Load more continuations
  |
  +--> local-data/search-debug.jsonl (debug only)

Explicit refresh:

Scryfall default_cards -> streaming importer -> atomic cards.sqlite3 swap
cards.sqlite3 + optional bounded Tagger concepts
  -> document v2 -> FastEmbed ONNX model -> atomic semantic sidecar swap

Explicit enrichment acquisition:

Scryfall Oracle-tag bulk + Tagger relationship edges
  -> resumable importer -> atomic card-tagger.sqlite3 swap
                           -> lazy card-detail enrichment
                           -> explicit immutable tag filters
                           -> bounded document-v2 gameplay concepts
                              -> atomic semantic sidecar refresh
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

Uvicorn's FastAPI lifespan creates one shared `SQLiteCardCatalog`, its
`SemanticCardIndex`, the fuzzy provider, one local agent search tool, an
optional secret-backed OpenRouter client, the agentic service/session store,
the read-only Tagger sidecar adapter, the on-demand EDHREC commander service,
and JSONL trace writers. Only the separate `catalog:sync` command performs
Scryfall card-catalog network access.

The separate `tagger:sync` command acquires community-maintained Oracle-tag
memberships from Scryfall's bulk tag payload and card relationships from
Tagger. FastAPI never runs that importer and normal search does not contact
either source. Card details and explicitly selected tag filters read only the
installed local sidecar.

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
all-optional local tool fields, merged mana filters, top-level non-filtering
`semantic_sort`, candidate evidence, final ranked IDs, and the versioned
internal audit trace. Rules text informs the semantic index and final ranking
context but is deliberately not an exact tool filter. Commander format and
legality are runtime-owned and absent from this model-editable contract. The
public debug summary projects the audit trace into the seven valuable agent steps.
`AgenticCardSearchRequest` and the additional page metadata form the public
progressive HTTP contract.

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
GET /api/v1/cards/tags/search
GET /api/v1/cards/subtypes/search
GET /api/v1/cards/{oracle_id}
GET /api/v1/cards/{oracle_id}/enrichment
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

### `providers/tagger.py`

Owns Scryfall's read-only Oracle-tag bulk request plus Tagger's website GraphQL
relationship request, session/CSRF handling, wire models, request pacing, and
bounded retry behavior. Both interfaces are undocumented, so their response
models do not cross the provider boundary.

### `providers/edhrec.py`

Owns the undocumented EDHREC commander-page JSON wire shape, response limits,
validation, deduplication, and commander-name slug normalization. Provider
objects do not cross this boundary.

### `card_catalog.py`

Discovers and streams Scryfall `default_cards`, builds temporary SQLite tables
for all paper printings and canonical Oracle cards, validates the result, and
atomically installs it. `SQLiteCardCatalog` reloads after a swapped file's
modification time changes.

### `tagger_catalog.py`

Builds the optional Tagger enrichment sidecar. It imports all Oracle-tag
memberships and Oracle-card relationships, preserves normalized columns plus
raw JSON, checkpoints completed source phases/pages, validates SQLite
integrity, and atomically installs only a complete database. Its read-only
runtime adapter groups one Oracle card's tags, similar cards, references, and
inverse references for the lazy card-enrichment endpoint. It also fuzzy-ranks
tag names, resolves stable tag IDs, and intersects Oracle memberships for
explicit UI-selected tag filters. During explicit sync, it also exposes a
bounded, deduplicated gameplay-concept snapshot and source metadata for
semantic document v2. It does not supply semantic scores, relationship
expansion, or an agent-editable filter.

### `edhrec_catalog.py`

Owns the 30-day on-demand cache, complete raw commander/theme payloads,
advertised theme metadata, normalized Oracle-ID associations, and
inclusion/synergy evidence. It serializes fetches per commander/page and
converts every failure into an optional enhancement-unavailable outcome at the
search boundary.

### `search.py`

Owns:

- The one fuzzy-title search operation.
- Complete-catalog fuzzy ranking without a score threshold.
- The stricter preview-confidence score and active agentic handoff decision.
- Local Commander-legality, commander-identity, required card-type/subtype,
  tag, color, mana-value, and EUR filtering.
- Optional filter-only EDHREC inclusion ordering before pagination, with typed
  fallback status and unchanged local ordering on failure. Agentic
  inclusion/synergy ranking remains owned by `agentic_card_search.py`.
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
and user-triggered session expansion. Its narrow provider-boundary
compatibility layer preserves strict domain contracts while repairing known
serialization mistakes: nested JSON object strings, comma-joined alternative
types, and abstract type concepts that do not literally occur on printed type
lines. Type intersections remain `must_contain_all`; alternatives become
`must_contain_any`. It also discards stale runtime-owned `format` and
`legality` keys, which the interface owns exclusively.

That normalization layer is the only place a tool call is altered, and it
repairs schema shape rather than judging intent. Validated agent `types` and
`colors` reach local filtering unmodified; the system prompt, not runtime code,
teaches when a printed type belongs in a filter (ADR 0019). The validated
arguments and every repair remain visible in the debug trace.

### `agentic_search_debug.py`

Builds and validates complete agent traces, recursively redacts secrets, and
writes untruncated schema-version-2 records as JSONL.

### `semantic_index.py`

Renders title-resistant, face-aware gameplay document v2 with normalized
self-references, Magic-symbol explanations, and bounded deduplicated Tagger
concepts. It lazily loads the local FastEmbed ONNX model, atomically builds the
catalog-and-Tagger-coupled vector sidecar, embeds each intent, and cosine-scores
every hard-filtered candidate without a minimum threshold. Exact Tagger card
relationships remain a separate graph.

## Frontend Modules

### `domain/card.ts`

Provider-neutral card and search response types plus presentation-safe helpers.

### `domain/deck.ts`

Browser persistence schema, migration, group placement, primary card type, and
commander color-identity helpers. It also owns the current command-zone
composition policy: one copy of one commander by default, or two cards when
their Oracle text/type lines form a recognized legal Commander pairing.

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
- Confirmed deletion, safe last-deck replacement, and current-session restore.
- All deck mutations.
- Shared command-zone guards for adds, moves, and quantity changes.
- Per-deck current-session undo history.
- `localStorage` persistence.
- User-facing live-region announcements.

Components receive named operations rather than writing storage directly.

### `components/SearchDrawer.tsx`

Search query state, debounce, cancellation, filters, debug preference,
pagination, results, deck membership, pre-add legality warnings, fuzzy tag
selection, selected card preview, and the default-on single-commander EDHREC
enhancement control. An EDHREC-unavailable page renders an explicit fallback
alert while retaining its locally sorted cards. When a related card opens over
the drawer, the drawer remains mounted and inert so its query and results
survive.

### `components/SearchTracePanel.tsx`

Human-readable projection of the title matcher, ranked candidates, aliases,
scores, and filter outcomes.

### `components/DeckBoard.tsx`

Visual/list rendering, custom/type grouping, sorting, drag-and-drop,
keyboard-accessible movement, group creation, and deck-card actions.
`App.tsx` initializes the board in derived Card types mode; selecting Custom
enables editable placement and movement.

### `components/CardInspector.tsx`

Centered card-detail dialog content, Tagger enrichment, related-card
navigation, tag-to-search handoff, and custom-group movement controls. Movement
controls are available only in Custom grouping.

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
- Command-zone entries have quantity one.
- A second command-zone entry is accepted only for Partner, reciprocal Partner
  with, Friends forever, Choose a Background plus a legendary Background, or
  Doctor's companion plus a legendary Time Lord Doctor.
- A third command-zone entry is never accepted.
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

The optional EDHREC addition is represented on every page by `edhrec.status`,
`edhrec.source`, and `edhrec.message`. Request context uses
`commander_oracle_id`, `enhance_with_edhrec`, and optional `edhrec_theme`; it
does not enter the immutable hard-filter model or become agent-editable. The
separate commander-context endpoint exposes EDHREC's advertised theme slugs and
deck counts to the drawer.

## Error Boundaries

- Missing, incompatible, or unreadable local catalog becomes HTTP 503 with
  `card_search_unavailable`.
- Missing Tagger data becomes HTTP 503 only for enrichment or an explicit tag
  filter; untagged card search remains available.
- A missing, stale, or dimension-incompatible semantic sidecar becomes an
  agentic HTTP 503; fuzzy title search remains usable.
- A model response that still violates the normalized local-tool contract
  becomes HTTP 502 with `agentic_search_contract_error`, preserving the failed
  debug trace without claiming the provider is unavailable.
- EDHREC transport, payload, printing-to-Oracle mapping, or sidecar failures do
  not become search HTTP errors. Blank browsing returns local order and agentic
  search retains semantic order, with `edhrec.status="unavailable"` so the
  drawer can show the degraded state.
- Invalid min/max pairs become HTTP 422.
- An empty catalog or page beyond its end returns an empty successful page.
- Disabled/full `localStorage` does not make the active deck unusable; current
  memory state continues.

## Current Versus Target Architecture

Current:

```text
Browser localStorage owns decks
FastAPI owns card discovery
Local SQLite owns canonical search reads and cached enrichment
Scryfall owns authoritative bulk data and remote images
EDHREC optionally supplies cached commander/theme pages for browsing and agent ranking
```

Target:

```text
React UI and agent
  -> typed backend deck/search services
  -> SQLite deck store and derived Scryfall catalog
```

The migration must preserve browser-local libraries and must not allow the
future agent to bypass deck validation or mutation history.
