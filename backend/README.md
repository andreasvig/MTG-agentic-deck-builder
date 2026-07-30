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
- Local Commander, deck-identity, card-type, subtype, Tagger, color, mana, and
  price filters with simple numbered pages.
- Lazy local Tagger enrichment plus fuzzy tag lookup and canonical related-card
  resolution.
- On-demand EDHREC commander/theme-page caching, blank-query inclusion ranking,
  and agentic inclusion/synergy evidence, with a typed fallback status that
  never blocks local or semantic results.
- Structured debug traces and JSONL persistence.
- Strict local-tool, final-ranking, and complete agent-trace contracts.
- One-tool OpenRouter orchestration with only the structured local catalog
  search tool.
- Always-on local FastEmbed semantic sorting after hard filters, with no
  similarity cutoff.
- Model-facing tool results include each sorted card's normalized `0-1`
  semantic closeness.
- Natural model-facing prompts with temporary numeric candidate IDs and no
  image/provider URLs.
- Relevant-subset ranking that permits weak candidates to be omitted.
- Stored agent-ranked pagination that serves cached batches without a model
  call and starts one continuation round only after exhaustion. Later rounds
  receive every prior tool request and must deliberately broaden their search.

The backend does not currently own:

- Deck CRUD or persistence.
- Deck mutations.
- Complete Commander validation.
- Deck chat/tools.

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
GET http://127.0.0.1:43127/api/v1/cards/search?q=&commander_oracle_id={uuid}&enhance_with_edhrec=true
POST http://127.0.0.1:43127/api/v1/cards/search/agentic
GET http://127.0.0.1:43127/api/v1/cards/{oracle_id}/edhrec
GET http://127.0.0.1:43127/api/v1/cards/tags/search?q=mana
GET http://127.0.0.1:43127/api/v1/cards/subtypes/search?q=elf
GET http://127.0.0.1:43127/api/v1/cards/{oracle_id}
GET http://127.0.0.1:43127/api/v1/cards/{oracle_id}/enrichment
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
    tagger.py        Tagger acquisition wire models and transport
    edhrec.py        EDHREC commander-page transport and wire validation
  agentic_card_search.py  Tool execution, orchestration, sessions, paging
  agentic_search.py  Non-network request/response runtime guards
  agentic_search_debug.py  Full redacted agent-trace builder and JSONL writer
  card_catalog.py    Atomic bulk import and read-only SQLite catalog
  catalog_sync.py    Explicit catalog-refresh CLI
  config.py          YAML/environment settings and validation
  edhrec_catalog.py  Raw/normalized 30-day commander cache
  main.py            FastAPI construction and lifespan dependencies
  search.py          Local fuzzy ranking, filtering, and pagination
  search_debug.py    Trace construction and JSONL writes
  semantic_index.py  Atomic local vector index and cosine sorting
  tagger_catalog.py  Atomic Tagger sidecar and read-only queries
  tagger_sync.py     Explicit Tagger-refresh CLI
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
- Type conditions match literal printed type-line fragments. Use
  `must_contain_all` for genuine combinations such as Artifact Creature,
  `must_contain_any` for alternatives such as Instant or Sorcery, and omit
  types when the user requested only a broad gameplay role.
- The provider boundary may repair known serialization shorthands before
  strict validation, including comma-joined type alternatives, abstract type
  concepts, and nested objects encoded as JSON strings. The raw and normalized
  arguments remain visible in debug traces.
- Commander legality, commander identity, and selected tag filters are
  immutable interface constraints; the model cannot change them through its
  local tool.
- Tag filters read exact Oracle memberships. Separately, bounded and
  deduplicated Tagger concept names enter semantic document v2; exact card
  relationships remain outside the vectors.
- EDHREC is immutable request context, not a hard filter or separate agent
  tool. It may order blank results or supply inclusion/synergy to the local
  agent tool. Provider/cache failure returns local or semantic order with a
  typed `unavailable` status.
- Search debug records candidates, WRatio, title confidence, and filter
  outcomes, not secret headers.

A `CardSearchPage` change requires synchronized frontend interface, runtime
validation, test fixtures, and E2E fixture updates.

## Configuration

Title matching loads from root `config.yaml`:

```yaml
search:
  title_match:
    page_size: 6
    preview_min_confidence: 0.75
  semantic_sort:
    model: BAAI/bge-small-en-v1.5
    index_path: local-data/card-semantic.sqlite3
  agentic:
    enabled: true

edhrec:
  enabled: true
  base_url: https://json.edhrec.com
  database_path: local-data/card-edhrec.sqlite3
  timeout_seconds: 20
  refresh_after_days: 30
```

The EDHREC sidecar stores complete source commander/theme documents, advertised
theme metadata, and normalized Oracle-ID associations. It is populated only
after an enhanced cache miss, is fresh for 30 days, and has no full-sync
command. Typed agentic requests may use it; fuzzy title ranking itself does not.

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
| `MTG_TAGGER__DATABASE_PATH` | `local-data/card-tagger.sqlite3` |
| `MTG_EDHREC__DATABASE_PATH` | `local-data/card-edhrec.sqlite3` |
| `MTG_SEARCH__TITLE_MATCH__PAGE_SIZE` | `6` |
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
- `test_title_search.py`: uncapped ordering, paging, filters, EDHREC
  ordering/fallback, and debug records.
- `test_agentic_search_contracts.py`: tool/output guards and complete traces.
- `test_agentic_card_search.py`: tool execution, orchestration, alias-aware
  result confidence, and sessions.
- `test_tagger_catalog.py`: resumable import, enrichment, fuzzy tags, and
  membership intersection plus bounded semantic-concept selection.
- `test_semantic_index.py`: atomic vectors, v2 rendering, Tagger dependency
  invalidation, and no-cutoff cosine scoring.
- `test_card_enrichment.py`: enrichment, tag lookup, and related-card routes.
- `test_edhrec_catalog.py`: provider parsing, Oracle normalization, raw cache,
  and 30-day freshness.
- `test_health.py`: health, CORS, settings.
- `test_deck_models.py`: backend deck contract validation.

Committed tests use small in-memory bulk fixtures and remain independent from
live provider queries.

## Extension Notes

### Refreshing Card Data

- Run `npm run catalog:sync` from the repository root.
- The command skips each current artifact independently and ensures both the
  Scryfall-derived catalog and its local semantic sidecar. Installed Tagger
  concepts are included in the v2 documents.
- Use `npm run catalog:sync -- --force` only when a rebuild is required.
- `npm run tagger:sync` also checks the semantic index after installing its
  independently refreshed Tagger snapshot.
- Keep bulk transport and Scryfall wire details outside routes and search.
- The first sync downloads the configured FastEmbed ONNX model; later syncs
  reuse its local cache.

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
