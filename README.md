# MTG Agentic Deck Builder

A private, local-first Commander deck builder with a React frontend and a
FastAPI card-discovery backend. The shipped product is a fast manual deck
editor. A later Pydantic AI assistant will inspect decks, explain suggestions,
and propose confirmed, undoable edits through the same domain operations as the
UI.

## Project Status

The first manual editing slice is usable and tested.

| Area | Status |
| --- | --- |
| Card search and filters | Shipped |
| Exact/fuzzy score visibility and traces | Shipped |
| Browser-local deck library and undo | Shipped |
| Custom groups and derived card types | Shipped |
| Color-identity and singleton warnings | Partial validation |
| Backend deck persistence | Not implemented |
| Local SQLite card catalog | Not implemented |
| Import/export and analytics | Not implemented |
| Agent chat and deck tools | Not implemented |

Read [`docs/implementation-status.md`](docs/implementation-status.md) before
starting feature work. It is the canonical boundary between shipped, partial,
and planned behavior.

## Experience

The application currently supports:

- Create, switch, and inline-rename local Commander decks.
- Use commander art as the deck thumbnail.
- Search live Scryfall data from one detailed card-search workflow.
- Enter explicit Scryfall syntax or common Commander intent.
- Recover misspelled card names and inspect exact/fuzzy name scores.
- Filter by color identity, colorless, mana value, and Scryfall EUR estimate.
- Add cards into Command zone, Not assigned, or user-created custom groups.
- Drag cards between custom groups or onto Add custom group.
- Switch between Custom and derived Card types grouping.
- Switch between visual stacks and a dense list.
- Sort by name, mana value, or price.
- Edit quantities, remove cards, and undo the last 30 current-session changes.
- See singleton and commander color-identity warnings.
- Inspect rules, printing, finish availability, legality, and price in a modal.
- Use a purpose-built desktop shell and mobile deck-action toolbar.

Deliberate UX choices:

- There is no separate Quick Add; Card search is the single add workflow.
- There is no standalone maybeboard in the active editor.
- Card-type grouping is derived and cannot be edited.
- The right side is not used for a permanent card inspector; it is reserved for
  the later deck agent.

These decisions are recorded in
[`ADR 0005`](docs/decisions/0005-editor-grouping-and-inspection.md).

## Quick Start

### Prerequisites

