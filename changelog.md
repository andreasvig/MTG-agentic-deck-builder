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
