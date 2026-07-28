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
| Fuzzy title scores and traces | Shipped |
| Browser-local deck library and undo | Shipped |
| Custom groups and derived card types | Shipped |
| Color-identity and singleton warnings | Partial validation |
| Backend deck persistence | Not implemented |
| Local SQLite card catalog | Shipped |
| Import/export and analytics | Not implemented |
| Progressive one-tool agentic card search | Shipped |
| Agent chat and deck tools | Not implemented |

Read [`docs/implementation-status.md`](docs/implementation-status.md) before
starting feature work. It is the canonical boundary between shipped, partial,
and planned behavior.

## Experience

The application currently supports:

- Create, switch, and inline-rename local Commander decks.
- Use commander art as the deck thumbnail.
- Search exact, partial, segmented, and misspelled card titles through one
  fuzzy workflow.
- Continue weak-title and natural-language queries through one bounded agent
  tool call and a structured final ranking.
- Inspect coverage-aware title-confidence percentages beneath results in debug
  mode.
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

- There is no persistent search field. **Add cards** opens the focused search
  popup and is the single add workflow.
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
npm run catalog:sync
```

Title search works without an API key. Natural-language agentic search requires
`OPENROUTER_API_KEY` in `.env`.

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
  |- local SQLite card catalog
  |- uncapped RapidFuzz title scoring and local filters
  |- append-only search diagnostics
  |
  +--> Scryfall default_cards (refresh command only)
```

Current ownership is important:

- The frontend owns decks in `localStorage`.
- FastAPI owns card discovery only.
- Scryfall is the authoritative source for catalog refreshes and card images.
- The derived SQLite card catalog owns normal search reads.
- SQLite deck storage remains target architecture, not current implementation.

See [`docs/architecture.md`](docs/architecture.md) for module ownership,
contracts, data identities, failure behavior, and the migration target.

## Search

Every query uses one local fuzzy card-title matcher. It compares the normalized
input against the SQLite catalog with RapidFuzz `WRatio`, ranks every canonical
card without a score threshold or candidate cap, applies local filters, and
returns the requested 12-card page. **Load more** requests the next numbered
page. Normal search makes no Scryfall request.

For example, `forest` returns Forest first at 100%, followed by partial-title
matches such as Forest Bear and Misty Rainforest at about 90%. A typo such as
`galta` matches Ghalta titles at about 91%.

The values live in [`config.yaml`](config.yaml):

```yaml
search:
  title_match:
    page_size: 12
```

The full scoring contract is in [`docs/search.md`](docs/search.md) and
[`ADR 0007`](docs/decisions/0007-single-fuzzy-title-search.md).

The progressive agentic phase is active. It keeps confident title matches
visible, shows an animated ranking state, calls exactly one structured local
catalog tool when the first page is under-filled, and ranks only known
candidate IDs. Fuzzy previews are selectable before the tool call and include
mana, type, power/toughness, Oracle text, and EUR price. Tool candidates receive
later temporary IDs (`1`, `2`, `3`, and so on), exact Oracle-card duplicates
reuse the preview ID, and the model may omit irrelevant results. See
[`ADR 0009`](docs/decisions/0009-progressive-one-tool-agentic-search.md).

## Search Debugging

Open Search settings and enable **Search debug log**. The browser stores the
preference locally.

The inline trace viewer exposes:

- The title-confidence percentage beneath each returned card.
- The matching algorithm, catalog count, filtered count, and page range.
- Matched aliases, original ranks, WRatio scores, and title confidence for the
  current page.
- A chronological seven-step agent trace showing only system prompt, user input
  prompt, thinking, tool call, tool response, final thinking, and output
  response.
- The exact compact tool message sent to the model alongside the untouched raw
  tool JSON.

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

Normal search behavior is configured in `config.yaml`; `.env` remains for
runtime and debug overrides.

## Development Commands

```bash
npm run setup
npm run catalog:sync
npm run dev
npm test
npm run build
npm run test:e2e
npm run test:smoke
```

Focused checks:

```bash
uv --directory backend run pytest
uv --directory backend run ruff check src tests
npm test --prefix frontend
npm run build --prefix frontend
```

`npm test` runs 48 backend tests, 26 frontend tests, and the paired-process
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
    search.py          Fuzzy title matching
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
- No rules-text or semantic search index beyond the local title catalog.
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

This is a private personal repository. Do not add public accounts, hosted
collaboration, tracking, or deployment infrastructure unless the product scope
changes explicitly.
