# Repository Agent Guide

This file applies to the entire repository. It is the operational contract for
coding agents and human contributors working on MTG Agentic Deck Builder.

## Start Here

Read these files before changing code:

1. `README.md` for setup, commands, and the product snapshot.
2. `docs/implementation-status.md` for what is shipped, partial, or planned.
3. `docs/architecture.md` for current runtime and ownership boundaries.
4. `docs/search.md` for any card-discovery or ranking work.
5. `docs/decisions/README.md` and the relevant ADRs before changing a settled
   product or architecture choice.
6. `plan.md` for roadmap scope. It is not proof that a feature exists.

The code and tests remain authoritative when documentation disagrees. Correct
the documentation in the same change when drift is found.

## Current System In One Minute

- The frontend is React 19, TypeScript, and Vite.
- The backend is FastAPI with Pydantic domain contracts.
- Scryfall is the bulk card-data authority; normal search reads derived local
  SQLite data.
- Every search starts with one fuzzy card-title path. Weak-title and
  natural-language requests continue through the one-tool OpenRouter search
  agent.
- RapidFuzz `WRatio` handles exact titles, typos, words, and partial segments.
- `config.yaml` owns the six-card page size, 75% preview boundary, agent model,
  one-tool prompt, and continuation values.
- Deck libraries are currently browser-local and persisted in `localStorage`.
- There is no deck CRUD API or SQLite persistence yet.
- Progressive card-search agent execution is shipped. The separate deck chat
  and mutation agent does not exist yet.
- Development uses uncommon loopback ports:
  - Frontend: `127.0.0.1:41737`
  - Backend: `127.0.0.1:43127`

## Product Invariants

Do not change these without an explicit product decision and ADR update:

- The application is local-first, private, single-user, and Commander-focused.
- The first screen is the working deck editor, not a marketing page.
- Card search is one unified workflow. Do not restore a separate Quick Add.
- Grouping modes are `Custom` and derived `Card types`.
- Custom groups begin with permanent Command zone and Not assigned groups.
- Cards may be moved only in Custom grouping. Card-type grouping is derived.
- There is no standalone maybeboard in the active editor model.
- Card details open in a centered dialog, not a permanent right inspector.
- The right side of the workspace is reserved for a later deck agent.
- Deck names are edited inline through double-click or the edit control.
- The deck rail uses commander art and ends with Create new deck.
- Color-identity warnings must appear before and after an illegal addition.
- Agent edits must eventually use the same typed operations as manual edits,
  show a proposed diff, require confirmation, and remain undoable.

## Architecture Boundaries

### Backend

- Public API contracts live in `backend/src/mtg_deck_builder/domain/`.
- HTTP translation lives in `backend/src/mtg_deck_builder/api/`.
- External provider wire formats stay in `backend/src/mtg_deck_builder/providers/`.
- Title matching and result fetching live in
  `backend/src/mtg_deck_builder/search.py`.
- Append-only diagnostics live in
  `backend/src/mtg_deck_builder/search_debug.py`.
- Agent orchestration, local tool execution, sessions, and continuation live in
  `backend/src/mtg_deck_builder/agentic_card_search.py`.
- Complete agent traces live in
  `backend/src/mtg_deck_builder/agentic_search_debug.py`.
- Runtime dependency construction lives in
  `backend/src/mtg_deck_builder/main.py`.
- Settings are validated in `backend/src/mtg_deck_builder/config.py`.

Do not leak Scryfall response models into API or frontend contracts. Do not put
provider HTTP calls in routes. Keep public Pydantic models strict.

### Frontend

- Shared card and deck contracts live in `frontend/src/domain/`.
- API validation and transport live in `frontend/src/lib/api.ts`.
- Deck mutations and undo history live in `frontend/src/hooks/useDeck.ts`.
- Search orchestration lives in `frontend/src/components/SearchDrawer.tsx`.
- Debug trace presentation lives in
  `frontend/src/components/SearchTracePanel.tsx`.
- Board grouping, sorting, card movement, and display modes live in
  `frontend/src/components/DeckBoard.tsx`.
- Page composition and responsive shell behavior live in `frontend/src/App.tsx`.

Do not mutate deck state directly inside presentation components. Extend
`useDeck` or a future backend deck service with a named operation.

## Search Invariants

- Every query starts as a complete or partial card title.
- Normalize case and punctuation before matching.
- Score against full names, card faces, and the text before a comma.
- Use RapidFuzz `WRatio` on a normalized `0..1` scale.
- An exact title scores `1.0` and must precede partial matches.
- Rank every catalog title; the current fuzzy phase has no score threshold.
- Do not cap the fuzzy title match set.
- Return fuzzy-ranked cards in `search.title_match.page_size` pages and keep
  `has_more` accurate for the **Load more** action.
