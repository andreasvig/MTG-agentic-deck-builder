# Development Guide

## Prerequisites

- Node.js 22.12 or newer.
- npm.
- `uv`.
- Google Chrome for the configured Playwright channel.

Docker is not part of the current local workflow.

## Initial Setup

```bash
npm run setup
cp .env.example .env
npm run catalog:sync
```

`npm run setup` synchronizes the backend environment, including development
dependencies, and installs frontend packages. Search requires no API key.
The catalog command downloads Scryfall's current compressed `default_cards`
export and atomically installs the local search database.

## Run

```bash
npm run dev
```

```text
Frontend  http://127.0.0.1:41737
Backend   http://127.0.0.1:43127
Health    http://127.0.0.1:43127/api/v1/health
OpenAPI   http://127.0.0.1:43127/api/v1/openapi.json
```

The runner requires both default ports to be free.

## Root Commands

| Command | Purpose |
| --- | --- |
| `npm run setup` | Install backend and frontend dependencies |
| `npm run catalog:sync` | Refresh the local Scryfall card catalog |
| `npm run dev` | Start Vite and reload-enabled Uvicorn |
| `npm test` | Backend tests, frontend tests, and process smoke test |
| `npm run build` | Type-check and build the frontend |
| `npm run test:e2e` | Run the Chrome Playwright workflows |
| `npm run test:smoke` | Verify alternate-port startup and clean shutdown |

## Focused Commands

```bash
uv --directory backend run pytest
uv --directory backend run pytest tests/test_title_search.py
uv --directory backend run ruff check src tests
npm test --prefix frontend
npm run build --prefix frontend
npx playwright test e2e/deck-builder.spec.ts
```

Run focused checks while iterating, then the root validation appropriate to the
change.

## Environment Variables

### Server

| Variable | Default | Notes |
| --- | --- | --- |
| `MTG_HOST` | `127.0.0.1` | Backend bind host |
| `MTG_PORT` | `43127` | Backend port |
| `MTG_FRONTEND_ORIGIN` | `http://127.0.0.1:41737` | CORS origin and Vite address |
| `VITE_API_BASE_URL` | Derived from backend | Browser API base |

The root runner supports local HTTP origins only. Keep unusual ports to avoid
colliding with common development tools.

### Scryfall

| Variable | Default |
| --- | --- |
| `MTG_SCRYFALL_BASE_URL` | `https://api.scryfall.com` |
| `MTG_SCRYFALL_USER_AGENT` | Project/version/repository identifier |
| `MTG_SCRYFALL_BULK_TIMEOUT_SECONDS` | `900` |
| `MTG_CARD_CATALOG_PATH` | `local-data/cards.sqlite3` |

Do not remove the identifying user agent. Normal search does not call
Scryfall; these settings belong to the explicit bulk refresh command.

### Search

Non-secret matching values live in `config.yaml`:

```yaml
search:
  title_match:
    page_size: 6
```

Temporary environment overrides use nested names:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `MTG_SEARCH__TITLE_MATCH__PAGE_SIZE` | `6` | Cards returned per page and confident fuzzy hits required to skip agentic search |
| `MTG_SEARCH_DEBUG_ENABLED` | `false` | Trace every request by default |
| `MTG_SEARCH_DEBUG_LOG_PATH` | `local-data/search-debug.jsonl` | JSONL output |
| `MTG_SEARCH_DEBUG_RESULT_LIMIT` | `25` | Cards retained per snapshot |

## Test Matrix

| Change | Minimum checks |
| --- | --- |
| Backend model or route | pytest and Ruff |
| Scryfall mapping, importer, or search route | pytest, Ruff, local sanity query |
| Frontend domain or API | Vitest and production build |
| Deck mutation or migration | domain/hook tests and E2E |
| Search result or trace UI | component tests, build, E2E |
| Responsive interaction | E2E plus desktop/mobile screenshot inspection |
| Root runner | smoke test |
| Environment setting | configuration test and `.env.example` |
| Public behavior | changelog and relevant docs |

`npm run test:e2e` starts a server on the default ports with
`reuseExistingServer=false`. Stop an active development runner before invoking
it. `npm test` can run while the default ports are occupied because the smoke
test uses `41738` and `43128`.

## Common Change Workflows

### Add A Search Response Field

1. Add and validate it in `domain/cards.py`.
2. Populate it in the search/provider layer.
3. Assert JSON behavior in backend tests.
4. Add it to `frontend/src/domain/card.ts`.
5. Validate it in `frontend/src/lib/api.ts`.
6. Update frontend and E2E fixtures.
7. Render or consume it.
8. Add component and browser coverage.
9. Update `docs/search.md`.

### Add A Deck Mutation

Current phase:

1. Add a named operation in `useDeck.ts`.
2. Return a useful accessibility announcement.
3. Ensure mutation history receives exactly one prior deck snapshot.
4. Preserve immutable updates.
5. Update persistence migration when schema changes.
6. Add focused hook/domain coverage.
7. Exercise the workflow in Playwright.

Future backend phase:

1. Define the typed domain command first.
2. Execute it through the shared deck service.
3. Let UI and agent call the same service.
4. Persist only after validation succeeds.

### Change A Product Invariant

1. Read `AGENTS.md`.
2. Update or supersede the relevant ADR.
3. Update implementation and tests.
4. Correct UX benchmark, status ledger, plan, README, and changelog as needed.

## Local Diagnostics

View all search records as a JSON array:

```bash
jq -s '.' local-data/search-debug.jsonl
```

Inspect the last trace:

```bash
tail -1 local-data/search-debug.jsonl | jq '.'
```

Inspect only routing and candidate scores:

```bash
tail -1 local-data/search-debug.jsonl |
  jq '{request, decision, fuzzy: .stages[-1].details.fuzzy_candidates}'
```

`local-data/`, `test-results/`, `frontend/dist/`, caches, and environment files
are ignored and must not be committed.

## Troubleshooting

### Port In Use

```bash
lsof -nP -iTCP:41737 -sTCP:LISTEN
lsof -nP -iTCP:43127 -sTCP:LISTEN
```

Stop the existing runner or change all related environment URLs consistently.

### Search Returns 503

The local catalog is missing or unreadable. Run `npm run catalog:sync`, then
retry the search. A successful refresh is visible to the running backend after
the atomic file swap.

### Frontend Reports Malformed Search Data

The frontend runtime validator rejected the response. Compare
`CardSearchPage` in the backend and frontend, then update fixtures.

### E2E Cannot Start

Confirm default ports are free and Chrome is installed. Playwright is configured
with `channel: "chrome"`.

## Pre-Commit Checklist

```bash
git diff --check
uv --directory backend run ruff check src tests
npm test
npm run build
npm run test:e2e
```

Use judgment for documentation-only changes, but always validate documented
commands and links.
