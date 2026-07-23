# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- Initial product and implementation plan.
- Proposed React, FastAPI, and SQLite architecture.
- Reserved uncommon local ports: `41737` for the frontend and `43127` for the
  backend.
- Defined a manual Commander deck-building MVP.
- Defined a later chat-agent phase with previewed, confirmable deck edits.
- Recorded Scryfall as the initial card-data provider.
- Deferred EDHREC integration until a permitted and stable access method is
  available.
- Expanded the deck model to cover all legal Commander configurations.
- Selected visual category columns with an optional compact list view.
- Added daily EUR price estimates and deck price totals to the MVP.
- Confirmed warning-preserving Rule Zero overrides.
- Deferred drag-and-drop, advanced imports, power scoring, and playtesting.
- Selected Pydantic AI for the later agent, with Gemini 3.6 Flash and Gemini
  3.5 Flash-Lite as candidates to evaluate.
- Defined planned agent tools for deck operations, Scryfall, Sonar web search,
  page fetching, and a permission-dependent EDHREC provider.
- Added a React, TypeScript, and Vite frontend scaffold with a responsive
  deck-building workspace, category-column and list views, an inspector, and a
  live backend connection indicator.
- Added a FastAPI backend scaffold with environment-based settings, restricted
  local CORS, and a typed `GET /api/v1/health` endpoint.
- Added matching Pydantic and TypeScript contracts for Commander decks, card
  references, card entries, and deck sections.
- Added a root development runner that checks the reserved ports, starts both
  services, and shuts them down together.
- Added backend and frontend test suites, deterministic dependency lockfiles,
  environment templates, and local setup documentation.
- Added an Archidekt UX benchmark based on official product documentation and
  Playwright inspection of desktop search, deck editing, and mobile navigation.
- Added a provider-neutral FastAPI card-search contract with a rate-conscious
  Scryfall implementation, typed reversible-card mapping, public-safe provider
  errors, pagination, and shared HTTP client lifecycle.
- Added a live card-search drawer with Scryfall syntax, debounced results,
  loading, empty, retry, pagination, card preview, pricing, and inline deck
  quantity controls.
- Added a persistent local Commander deck with search-based add, category
  placement, move, remove, quantity editing, singleton warnings, and 30-step
  undo.
- Added visual category stacks and a dense list with grouping, sorting, local
  filtering, category totals, deck totals, card art, and a detailed inspector.
- Added an intentionally compact desktop workspace and a purpose-built mobile
  layout with bottom actions, navigation/search/inspector drawers, focus
  containment, scroll locking, and inactive-background isolation.
- Added production-build checks, provider/API/domain/component tests, a paired
  development-server smoke test, and Playwright desktop/mobile workflows.
- Added a persistent local deck library with deck creation, switching, inline
  renaming, and commander-art thumbnails in the navigation rail.
- Added user-created custom groups with permanent Command zone and Not assigned
  groups plus an always-available new-group slot.
- Added accessible pointer, touch, and keyboard drag handles for moving cards
  between custom groups in visual and list views.
- Added drop-to-create custom groups, with group creation and card movement
  saved as one undoable operation.
- Added layered exact-name, fuzzy-name, natural-intent, and explicit Scryfall
  search routing.
- Added local semantic ranking with the public
  `BAAI/bge-small-en-v1.5` Hugging Face model.
- Added an optional OpenRouter reranker using
  `google/gemini-3.5-flash-lite` with minimal reasoning and a bounded
  card-metadata payload.
- Added search filters for can-include or exact color identity, colorless
  identity, minimum/maximum mana value, and minimum/maximum EUR estimate.
- Added typed search-strategy metadata, user-visible intent interpretation,
  reranker fallback warnings, and regression coverage across backend,
  frontend, and browser request flows.
- Added persistent in-app search debugging plus an environment default, with
  compact stage summaries and append-only JSONL traces containing provider
  queries, timings, complete raw and parsed LLM request/response bodies,
  before/after rankings, rank deltas, warnings, and final results.
