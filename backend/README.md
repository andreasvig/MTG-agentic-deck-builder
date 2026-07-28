# Backend

FastAPI card-discovery service for MTG Agentic Deck Builder.

Read the repository-level [`AGENTS.md`](../AGENTS.md) and
[`docs/architecture.md`](../docs/architecture.md) before changing boundaries.
Search behavior is specified in [`docs/search.md`](../docs/search.md).

## Current Responsibility

The backend currently owns:

- Health and card-search HTTP APIs.
- Provider-neutral card/search contracts.
- Atomic Scryfall bulk-data synchronization and wire normalization.
- Read-only local SQLite card catalog.
- One fuzzy title matcher for exact names, partial segments, and typos.
- Threshold-free RapidFuzz ranking with a YAML-configured display page size.
- Stricter preview confidence and immediate fuzzy preview selection.
- Local structured filters and simple numbered pages.
- Structured debug traces and JSONL persistence.
- Strict local-tool, final-ranking, and complete agent-trace contracts.
- One-tool OpenRouter orchestration with local and live Scryfall search tools.
- Natural model-facing prompts with temporary numeric candidate IDs and no
  image/provider URLs.
- Relevant-subset ranking that permits weak candidates to be omitted.
- Stored agent-ranked pagination that does not repeat model calls.

The backend does not currently own:

- Deck CRUD or persistence.
- Deck mutations.
- Complete Commander validation.
- Semantic embedding retrieval or deck chat/tools.

## Run

Normally start both packages from the repository root:

```bash
npm run dev
```

Backend-only:

```bash
uv --directory backend sync --all-groups
uv run --project backend python -m mtg_deck_builder.catalog_sync
uv --directory backend run uvicorn mtg_deck_builder.main:app \
  --reload --host 127.0.0.1 --port 43127
```

Endpoints:

```text
GET http://127.0.0.1:43127/api/v1/health
GET http://127.0.0.1:43127/api/v1/cards/search?q=forest
POST http://127.0.0.1:43127/api/v1/cards/search/agentic
GET http://127.0.0.1:43127/api/v1/openapi.json
```

## Package Map

```text
src/mtg_deck_builder/
  api/
    router.py        API prefix, health, router composition
    cards.py         Query translation and public errors
  domain/
    agentic_search.py  Strict local-tool, ranked-output, and trace contracts
    cards.py         Strict card/search contracts
    deck.py          Early deck contracts, not routed yet
  providers/
    cards.py         Provider protocol and exceptions
    openrouter.py    Secret-safe OpenRouter chat-completion transport
    scryfall.py      Scryfall wire models, mapping, and title scores
  agentic_card_search.py  Tool execution, orchestration, sessions, paging
  agentic_search.py  Non-network request/response runtime guards
  agentic_search_debug.py  Full redacted agent-trace builder and JSONL writer
  card_catalog.py    Atomic bulk import and read-only SQLite catalog
  catalog_sync.py    Explicit catalog-refresh CLI
  config.py          YAML/environment settings and validation
  main.py            FastAPI construction and lifespan dependencies
  search.py          Local fuzzy ranking, filtering, and pagination
  search_debug.py    Trace construction and JSONL writes
```

## Contract Rules

- Public models inherit strict `extra="forbid"` behavior.
- Provider wire models remain private to `providers/scryfall.py`.
- Routes depend on `CardSearchProvider`, not a concrete HTTP client.
- `oracle_id` and `scryfall_id` are distinct and both required.
- Exact titles must score `1.0` and appear before partial matches.
- Agentic result scores must use the same title aliases as fuzzy previews so a
  rerank cannot lower confidence merely by switching to the complete card
  title.
- Model-facing candidates use search-local integer IDs; public card UUIDs stay
  outside the prompt and are restored only after validation.
- Final rankings may omit irrelevant candidates but may not duplicate or
  invent candidate IDs.
- Search debug records candidates, WRatio, title confidence, and filter
  outcomes, not secret headers.

A `CardSearchPage` change requires synchronized frontend interface, runtime
validation, test fixtures, and E2E fixture updates.

## Configuration

Title matching loads from root `config.yaml`:

```yaml
search:
  title_match:
    page_size: 12
    preview_min_confidence: 0.75
  semantic:
    enabled: false
  agentic:
    enabled: true
```

Runtime and debug settings load from environment variables and `.env` using
the `MTG_` prefix.

| Variable | Default |
| --- | --- |
| `MTG_HOST` | `127.0.0.1` |
| `MTG_PORT` | `43127` |
| `MTG_FRONTEND_ORIGIN` | `http://127.0.0.1:41737` |
| `MTG_SCRYFALL_BASE_URL` | `https://api.scryfall.com` |
| `MTG_SCRYFALL_BULK_TIMEOUT_SECONDS` | `900` |
| `OPENROUTER_API_KEY` | unset |
| `MTG_CARD_CATALOG_PATH` | `local-data/cards.sqlite3` |
| `MTG_SEARCH__TITLE_MATCH__PAGE_SIZE` | `12` |
| `MTG_SEARCH__TITLE_MATCH__PREVIEW_MIN_CONFIDENCE` | `0.75` |
| `MTG_SEARCH_DEBUG_ENABLED` | `false` |
| `MTG_SEARCH_DEBUG_LOG_PATH` | `local-data/search-debug.jsonl` |
| `MTG_SEARCH_DEBUG_RESULT_LIMIT` | `25` |

## Tests

```bash
uv --directory backend run pytest
uv --directory backend run ruff check src tests
```

Test ownership:

- `test_card_catalog.py`: bulk import, atomic replacement, catalog loading.
- `test_card_search.py`: Scryfall mapping and HTTP contract.
- `test_title_search.py`: uncapped ordering, paging, filters, and debug records.
- `test_agentic_search_contracts.py`: tool/output guards and complete traces.
- `test_agentic_card_search.py`: tool execution, orchestration, alias-aware
  result confidence, and sessions.
- `test_health.py`: health, CORS, settings.
- `test_deck_models.py`: backend deck contract validation.

Committed tests use small in-memory bulk fixtures and remain independent from
live Scryfall.

## Extension Notes

### Refreshing Card Data

- Run `npm run catalog:sync` from the repository root.
- The command skips work when Scryfall's bulk timestamp is already installed.
- Use `npm run catalog:sync -- --force` only when a rebuild is required.
- Keep bulk transport and Scryfall wire details outside routes and search.

### Changing Search

- Preserve the local-first fuzzy title path and the ADR 0009 progressive
  one-tool boundary.
- Keep score semantics normalized to `0..1`.
- Apply every structured filter.
- Add trace details and deterministic tests.
- Update `config.yaml` and `docs/search.md` with any new tuning value.

### Future Deck API

Do not expose the existing backend deck models directly as CRUD before defining:

- Repository ownership.
- Typed mutation commands.
- Validation result model.
- Browser-local import migration.
- Atomic history/undo semantics.
- Agent patch compatibility.

ADR 0006 records the proposed mutation boundary.
