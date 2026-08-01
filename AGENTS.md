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
- Scryfall is the bulk card-data authority; typed search reads derived local
  SQLite data.
- An explicit resumable Tagger sync stores Oracle tags and relationships in a
  separate SQLite sidecar. Card details and explicit immutable tag filters
  consume it, and bounded deduplicated tag concepts enrich semantic document
  v2. Exact card relationships remain outside semantic ranking.
- Every search starts with one fuzzy card-title path. Weak-title and
  natural-language requests continue through the one-tool OpenRouter search
  agent.
- RapidFuzz `WRatio` handles exact titles, typos, words, and partial segments.
- `config.yaml` owns the six-card page size, 75% preview boundary, local
  semantic model/index values, agent model, one-tool prompt, and continuation
  values. A separate top-level `agent:` block owns the deck chat agent, including
  its system prompt and every tool description under `agent.tools` — those are prompt
  text, so they belong in config rather than in code. A description that advertises a
  number must be compared against the setting that produces it, or changing the setting
  leaves the prompt lying with a green suite.
- Mana and ability symbol artwork is committed, under
  `frontend/public/card-symbols/` with a generated manifest beside the module that
  reads it. `npm run symbols:sync` writes both; neither is edited by hand (ADR 0034).
- Deck libraries are currently browser-local and persisted in `localStorage`.
- There is no deck CRUD API or SQLite persistence yet.
- Progressive card-search agent execution is shipped. The deck chat agent is
  shipped with five tools: `read_deck`, `see_cards` (ADR 0029), `search_cards`
  (ADR 0035), `read_history` and `edit_deck` (ADR 0036). The first four are
  read-only. The backend holds no deck, so the browser posts a deck snapshot and a
  bounded history log with each turn, and `edit_deck` cannot mutate anything: it
  resolves a change against the posted snapshot and emits a `deck_edit` stream
  event the browser applies.
- `search_cards` reuses the search agent's `LocalCardSearchTool` unchanged. Its two
  prompts describe one engine — the field reference in
  `agent.tools.search_cards_description`, the craft under `# Searching for cards` in
  `agent.system_prompt` — so tune both or neither, and keep them in step with
  `search.agentic.system_prompt`'s `# Tools` section.
- Development uses uncommon loopback ports:
  - Frontend: `127.0.0.1:41737`
  - Backend: `127.0.0.1:43127`

## Product Invariants

Do not change these without an explicit product decision and ADR update:

- The application is local-first, private, single-user, and Commander-focused.
- The first screen is the working deck editor, not a marketing page.
- Card search is one unified workflow. Do not restore a separate Quick Add.
- There is one grouping mode: derived `Card types`, with the Command zone above it.
  User-created custom groups were removed in ADR 0037 — do not restore them, and do
  not add a grouping control.
- A card's placement is its `DeckSection`, and the command zone is the only
  placement an edit can change. A card type is derived from the card.
- Drag and drop moves a card in or out of the command zone. Dropping on a card-type
  heading means "in the deck", because that is the only thing it can mean.
- There is no standalone maybeboard in the active editor model.
- Card details open in a centered dialog, not a permanent right inspector.
- The right side of the workspace belongs to the deck agent. It is a chat panel on
  desktop and is hidden below 860px; do not put anything else there.
- The deck agent's transcript is client-held and posted back per turn. Do not add a
  server-side chat session; `--reload` would drop it on every backend edit.
- One conversation per deck. The transcript belongs to the deck, not to the panel, so
  switching decks switches chat and **Reset chat** clears exactly one of them.
- A turn is streamed, and only the finished turn is stored. Anything shown while it
  streams must converge on what `done` commits — never add a live element that survives
  into the transcript, or a stored one that the stream cannot produce.
- Debug mode is one interface-wide preference in the editor toolbar, shared by the
  search trace and the deck agent cost. Do not reintroduce a per-surface toggle.
- Model cost is read from the provider's reported `usage.cost`, never computed from
  token counts, and an unreported cost is `None`, never `0.0`.
- Deck names are edited inline through double-click or the edit control.
- Deck deletion requires confirmation and remains restorable during the
  current session.
- The deck rail uses commander art and ends with Create new deck.
- Command-zone cards have quantity one; a second requires a recognized legal
  co-commander pairing and a third is never accepted.
- Color-identity warnings must appear before and after an illegal addition.
- Agent edits go through the same typed operations as manual edits, **apply
  themselves**, and remain undoable. There is no proposed diff and no
  confirmation step; the durable history log is the safety net, and auto-apply
  without it would be a regression (ADR 0036). One agent edit is one reducer
  action, one history entry and one undo step: never half-applied, because
  history would then record an intent that did not happen.
- The transcript must report what the deck **did** with an edit, not what the
  agent proposed. `applyEdit` answers with the outcome and the panel writes the
  block from that answer — the reducer can refuse an edit the backend was happy
  to emit, so a block built from the event would claim an edit that never
  happened. A refusal carries the deck's own sentence and has no Undo.
