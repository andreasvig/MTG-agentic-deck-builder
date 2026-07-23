# Implementation Status

Last verified: 2026-07-23

This is the canonical feature ledger. It describes the repository as it exists,
not the intended end state.

## Shipped

### Runtime And Tooling

- React 19, TypeScript, Vite frontend.
- FastAPI and Pydantic backend.
- Root runner that starts both services and shuts down child processes cleanly.
- Uncommon loopback development ports `41737` and `43127`.
- Root setup, test, build, E2E, smoke, and reranker benchmark commands.
- CORS restricted to the configured frontend origin.
- Strict public API response validation in both backend and frontend.

### Card Search

- Live Scryfall card search behind a provider boundary.
- Explicit Scryfall syntax routing.
- Deterministic compilation of supported natural-language deck-building intent.
- Exact full-name and contained-name results with normalized per-card scores.
- Multi-result fuzzy name recovery from a process-cached Scryfall name catalog.
- Configurable fuzzy candidate limit and minimum score.
- Search filters for subset/exact color identity, colorless, mana-value range,
  and EUR-price range.
- Paper-card restriction for generated name and intent queries.
- EDHREC ordering for intent candidate pools.
- Local `BAAI/bge-small-en-v1.5` embedding ranking.
- Optional OpenRouter reranking with full structured request/response tracing.
- Loading, empty, invalid-query, provider-unavailable, retry, and pagination
  states.
- Per-result daily Scryfall EUR estimate and Cardmarket verification links.

### Search Diagnostics

- Browser-persisted Search debug log toggle.
- Environment-level debug default.
- Inline trace viewer with route, timings, provider queries, rank movement,
  exact LLM messages, raw JSON, and candidate tables.
- Append-only JSONL traces in `local-data/search-debug.jsonl`.
- Exact and fuzzy name scores in API results and logs.
- Fuzzy accepted/rejected status, alias, configured cutoff, and return outcome.
- Repeatable OpenRouter reranker benchmark with JSON and JSONL outputs.

### Deck Editor

- Browser-local deck library with active-deck switching.
- Create and inline rename deck.
- Commander-art thumbnails in the deck rail.
- Add, remove, and change printing quantity.
- Thirty-step per-deck undo history for current-session mutations.
- Permanent Command zone and Not assigned groups.
- User-created custom groups.
- Drop-to-create a custom group and move the card in one undoable action.
- Pointer, touch, and keyboard-accessible card movement between custom groups.
- Visual stacks and dense list views.
- Custom and derived Card types grouping modes.
- Alphabetic, mana-value, and price sorting.
- Deck, group, and selected-printing price totals.
- Singleton warnings.
- Commander color-identity union across known command-zone cards.
- Pre-add and persisted warnings for cards outside commander color identity.
- Centered card detail dialog on desktop and contained full-screen mobile view.
- Desktop navigation rail and mobile deck-action toolbar.
- Responsive search, deck-name editing, custom-group creation, and card actions.

### Verification

- Backend tests for contracts, provider mapping, errors, filters, routing,
  ranking, configuration, traces, and deck models.
- Frontend tests for API validation, deck migration, mutations, search, traces,
  and primary application workflows.
- Playwright workflows for desktop editing, search failure recovery, filters,
  color warnings, and mobile containment.
- Production frontend build.
- Paired-process startup and shutdown smoke test.

## Partial

### Commander Validation

Implemented:

- Color-identity warnings based on command-zone card details.
- Singleton warnings.
- Command-zone grouping and multiple command-zone entries.

Missing:

- Complete 100-card size validation.
- Commander eligibility and partner/background/companion compatibility rules.
- Banned/restricted format validation across the full deck.
- Quantity exceptions and Rule Zero overrides.
- Separate errors and warnings model.

### Price Tracking

Implemented:

- Current Scryfall daily EUR estimate on each selected printing.
- Deck and group estimate totals.
- Cardmarket verification links.

Missing:

- Persisted price observations and timestamps.
- Daily active-deck refresh job.
- Trend/history display.
- Foil/finish choice in the editor.
- MTGJSON Cardmarket trend integration.

### Search Intelligence

Implemented:

- Deterministic common-intent compiler.
- Local semantic reranking.
- Optional LLM reranking.

Missing:

- General LLM query planning for unsupported intent.
- Local vector or lexical index over the complete card corpus.
- An evaluation suite for routing thresholds and ranking quality.
- User-facing controls for routing cutoffs. Cutoffs are environment settings.
- A fallback from low fuzzy confidence into a general intent planner.

## Planned, Not Implemented

- SQLite card catalog synchronized from Scryfall `default_cards`.
- Atomic weekly card-data import and live miss fallback.
- Backend deck CRUD, persistence, and typed mutation API.
- Browser-local deck import/migration into backend storage.
- Plaintext import and export.
- Full printing and finish selection.
- Mana curve, color production, probability, and functional analytics.
- Multi-select and bulk editing.
- Named deck snapshots and persisted mutation history.
- Pydantic AI deck assistant.
- Agent chat interface in the reserved right workspace.
- Typed agent tools for inspect, validate, search, propose patch, confirm, apply,
  and undo.
- Sonar web search and fetch-page tools.
- A permitted, stable EDHREC provider.

## Deferred

- Accounts, cloud sync, collaboration, and public deck discovery.
- Collection ownership and buy/sell cart workflows.
- Direct third-party account synchronization.
- Full playtest simulation.
- Automated EDHREC scraping.

## Important Current Boundaries

- Deck state is not stored by FastAPI. It lives in frontend `localStorage`.
- Backend deck Pydantic models exist, but no route or service owns mutations.
- The SQLite catalog described in `plan.md` is a target architecture, not
  current code.
- Search is the only product API beyond health.
- The OpenRouter reranker runs only when a key is configured.
- Exact, fuzzy, and explicit syntax search do not call an LLM.
- Scryfall images remain remote.
- Search returns one representative printing per gameplay card.

## Recommended Next Implementation Order

1. Define backend deck repository and typed mutation service without changing
   the current UI behavior.
2. Add browser-local library import and migration into that service.
3. Implement complete Commander validation against shared domain models.
4. Add atomic local Scryfall catalog synchronization and indexed search.
5. Add plaintext import/export and full printing selection.
6. Introduce agent patch schemas and confirmation flow before building chat.
