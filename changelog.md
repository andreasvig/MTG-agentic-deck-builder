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
- Added Cardmarket trend prices and deck price totals to the MVP.
- Confirmed warning-preserving Rule Zero overrides.
- Deferred drag-and-drop, advanced imports, power scoring, and playtesting.
- Selected Pydantic AI for the later agent, with Gemini 3.6 Flash and Gemini
  3.5 Flash-Lite as candidates to evaluate.
- Defined planned agent tools for deck operations, Scryfall, Sonar web search,
  page fetching, and a permission-dependent EDHREC provider.

### Repository

- Initialized as a private personal GitHub repository.