- The diff is derived centrally in `useDeck`'s reducer from the before/after
  pair it already holds. Do not make a mutator declare its own diff, and do not
  add a `Deck` field without adding it to `domain/history.ts` and extending the
  round-trip property table — a field the diff does not model is a field undo
  silently stops undoing.
- The log is the deck's whole past and `DeckHistory.at` is where the deck stands
  in it (ADR 0038). Nothing removes a recorded edit except `appendToHistory`,
  which discards the undone tail before appending — that is what keeps the cursor
  the newest edit in the log, and every other reader relies on it.
- Every movement goes through `planHistoryTravel`. Do not add a second path for
  the panel or for a keyboard shortcut: a jump is exactly the steps it is made
  of, and it plans rather than counts so a button cannot offer a step the reducer
  then refuses. A jump that cannot replay in full moves the deck not at all.

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
- The conversational deck agent lives in
  `backend/src/mtg_deck_builder/deck_agent.py`, with contracts in
  `domain/agent_chat.py` and its routes in `api/agent.py`. The shared public error
  envelope lives in `api/errors.py`.
- One loop answers both agent routes: `_run` takes optional emitters, and only the
  transport differs. Do not fork it — a second loop is how the streamed and JSON paths
  would start disagreeing about what a turn cost or which tools ran.
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
- Deck mutations live in `frontend/src/hooks/useDeck.ts`. The diff derivation,
  inversion, session rule, payload pool and pruning live in
  `frontend/src/domain/history.ts` as pure functions with no React and no storage;
  `useDeck` is the only caller and the only place that decides an actor.
- Search orchestration lives in `frontend/src/components/SearchDrawer.tsx`.
- Debug trace presentation lives in
  `frontend/src/components/SearchTracePanel.tsx`.
- The deck agent panel lives in `frontend/src/components/DeckAgentPanel.tsx`, its
  per-deck conversations in `frontend/src/hooks/useDeckAgentChats.ts`, and the shared
  debug preference in `frontend/src/hooks/useDebugMode.ts`.
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
- Apply Commander legality, commander identity, selected card types, selected
  subtypes, selected tags, color, mana-value, and EUR filters locally before
  slicing numbered result pages.
- Use coverage-aware title confidence only for the progressive phase boundary.
  If fewer than six first-page cards reach `0.75`, return those previews and
  start the agentic phase.
- The search agent may call only `search_local_cards`, exactly once per round.
  It may rank previews plus tool candidates and omit irrelevant cards.
- Model parameters belong in configuration. `provider.require_parameters` is on,
  so sending a parameter the chosen model lacks fails the whole call: leave
  `temperature` empty for models that reject it. The advertised tool schema must
  stay free of `strict` and of regex lookarounds, both of which pass silently on
  Gemini and fail outright on OpenAI. Verify a model change with a live search,
  not only with tests — a schema the provider refuses is green in every unit test.
- Serve cached agent-ranked batches before running another model call. After
  exhaustion, one explicit **Load more** click authorizes one continuation
  round with all visible cards excluded.
- Treat every local-tool field except `semantic_sort`, `name_sort`, and
  `sort_by` as a hard filter. `semantic_sort` must run after filters, must never
  discard by score, and must use the catalog-coupled local embedding sidecar.
- Card names order, never filter. `name_sort` scores fuzzy title similarity with
  no threshold and no cap, and pairs with `sort_by: name_similarity` in both
  directions. Name similarity stays out of the `weighted` blend.
- An omitted `sort_by` means `weighted`, sourced from `DEFAULT_AGENT_SORT`.
  `weighted` blends the signals a run actually has, so it must never require
  commander evidence or reject a run; only `edhrec_inclusion` and
  `edhrec_synergy` do. Its weights stay in `config.yaml`.
- Treat type conditions as literal printed type-line fragments. Use separate
  `must_contain_all` values for true intersections, `must_contain_any` for
  alternatives, and no type condition for a broad role that does not name a
  type. Interface-selected card types and subtypes are immutable AND filters.
  Keep defensive provider-boundary normalization covered by tests.
- All agent logic lives in the `system_prompt` in `config.yaml`, written in
  Markdown with the `# Task` / `# Inputs` / `# Output` / `# Tools` /
  `# Guidelines` skeleton. The user message and the tool-result message carry
  labelled data sections only and must contain no instruction; the
  `search_local_cards` description stays one line; schema field descriptions
  state shape and units only. Never state a rule in two of these places — that
  is how the tool description came to contradict the prompt (ADR 0020).
- The agent owns its own `types` and `colors`. Do not add runtime logic that
  deletes, relaxes, or rewrites a validated agent filter based on the wording of
  the user's query; that guard existed and was removed by ADR 0019 because a
  lexical predicate cannot tell "mana rocks" (Artifact is correct) from
  "removal spells" (no type is correct). Correct filter intent by teaching the
  system prompt, and pin the teaching with a prompt-content test.
  `_normalize_tool_arguments` remains the one place that may alter a tool call,
  and only to repair schema shape or drop runtime-owned `format`/`legality`.
