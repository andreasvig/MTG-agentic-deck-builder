# Backend

FastAPI card-discovery service for MTG Agentic Deck Builder.

Read the repository-level [`AGENTS.md`](../AGENTS.md) and
[`docs/architecture.md`](../docs/architecture.md) before changing boundaries.
Search behavior is specified in [`docs/search.md`](../docs/search.md).

## Current Responsibility

The backend currently owns:

- Health and card-search HTTP APIs.
- Provider-neutral card/search contracts.
- Scryfall transport and normalization.
- Exact, contained, fuzzy, syntax, and intent search routing.
- Structured filters.
- Local embedding ranking.
- Optional OpenRouter reranking.
- Structured debug traces and JSONL persistence.

The backend does not currently own:

- Deck CRUD or persistence.
- Deck mutations.
- Complete Commander validation.
- SQLite card catalog synchronization.
- Agent tools or chat.

## Run

Normally start both packages from the repository root:

```bash
npm run dev
```

Backend-only:

```bash
uv --directory backend sync --all-groups
uv --directory backend run uvicorn mtg_deck_builder.main:app \
  --reload --host 127.0.0.1 --port 43127
```

Endpoints:

```text
GET http://127.0.0.1:43127/api/v1/health
GET http://127.0.0.1:43127/api/v1/cards/search?q=forest
GET http://127.0.0.1:43127/api/v1/openapi.json
```

## Package Map

```text
src/mtg_deck_builder/
  api/
    router.py        API prefix, health, router composition
    cards.py         Query translation and public errors
  domain/
    cards.py         Strict card/search contracts
    deck.py          Early deck contracts, not routed yet
  providers/
    cards.py         Provider protocol and exceptions
    scryfall.py      Scryfall wire models, mapping, catalog, scores
  config.py          Environment settings and validation
  main.py            FastAPI construction and lifespan dependencies
  search.py          Route selection, filters, rankers
  search_debug.py    Trace construction and JSONL writes
```

## Contract Rules

- Public models inherit strict `extra="forbid"` behavior.
- Provider wire models remain private to `providers/scryfall.py`.
- Routes depend on `CardSearchProvider`, not a concrete HTTP client.
- `oracle_id` and `scryfall_id` are distinct and both required.
- Non-fatal ranker failure returns prior ordering with a warning.
- Search debug records bodies, not secret headers.

A `CardSearchPage` change requires synchronized frontend interface, runtime
validation, test fixtures, and E2E fixture updates.

## Configuration

Settings load from environment variables and `.env` using the `MTG_` prefix.

| Variable | Default |
| --- | --- |
| `MTG_HOST` | `127.0.0.1` |
| `MTG_PORT` | `43127` |
| `MTG_FRONTEND_ORIGIN` | `http://127.0.0.1:41737` |
| `MTG_SCRYFALL_BASE_URL` | `https://api.scryfall.com` |
| `MTG_SCRYFALL_TIMEOUT_SECONDS` | `10` |
| `MTG_EMBEDDING_MODEL` | `BAAI/bge-small-en-v1.5` |
| `MTG_FUZZY_NAME_CANDIDATE_LIMIT` | `12` |
| `MTG_FUZZY_NAME_MIN_SCORE` | `0.45` |
| `MTG_SEARCH_DEBUG_ENABLED` | `false` |
| `MTG_SEARCH_DEBUG_LOG_PATH` | `local-data/search-debug.jsonl` |
| `MTG_SEARCH_DEBUG_RESULT_LIMIT` | `25` |
| `MTG_OPENROUTER_MODEL` | `google/gemini-3.5-flash-lite` |
| `MTG_OPENROUTER_PROVIDER` | unset |
| `MTG_OPENROUTER_REASONING_EFFORT` | `minimal` |
| `MTG_OPENROUTER_MAX_TOKENS` | `900` |

`OPENROUTER_API_KEY` or `MTG_OPENROUTER_API_KEY` enables the optional final
intent reranker.

## Tests

```bash
uv --directory backend run pytest
uv --directory backend run ruff check src tests
```

Test ownership:

- `test_card_search.py`: Scryfall mapping, transport errors, HTTP contract.
- `test_hybrid_search.py`: routing, filters, scores, ranking, debug records.
- `test_health.py`: health, CORS, settings.
- `test_deck_models.py`: backend deck contract validation.

Provider tests use `httpx2.MockTransport`. Keep committed tests deterministic
and independent from live Scryfall or OpenRouter.

## Extension Notes

### New Provider

- Implement the provider protocol.
- Map wire data into the strict domain contract.
- Translate transport failures into application provider exceptions.
- Keep rate, retry, and authentication behavior inside the provider.

### New Search Layer

- Define precedence before implementation.
- Apply structured filters.
- Define confidence semantics.
- Add trace details and failure behavior.
- Add deterministic routing tests.
- Update `docs/search.md` and ADR 0003.

### Future Deck API

Do not expose the existing backend deck models directly as CRUD before defining:

- Repository ownership.
- Typed mutation commands.
- Validation result model.
- Browser-local import migration.
- Atomic history/undo semantics.
- Agent patch compatibility.

ADR 0006 records the proposed mutation boundary.