- Apply color, mana-value, and EUR filters locally before slicing numbered
  result pages.
- Use coverage-aware title confidence only for the progressive phase boundary.
  If fewer than six first-page cards reach `0.75`, return those previews and
  start the agentic phase.
- The search agent may call only `search_local_cards`, exactly once per round.
  It may rank previews plus tool candidates and omit irrelevant cards.
- Serve cached agent-ranked batches before running another model call. After
  exhaustion, one explicit **Load more** click authorizes one continuation
  round with all visible cards excluded.
- Keep semantic retrieval disabled until a real embedding model, index, and
  evaluation exist. Exact Oracle-text and structured local conditions remain
  available.
- Normal search must not call Scryfall; refresh the derived SQLite catalog from
  `default_cards` through the explicit sync command.
- Expose every returned score through `name_match_scores`.
- Expose coverage-aware per-result confidence through
  `title_confidence_scores`; this is the percentage shown in debug mode.
- The trace must include the algorithm, catalog and filtered counts, current
  page, page size, aliases, original ranks, and scores.
- Agent traces shown in the UI must contain exactly the seven accepted steps;
  complete redacted raw evidence belongs in JSONL.
- Do not restore direct Scryfall-syntax routing, live agent Scryfall queries, or
  the superseded layered embedding/reranker pipeline without a new product
  decision and ADR.

When the `CardSearchPage` contract changes, update all of:

- Backend Pydantic models and tests.
- Frontend TypeScript models and runtime response validator.
- Frontend test fixtures.
- E2E fixtures and workflows.
- Search documentation.

## Data And Persistence

- `oracle_id` identifies a gameplay card.
- `scryfall_id` identifies the selected printing.
- The current deck library key is `manabase.deck-library.v2`.
- `manabase.active-deck.v1` is a legacy migration source, not the active format.
- Search debug preference uses `manabase.search-debug`.
- Custom-group placement stores one primary group ID in `categories[0]`.
- Command-zone placement uses `section="command_zone"` and the fixed
  `command_zone` group ID.
- Unknown, deleted, legacy, or maybeboard placement migrates to Not assigned.

Do not add a second deck-persistence path without a migration plan. The future
backend deck store must treat browser-local state as importable legacy data.

## Development Commands

Run from the repository root:

```bash
npm run setup
npm run dev
npm test
npm run build
npm run test:e2e
```

Focused checks:

```bash
uv --directory backend run pytest
uv --directory backend run ruff check src tests
npm test --prefix frontend
npm run build --prefix frontend
npm run test:smoke
```

`npm run test:e2e` starts the application on the default uncommon ports and
requires those ports to be free. Stop an existing `npm run dev` session first.
The smoke test uses `41738` and `43128`.

## Test Expectations

- Backend contract, routing, provider, or configuration changes require pytest.
- Frontend domain, hook, or component changes require Vitest.
- User-visible workflow or responsive changes require Playwright.
- Development-runner changes require the smoke test.
- Frontend changes must pass a production build.
- Catalog-import changes should include a live Scryfall sanity check when
  network access is available. Normal search tests must use local deterministic
  data.
- Visual changes should be checked at desktop and `390x844` mobile widths for
  clipping, overlap, keyboard access, and horizontal overflow.

Do not weaken a test merely to preserve an implementation. Fix the contract or
record the intentional behavior change.

## Environment And Secrets

- Copy `.env.example` to `.env` for local overrides.
- Never commit `.env`, API keys, JSONL traces, benchmark outputs, screenshots,
  databases, or generated build output.
- Keep non-secret search behavior in `config.yaml`.
- Keep the Scryfall user agent and rate-conscious request interval intact.

## Editing Discipline

- Work with existing uncommitted user changes; never discard them.
- Keep changes scoped to the requested behavior.
- Prefer existing domain types and helpers over parallel abstractions.
- Preserve strict runtime validation at API boundaries.
- Update `changelog.md` for user-visible or architectural changes.
- Update an ADR when changing a durable decision.
- Update `docs/implementation-status.md` when a feature moves between planned,
  partial, and shipped.
- Do not hand-edit `frontend/dist`, `local-data`, `test-results`, lockfiles, or
  generated caches unless the task explicitly requires them.

## Definition Of Done

A change is complete when:

1. The implementation and failure states are handled.
2. The relevant focused tests pass.
3. `npm test` passes.
4. Frontend work passes `npm run build`.
5. Workflow changes pass `npm run test:e2e`.
6. Documentation and decision records match the resulting code.
7. `git diff --check` is clean.