- Normal search must not call Scryfall; refresh the derived SQLite catalog from
  `default_cards` through the explicit sync command.
- Normal search must not call the Tagger network. `tagger:sync` owns the
  optional local sidecar. Card enrichment and explicit tag filters read it at
  runtime; embedding builds read its bounded concept snapshot only during
  explicit sync.
- EDHREC is an optional blank-query sort enhancement only. Fetch at most one
  selected single-commander page after a 30-day cache miss, keep raw and
  Oracle-normalized data in its own sidecar, and visibly fall back to the
  original local order on every failure. Typed fuzzy and agentic search must
  not use it.
- Expose every returned score through `name_match_scores`.
- Expose coverage-aware per-result confidence through
  `title_confidence_scores`; this is the percentage shown in debug mode.
- The trace must include the algorithm, catalog and filtered counts, current
  page, page size, aliases, original ranks, and scores.
- Agent traces shown in the UI must contain exactly the seven accepted steps;
  complete redacted raw evidence belongs in JSONL.
- Do not restore direct Scryfall-syntax routing, live agent Scryfall queries, or
  the superseded layered embedding/reranker pipeline without a new product
  decision and ADR. Semantic sorting belongs inside the one local tool.

When the `CardSearchPage` contract changes, update all of:

- Backend Pydantic models and tests.
- Frontend TypeScript models and runtime response validator.
- Frontend test fixtures.
- E2E fixtures and workflows.
- Search documentation.

## Data And Persistence

- `oracle_id` identifies a gameplay card.
- `scryfall_id` identifies the selected printing.
- The catalog keeps one printing per Oracle card, and that choice decides the
  art, the image and the EUR estimate everywhere. It is the cheapest **ordinary**
  printing: image first, then a price, then not special, then cheapest. Never
  reorder those tiers casually — putting cheapness above ordinariness reinstates
  full-art and Secret Lair versions, and putting ordinariness above price
  presence drops cards out of every price filter. See
  [ADR 0024](docs/decisions/0024-cheapest-ordinary-printing-selection.md).
- What counts as a special printing is configuration (`printing_selection` in
  `config.yaml`), not code. Changing it requires `catalog:sync --force`, because
  selection happens at import time and never at query time.
- Bulk import accepts Scryfall's JSON-array and line-delimited exports. The URI
  suffix decides compression and format; the response headers no longer disclose
  either.
- `local-data/card-tagger.sqlite3` is optional derived enrichment keyed by
  `oracle_id`; explicit tag filters require it, and its bounded concepts are a
  versioned input to semantic document v2 when installed.
- The current deck library key is `manabase.deck-library.v2`.
- `manabase.active-deck.v1` is a legacy migration source, not the active format.
- Debug mode uses `manabase.search-debug`. The name predates its wider scope and
  stays as it is; renaming it would silently reset the preference.
- Deck agent conversations use `manabase.deck-agent-chats.v1`, keyed by deck id.
  Anything written there must stay inside the serializer's character budget: the deck
  library shares this quota, and losing a deck edit is worse than losing a transcript.
- Deck edit history uses `manabase.deck-history.v1`, keyed by deck id, and shares the
  same quota (ADR 0036). Card payloads are pooled one per printing under `cards`, only
  for a card entering or leaving the deck, and orphans are collected on write — do not
  pool one per change. Two caps bound it and mean different things:
  `DECK_HISTORY_PAYLOAD_CAP` is travel depth in *either* direction — the undone tail is
  the newest, so it keeps its payloads — and `DECK_HISTORY_SESSION_CAP` is read depth.
  Neither is the cap on what the browser *posts*: those are separate constants in
  `domain/agent.ts` keyed to the backend's `MAX_HISTORY_SESSIONS` / `MAX_HISTORY_EDITS`,
  because exceeding a posted bound is a 422 that fails the whole chat turn. Do not
  collapse the storage and posted caps into one symbol.
- A deleted deck's history is archived with the deck and restored with it, the same
  discipline `DeletedDeckSnapshot` already applies to the deck itself.
- Placement is `section`, one of `command_zone` or `mainboard`, and nothing else.
- A stored deck written before ADR 0037 carries `custom_groups` and a per-card
  `categories` array. Both are read, dropped, and never written again; no card is
  lost, only where it was filed. Legacy and maybeboard placement becomes `mainboard`.
- A stored *history* written before ADR 0037 keeps `categories` inside its placements
  and a `groups` array on its diffs. Both are ignored rather than rejected, so an old
  log stays readable and its card changes stay replayable.

Do not add a second deck-persistence path without a migration plan. The future
backend deck store must treat browser-local state as importable legacy data.

## Development Commands

Run from the repository root:

```bash
npm run setup
npm run catalog:sync
npm run tagger:sync
npm run symbols:sync
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