- Node.js 22.12 or newer.
- npm.
- [`uv`](https://docs.astral.sh/uv/).
- Google Chrome for Playwright E2E tests.

Docker is not required.

### Install

```bash
git clone git@github.com:andreasvig/MTG-agentic-deck-builder.git
cd MTG-agentic-deck-builder
npm run setup
cp .env.example .env
```

No API key is required for manual editing, exact/fuzzy search, Scryfall syntax,
or local embedding ranking.

### Run

```bash
npm run dev
```

- Frontend: <http://127.0.0.1:41737>
- Backend health: <http://127.0.0.1:43127/api/v1/health>
- OpenAPI: <http://127.0.0.1:43127/api/v1/openapi.json>

The root runner checks that both uncommon ports are free and shuts down both
reload-enabled development processes on `Ctrl+C`.

## Architecture Snapshot

```text
React browser application
  |- deck library, mutations, undo, localStorage
  |- editor, search drawer, trace viewer, responsive shell
  |
  | HTTP JSON
  v
FastAPI
  |- strict provider-neutral contracts
  |- layered search routing and filters
  |- exact/fuzzy name scores
  |- local embedding ranker
  |- optional OpenRouter reranker
  |- append-only search diagnostics
  |
  +--> Scryfall
  +--> OpenRouter (optional)
```

Current ownership is important:

- The frontend owns decks in `localStorage`.
- FastAPI owns card discovery only.
- Scryfall is the authoritative card-data provider.
- SQLite deck storage and the derived local card catalog are target
  architecture, not current implementation.

See [`docs/architecture.md`](docs/architecture.md) for module ownership,
contracts, data identities, failure behavior, and the migration target.

## Search

One input supports four strategies:

1. Explicit Scryfall syntax.
2. Deterministic supported natural-language intent.
3. Exact full names plus every genuine name containing the query.
4. Multi-result fuzzy catalog ranking when no full exact name exists.

Examples:

```text
forest
galta
red card draw
cheap dinosaurs
things which let me untap my elves
t:instant id<=u mv<=2
```

Exact and fuzzy results include a normalized `0..1` name score. An exact
`forest` search ranks Forest at `1.000` and also returns names such as Forest
Bear and Misty Rainforest. A misspelling such as `galta` can return multiple
Ghalta candidates and show their raw fuzzy values.

Intent candidates are requested in EDHREC order, reranked locally with
`BAAI/bge-small-en-v1.5`, and optionally reranked through OpenRouter.

Exact, fuzzy, and explicit Scryfall syntax never call OpenRouter.

The complete routing and scoring contract is in
[`docs/search.md`](docs/search.md) and
[`ADR 0003`](docs/decisions/0003-layered-observable-search.md).

## Search Debugging

Open Search settings and enable **Search debug log**. The browser stores the
preference locally.

The inline trace viewer exposes:

- Route classification and final strategy.
- Layer timing and provider query.
- Input/output order and rank movement.
- Exact and fuzzy name scores.
- Fuzzy aliases, cutoff acceptance, and filter/return outcome.
- Local and LLM ranker configuration.
- Exact parsed and raw OpenRouter request/response bodies.

The backend also appends one complete JSON object per line:

```text
local-data/search-debug.jsonl
```

Read the complete log:

```bash
jq -s '.' local-data/search-debug.jsonl
```

Read the latest route and fuzzy evidence:

```bash
tail -1 local-data/search-debug.jsonl |
  jq '{request, decision, fuzzy: .stages[-1].details.fuzzy_candidates}'
```

Credentials and authorization headers are never written.

Default tuning:

```dotenv
MTG_SEARCH_DEBUG_ENABLED=false
MTG_SEARCH_DEBUG_LOG_PATH=local-data/search-debug.jsonl
MTG_SEARCH_DEBUG_RESULT_LIMIT=25
MTG_FUZZY_NAME_CANDIDATE_LIMIT=12
MTG_FUZZY_NAME_MIN_SCORE=0.45
```

The permissive fuzzy cutoff is intentional while real traces are evaluated.
Low-confidence fuzzy routing records an intent-candidate signal, but the
general LLM query-planner fallback is not implemented yet.

## Optional OpenRouter Reranking

Set an API key to enable the final intent-only reranking layer:

```dotenv
OPENROUTER_API_KEY=
MTG_OPENROUTER_MODEL=google/gemini-3.5-flash-lite
MTG_OPENROUTER_PROVIDER=
MTG_OPENROUTER_REASONING_EFFORT=minimal
MTG_OPENROUTER_MAX_TOKENS=900
```

The model, provider, reasoning effort, and token cap can be pinned
independently:

```dotenv
MTG_OPENROUTER_MODEL=openai/gpt-oss-120b
MTG_OPENROUTER_PROVIDER=Cerebras
MTG_OPENROUTER_REASONING_EFFORT=low
MTG_OPENROUTER_MAX_TOKENS=2200
```

Run the repeatable live comparison:

```bash
npm run benchmark:rerankers
```

Outputs are ignored under `local-data/`. The latest recorded methodology and
result is in
[`docs/search-reranker-benchmark-2026-07-23.md`](docs/search-reranker-benchmark-2026-07-23.md).

## Development Commands

```bash
npm run setup
npm run dev
npm test
npm run build
npm run test:e2e
npm run test:smoke
npm run benchmark:rerankers
```

Focused checks:

```bash
uv --directory backend run pytest
uv --directory backend run ruff check src tests
npm test --prefix frontend
npm run build --prefix frontend
```

`npm test` runs 45 backend tests, 24 frontend tests, and the paired-process
smoke test at the time of this documentation update. Test counts may grow; a
passing result matters more than preserving these exact numbers.

`npm run test:e2e` starts the app on the default ports and requires them to be
free. Stop a running development session first.

See [`docs/development.md`](docs/development.md) for the environment table,
test matrix, common change workflows, troubleshooting, and pre-commit checks.

## Project Layout

```text
AGENTS.md              Repository-specific agent instructions
backend/
  src/mtg_deck_builder/
    api/               HTTP translation
    domain/            Strict public/domain contracts
    providers/         Scryfall and provider boundaries
    config.py          Validated runtime settings
    main.py            FastAPI lifecycle and dependencies
    search.py          Routing and ranking
    search_debug.py    JSONL trace construction
  tests/               Backend contract and behavior tests
frontend/
  src/
    components/        Editor, search, dialogs, trace UI
    domain/            Card/deck contracts and migrations
    hooks/             Deck and health application state
    lib/               HTTP client and response validation
  public/              Static assets
e2e/                   Playwright workflows and fixtures
scripts/               Root process runner and smoke test
docs/
  decisions/           Architecture decision records
  architecture.md      Current runtime and module boundaries
  development.md       Commands and contributor workflows
  implementation-status.md
  search.md            Search technical contract
plan.md                Product scope and roadmap
changelog.md           Notable delivered changes
```

## Data Identity And Persistence

- `oracle_id` is gameplay identity.
- `scryfall_id` is selected-printing identity.
- Deck libraries use `manabase.deck-library.v2`.
- The previous `manabase.active-deck.v1` key is migration input only.
- Search debug preference uses `manabase.search-debug`.
- Command zone and Not assigned are permanent placement concepts.
- Unknown legacy and former maybeboard placement migrates to Not assigned.

The browser-local persistence decision and backend migration requirements are
recorded in
[`ADR 0004`](docs/decisions/0004-browser-local-deck-library.md).

## Current Limitations

- No backend deck API, SQLite persistence, or cloud synchronization.
- No complete Commander partner/background/companion validation.
- No persisted price history or true Cardmarket trend integration.
- No full printing/finish chooser.
- No local complete-card catalog or vector index.
- No plaintext import/export.
- No deck analytics.
- No agent chat, tools, or confirmed patch workflow.
- Search returns one representative printing per gameplay card.
- Scryfall images remain remote.

The recommended implementation order is maintained in
[`docs/implementation-status.md`](docs/implementation-status.md) and
[`plan.md`](plan.md).

## Agent And Contributor Handoff

Coding agents must read [`AGENTS.md`](AGENTS.md) before editing this repository.
It defines:

- Current boundaries and product invariants.
- Search and persistence traps.
- Required test tiers.
- Contract synchronization rules.
- Documentation and ADR expectations.
- Definition of done.

Decision history begins at
[`docs/decisions/README.md`](docs/decisions/README.md).

## Documentation

- [Documentation index](docs/README.md)
- [Implementation status](docs/implementation-status.md)
- [Current architecture](docs/architecture.md)
- [Development guide](docs/development.md)
- [Search system](docs/search.md)
- [Decision records](docs/decisions/README.md)
- [Product plan](plan.md)
- [Changelog](changelog.md)
- [Archidekt UX benchmark](docs/archidekt-ux-benchmark.md)
- [Reranker benchmark](docs/search-reranker-benchmark-2026-07-23.md)

This is a private personal repository. Do not add public accounts, hosted
collaboration, tracking, or deployment infrastructure unless the product scope
changes explicitly.