- Added configurable OpenRouter provider, reasoning effort, and completion
  budget controls plus a repeatable four-model end-to-end reranker benchmark.
- Added an in-search trace explorer with numbered layers, provider queries,
  ranking changes, exact LLM prompts and responses, usage metadata, and
  expandable raw JSON, including for zero-result searches.
- Added multi-result name search: a full exact hit now returns every containing
  card name with the exact card ranked first, while typo search returns several
  ranked fuzzy candidates instead of one opaque correction.
- Added normalized name-match values to result cards and complete fuzzy
  candidate tables to debug traces, including matched aliases, cutoff
  acceptance, filter outcome, and configurable candidate/cutoff settings.
- Added a repository-level agent guide with product invariants, architecture
  boundaries, persistence and search traps, test expectations, and definition
  of done.
- Added current architecture, development, search, and implementation-status
  guides plus package-level backend and frontend handoffs.
- Added six architecture decision records covering the local runtime, Scryfall
  ownership, layered search, transitional browser persistence, editor
  information architecture, and proposed typed agent patches.
- Added a documentation index and explicit shipped/partial/planned vocabulary.

### Repository

- Initialized as a private personal GitHub repository.

### Changed

- Replaced the credential-dependent direct Cardmarket integration with
  Scryfall's daily EUR price estimates for the MVP.
- Added Cardmarket product links for manual price verification.
- Recorded MTGJSON's credential-free daily Cardmarket price data as a possible
  later provider when exact trend semantics justify the extra mapping work.
- Selected a hybrid card-data architecture: a local SQLite catalog synchronized
  from Scryfall `default_cards`, with Scryfall remaining authoritative.
- Set weekly gameplay-data synchronization, daily active-deck price refreshes,
  remote card images, and live Scryfall fallback behavior.
- Corrected the root development runner so Vite serves from the frontend
  workspace, and made the paired-server smoke test assert startup, health,
  frontend HTML, the local HTTP-origin guard, and clean shutdown.
- Clarified that the current card search returns a representative printing per
  gameplay card; full printing and finish selection remains a planned
  enhancement.
- Added color-identity warnings based on the union of known command-zone cards,
  shown in search results, deck cards, list rows, and the card inspector.
- Added a direct Ghalta plus Gamble regression workflow for illegal red color
  identity, including the pre-add warning and persisted deck warning.
- Consolidated quick add into the regular search workflow and removed the
  redundant top-right Search and Add actions.
- Renamed the grouping choices to Custom and Card types and removed the former
  fixed-category and maybeboard columns from the editor surface.
- Replaced fixed editable card categories with custom-group-only placement.
  Card-type grouping is now derived and does not expose move controls.
- Removed the standalone maybeboard from the active editor model; legacy
  maybeboard and fixed-category cards migrate safely into Not assigned.
- Capped sparse desktop group widths and hardened mobile group creation, card
  actions, deck-name editing, and touch targets against clipping.
- Replaced the persistent right-side deck inspector with a centered card-detail
  dialog on desktop and a contained full-screen dialog on mobile, leaving the
  workspace edge available for the later agent chat.
- Removed the local "Filter this deck" control so the toolbar has one clear card
  search path.
- Moved plain-query interpretation from the browser into the backend so every
  search client gets the same exact, fuzzy, and intent behavior.
- Ordered natural-intent candidate pools by EDHREC popularity and limited them
  to paper cards before local semantic ranking.
- Selected Gemini 3.5 Flash Lite at minimal reasoning as the default reranker
  after live comparison with Mercury 2, Cerebras Gemma 4 31B, and Cerebras
  GPT-OSS-120B.
- Extended fuzzy card-name recovery with a cached Scryfall name-catalog
  comparison when Scryfall's named-card endpoint cannot resolve a typo such as
  `galta`.
- Separated current implementation facts from target architecture throughout
  the README and plan so SQLite, backend deck services, full validation, and
  agent tooling are no longer implied to be shipped.
- Corrected the Archidekt UX benchmark to reflect the unified search flow,
  custom/type grouping, removed maybeboard and deck filter, modal inspection,
  and right-side reservation for agent chat.
