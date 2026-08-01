# Implementation Status

Last verified: 2026-08-01

This is the canonical feature ledger. It describes the repository as it exists,
not the intended end state.

## Shipped

### Runtime And Tooling

- React 19, TypeScript, Vite frontend.
- FastAPI and Pydantic backend.
- Root runner that starts both services and shuts down child processes cleanly.
- Uncommon loopback development ports `41737` and `43127`.
- Root setup, test, build, E2E, and smoke commands.
- CORS restricted to the configured frontend origin.
- Strict public API response validation in both backend and frontend.

### Card Search

- Local SQLite catalog synchronized from Scryfall `default_cards`.
- Streaming, timestamp-aware, atomic bulk import with every paper printing and
  one representative result per Oracle card. Accepts Scryfall's JSON-array and
  line-delimited exports, and keeps the cheapest ordinary printing rather than
  the newest one, with the special-version rules in `printing_selection`
  (ADR 0024).
- Atomic semantic sidecar synchronized with the exact catalog, using local
  `BAAI/bge-small-en-v1.5` ONNX embeddings over title-resistant gameplay
  document v2. Documents include canonical rules/type/mana/stat text plus
  bounded, deduplicated Tagger concepts when that optional sidecar is present.
- One fuzzy title path for exact names, typos, words, and partial segments.
- Local full-title, face, and before-comma aliases.
- RapidFuzz `WRatio` scores normalized to `0..1`.
- Exact title first, followed by partial and typo matches in score order.
- Complete-catalog fuzzy ranking with no score threshold or candidate cap.
- Local filtering followed by full six-card numbered pages and **Load more**.
- No Scryfall or Tagger network requests during search. Typed fuzzy and agentic
  search are fully local apart from the configured model provider; only
  optional enhanced blank-query browsing may fetch one EDHREC commander page
  after a cache miss.
- Search filters for subset/exact color identity, colorless, mana-value range,
  EUR-price range, required card types, fuzzy-selected subtypes, and one or
  more fuzzy-selected Tagger labels.
- Commander-legal cards only and current commander color identity are enforced
  by default, including an established colorless identity. Independent opt-in
  switches expose non-legal or off-identity cards.
- Interface-selected Commander, card-type, subtype, and tag constraints are
  immutable across fuzzy, agentic, and continuation rounds. Required card
  types and subtypes use AND semantics.
- Paper-card restriction for matched titles.
- Loading, empty, provider-unavailable, and retry states.
- Default-on **Enhance with EDHREC** when exactly one commander is selected.
  Blank-query/filter-only pages sort by inclusion; typed agentic searches see
  commander context and may sort by a weighted blend, semantic closeness,
  inclusion, or synergy. The blend is the agent's default ordering and falls
  back to semantic-only without commander evidence.
- Optional EDHREC deck-theme selection from the commander's advertised themes;
  the selected theme is immutable across the agent prompt, local tool, session,
  and continuation rounds.
- On-demand EDHREC commander-page acquisition into a separate raw-and-normalized
  SQLite sidecar with separate base/theme snapshots and a 30-day freshness
  window.
- Explicit EDHREC fetch-failure feedback in the drawer while normal local
  sorting remains available.
- Per-result daily Scryfall EUR estimate and Cardmarket verification links.

### Card Data Enrichment

- Explicit, resumable Scryfall Tagger acquisition into an atomic SQLite
  sidecar.
- Normalized Oracle-card tag definitions, tagging edges, and directed
  relationships keyed by `oracle_id`.
- Preserved tag descriptions and raw bulk records plus relationship statuses,
  annotations, inverse classifiers, and raw fetched JSON. Tagging membership
  status/strength columns are nullable because the bulk source omits them.
- Lazy Oracle-ID enrichment endpoint for search previews and deck card details.
- Local canonical-card lookup for opening similar cards and outgoing references
  in the regular card dialog at quantity zero without replacing search state.
  Inverse `referenced_by` relationships remain stored but are hidden.
- Grouped every relationship classifier Tagger publishes — strictness
  (`upgrades`/`downgrades`), body (`creature_versions`/`spell_versions`),
  `variants`, `related_cards` — with direction normalized from a local inverse
  table. Previously 55% of stored relationship edges were read and discarded
  (ADR 0025).
- On-demand EDHREC similar cards per card, names cached 180 days in the EDHREC
  sidecar (schema 3) under their own `similar_refresh_after_days`. Name-to-Oracle
  resolution is re-derived on every read rather than cached, so a catalog sync
  repairs unresolvable names; unresolved names are retained but not linked
  (ADR 0026).
- Clickable tags that open a tag-only search, plus fuzzy tag lookup and
  removable multi-tag filter chips.
- Explicit tag filters intersect local Oracle-card memberships before fuzzy or
  agentic ranking. Separately, bounded and deduplicated gameplay-concept tags
  enrich semantic document v2 when the optional sidecar is installed. Exact
  Tagger relationships do not enter embeddings, expand search candidates, or
  rerank results.

### Search Diagnostics

- Browser-persisted interface-wide Debug mode toggle in editor-toolbar
  **Settings**, governing both the search trace and the deck agent's running cost
  (ADR 0028).
- Environment-level debug default.
- Debug-only coverage-aware title-confidence percentage beneath each returned
  result.
- One-stage inline trace with algorithm, catalog and filtered counts, page,
  aliases, original ranks, and scores.
- Append-only JSONL traces in `local-data/search-debug.jsonl`.
- Fuzzy title scores in API results and logs.
- Fuzzy alias, WRatio score, title confidence, and original catalog rank for
  each loaded-page card.
- Failed agentic searches retain an auto-opened sanitized trace with the broken
  step marked as an error and all later steps marked skipped.
- What each agent round cost, from the provider's reported `usage.cost` rather
  than token arithmetic, on the trace summary line and on failed rounds that
  already paid for a call. An unreported figure is shown as absent, never as zero.

### Deck Agent Chat

- Chat panel in the reserved right side of the workspace, desktop only.
- Conversation memory: the browser holds the transcript and posts it back on every
  turn, trimmed to the newest `agent.max_history_messages` entries (ADR 0027).
- One conversation per deck, saved under `manabase.deck-agent-chats.v1` and restored
  on return, running spend included. A reply still in flight when the deck changes is
  abandoned rather than answered into the deck the user left; its question stays put
  so sending again retries it (ADR 0030).
- The chat store spends a fixed character budget newest-first, dropping tool payloads
  before turns, so it can never crowd the deck library out of browser storage.
- The composer's unsent draft is per deck too, saved with the conversation and held to
  the composer's 8,000-character limit when restored.
- **Reset chat** in the panel header forgets the open deck's conversation, its running
  cost, its draft, and any in-flight request — and no other deck's.
- Every card the agent names is an openable card. The agent writes each name in braces,
  the backend resolves them against the local catalog, and the chat underlines them:
  hover shows the card image, click opens the deck board's own inspector (ADR 0033).
  Braces already mean mana in Magic, so the catalog is what tells `{Sol Ring}` from
  `{T}`; a name it does not recognise renders as plain words with no underline.
- `**bold**` and `*italic*` render in the answer instead of showing their asterisks.
- Mana and ability symbols are drawn rather than spelled, in the answer and in every
  card panel: deck list, deck board, search results and preview, card inspector, and
  the search trace (ADR 0034). One `CardText` component owns it, and the artwork is
  committed to the repository by `npm run symbols:sync` rather than fetched at render
  time. A braced run the symbol table does not list stays exactly as written.
- Turns are streamed over `POST /api/v1/agent/chat/stream`: each tool call appears the
  moment it runs, and the answer appears as it is written. Only the finished turn is
  stored, so what streams converges on what is kept (ADR 0031). A half-streamed answer
  is discarded when the turn fails or the deck changes.
- Enter sends, Shift+Enter breaks a line, and a failed turn keeps its question in
  the transcript so sending again retries with the context intact.
- Running conversation cost in the header while debug mode is on, marked `+` when
  a turn's price was not reported.
- Its own top-level `agent:` configuration block: model, reasoning effort,
  temperature, timeout, memory window, the whole system prompt, and every tool
  description under `agent.tools`.
- `POST /api/v1/agent/chat` and `POST /api/v1/agent/chat/stream`, separating an
  unusable reply (`502`) from an unreachable or unconfigured agent (`503`). The
  streaming route reports availability before it starts; a later failure arrives as an
  `error` event with the same code and wording. The interface uses the streaming route
  only — the JSON one remains the plain API contract.
- Five tools, four of them read-only (ADRs 0029, 0035 and 0036):
  - `read_deck()` — the open deck grouped under each card's primary type, with
    names, short ids and on-screen custom groups, and no card text. It also reports a
    quantity-weighted mana curve and a total EUR price without being asked, adopting the
    statistics memo's own conventions exactly — price over every card including the
    command zone, average mana value over neither the command zone nor anything with
    `Land` in its type line — so the tool and the interface cannot give two different
    correct answers. Where they part company is a card with no EUR estimate: the
    interface reads it as `0` and under-reports silently, while the tool excludes it and
    counts it in words, because a card with no price is not a free card.
  - `see_cards(cards, details)` — named or short-id cards at the requested depth:
    rules, prices, Tagger tags, EDHREC similar cards, EDHREC inclusion for this
    deck's commander, Commander legality. Defaults to rules.
  - Each card renders as labelled, quoted fields, and the details always appear in
    one fixed order with `similar` last, whatever order they were asked for. `similar`
    groups Tagger's relationship lists under the labels the card panel uses, merges
    EDHREC's similar cards into `Similar cards`, and names each card once under the
    group that says the most about it (ADR 0032).
  - `themes` — the deck themes EDHREC tracks for a card *as a commander*, most played
    first with the deck count behind each, capped at twenty (ADR 0035). These are the
    slugs `search_cards` takes as `commander.edhrec_theme`. Only a card that can legally
    be a commander has a page, so for anything else the detail says which of the two is
    true rather than reporting a bare absence.
  - `search_cards(...)` — the whole local catalog, filtered and ordered by the model
    rather than by an interface panel (ADR 0035). It is the search agent's own
    `LocalCardSearchTool`, so every ordering and filter field is the same one, and
    `SearchCardsArguments` subclasses `LocalCardSearchRequest` to keep them so. Added
    on top: a `commander` object whose colour identity is a hard filter and whose
    EDHREC inclusion and synergy only sort, `commander_legal_only`, and
    `exclude_cards_in_deck`. Omitting the commander means there is no commander rather
    than inheriting the open deck's, and naming any other card in the catalog is how a
    question about a different commander is answered. Results use the same card block
    `see_cards` renders — rules text and one EUR estimate — under a header carrying only
    what the model could not have known: how many cards matched against how many are
    shown (`search_cards_default_max_results`, 12), a colour identity that removed
    cards, and a *missing* EDHREC lookup. What the model itself sent is not echoed back.
    Every refusal — an EDHREC ordering with no evidence, no criteria at all, an
    unknown commander or theme — comes back as text the model adapts to.
  - `edit_deck(changes, reason)` — the one tool that changes the deck (ADR 0036). Each
    change states the copy count wanted **afterwards** rather than an operation: add is
    `quantity: 1`, cut is `quantity: 0`, a move is the same quantity with a new `group`,
    a swap is two changes. So there is no discriminator, no conditional field, and the
    call is idempotent — a change the deck already satisfies is dropped before the edit
    is emitted, which is what makes a retry safe. The backend mutates nothing: it
    resolves the change against the posted snapshot and emits a `deck_edit` stream event
    the browser applies. The result is accurate rather than proposed — what the deck held
    before, which changes were no-ops, the resulting card count, and any warning — and
    echoes none of the caller's own arguments. Only an unresolvable card and a quantity
    outside `0..99` fail the call, and either fails all of it; colour identity, the
    singleton rule and the hundred-card bound are warnings, because the board treats them
    that way.
  - `read_history(limit)` — the deck's recorded past, newest session first, with the
    actor rendered as `You` and `Me` and an agent session carrying the model's own
    one-line reason. A client that posted no history reads differently from a deck with
    no recorded edits, because the two lead somewhere different. `read_deck`'s footer
    points at it only when history is present.
- The browser posts a deck snapshot with each turn, carrying identity and placement
  only; names, types, rules and prices are resolved from the local catalog. It posts the
  deck's history log alongside it, pruned newest-first to the backend's three bounds —
  50 sessions, 500 edits, 250 cards per edit — because a request over any of them is
  refused whole, which would fail the chat turn rather than the history.
- An agent edit **auto-applies** (ADR 0036). It lands as one reducer action, one history
  entry and one undo step, and the transcript shows an applied-edit block in the past
  tense — `Applied: +2 / −1` over the names — with an **Undo** rather than a confirm.
  There is no proposed diff and no confirmation step; the durable history log is the
  safety net. The block reports what the deck **did**, not what the agent asked for: the
  reducer can refuse an edit the backend was happy to emit — an illegal second commander,
  an unknown group — and a refusal renders the deck's own sentence with no Undo. The Undo
  sits on the newest edited turn only.
- Every tool call is shown in the transcript as its own line above the answer,
  regardless of debug mode, with failed calls marked.
- With debug mode on, a call opens onto two sub-boxes — the arguments the model sent
  and the exact text the tool returned. Both travel only for a turn whose request set
  `debug`, and an oversized payload is truncated with a visible marker (ADR 0030).
- A bounded loop of `agent.tools.max_iterations` tool rounds followed by one
  no-tools completion, so a turn always ends in an answer.

Missing:

- Creating a custom group from an edit. `edit_deck` can place a card in a group the deck
  already has; making a new one stays `addCustomGroup`'s job.
- Reordering. Position is recorded so an undone removal lands where it was, but it is not
  an edit axis, so a pure reorder derives no change at all (ADR 0036).
- Partner and background command zones, in `edit_deck` as in `see_cards` and
  `search_cards`.
- Any mobile entry point.
- Streamed reasoning: at `xhigh` it is most of the turn and none of the answer, so the
  panel says it is thinking instead of narrating.
- Payloads for turns taken before debug mode was switched on: they were never
  requested, so those lines stay plain rather than opening onto nothing.

### Deck Editor

- Browser-local deck library with active-deck switching.
- Create, inline rename, confirm-delete, and session-restore decks.
- Deleting the final deck creates a fresh empty fallback; restoring it removes
  that untouched placeholder.
- Commander-art thumbnails in the deck rail.
- Add, remove, and change printing quantity.
- A durable per-deck edit history under `manabase.deck-history.v1`, derived centrally in
  `useDeck`'s reducer from the before/after pair it already holds, so no mutation site
  declares its own diff and a mutator added later is recorded with no extra wiring
  (ADR 0036). Every entry carries a time, an actor, a summary and — for an agent edit —
  the model's reason, and edits group into sessions by actor and a three-minute gap, so an
  agent edit never joins a user's.
- Undo replays the last recorded entry backwards and therefore **survives a reload**,
  which the thirty-step in-memory snapshot stack it replaces could not. Undo depth is
  bounded by the payload pool (50 printings) rather than by a step count; read depth is
  every retained session (50). An entry whose payload has been pruned stays readable and
  stops being replayable, and that refusal is announced rather than thrown.
- A deleted deck's history is archived with the deck and restored with it.
- Permanent Command zone and Not assigned groups.
- User-created custom groups.
- Drop-to-create a custom group and move the card in one undoable action.
- Pointer, touch, and keyboard-accessible card movement between custom groups.
- Visual stacks and dense list views.
- Derived Card types as the default grouping mode, with Custom available for
  editable functional groups and drag/drop.
- Alphabetic, mana-value, and price sorting.
- Deck, group, and selected-printing price totals.
- Singleton warnings.
- Commander color-identity union across known command-zone cards.
- Pre-add and persisted warnings for cards outside commander color identity.
- One-copy command-zone enforcement across search adds, quantity edits,
  drag/drop, and card-detail movement.
- Legal two-commander pairing checks for Partner, reciprocal Partner with,
  Friends forever, Choose a Background, and Doctor's companion.
- Visible rejection feedback plus warnings for invalid legacy command zones.
- Centered card detail dialog on desktop and contained full-screen mobile view.
- Tagger tags and related-card navigation inside that deck card dialog.
- Desktop navigation rail and mobile deck-action toolbar.
- Responsive search, deck-name editing, custom-group creation, and card actions.

### Verification

- Backend tests for contracts, provider mapping, errors, filters, routing,
  ranking, configuration, traces, and deck models.
- Frontend tests for API validation, deck migration, mutations, search, traces,
  and primary application workflows.
- A round-trip property test over the diff derivation, in both directions, across a
  twelve-case table covering every field a `Deck` can differ by. It is what stands between
  a new `Deck` field and an undo that silently stops undoing it (ADR 0036).
- Playwright workflows for desktop editing, search failure recovery, filters,
  color warnings, legal commander pairs, recoverable deck deletion, and mobile
  containment.
- Production frontend build.
- Paired-process startup and shutdown smoke test.

## Partial

### Commander Validation

Implemented:

- Color-identity warnings based on command-zone card details.
- Singleton warnings.
- One commander by default and up to two only when they form a recognized legal
  pair.
- Partner, reciprocal Partner with, Friends forever, Choose a Background, and
  Doctor's companion pairing validation.
- One-copy command-zone quantities and a hard two-card maximum.

Missing:

- Complete 100-card size validation.
- Single-commander eligibility and unusual or future command-zone exceptions.
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

### Title Matching

Implemented:

- Exact, partial, segmented, and typo-tolerant title matching.
- Configurable page size.
- Debug evidence for every title on the loaded page.

Missing:

- A formal evaluation corpus for a future semantic-routing threshold.
- In-app controls for the YAML matching values.

### Progressive Agentic Search

Implemented:

- Accepted one-tool progressive-search decision in ADR 0009.
- Stricter substring-or-whole-string preview confidence with a configurable
  75% phase boundary returned per card and recorded in current fuzzy traces.
- Validated YAML settings and a detailed agent prompt explaining filter versus
  sort behavior, intent recovery, canonical symbols, and imperfect-query
  examples.
- Strict all-optional `search_local_cards` input with merged mana fields,
  structured filters, bounded candidate counts, and top-level semantic
  sorting. Rules-text meaning is handled through semantic retrieval rather
  than an agent-generated exact-text filter.
- Literal type-line filtering with separate AND combinations and OR
  alternatives. Broad gameplay requests omit unrequested type constraints.
- Prompt-taught type and color intent. Validated agent `types` and `colors`
  reach the local tool unmodified; the system prompt distinguishes cross-type
  functional categories, which stay semantic, from definitional and typal terms,
  which justify a printed-type filter. The former query-wording guard was
  removed in ADR 0019.
- Commander legality and format are absent from the agent-editable schema, and
  stale provider-supplied copies are discarded before validation.
- Provider-boundary normalization repairs comma-joined alternatives, abstract
  type concepts, and nested objects accidentally serialized as JSON strings.
- Multiset `must_contain_all` semantics for duplicate symbols such as two
  `{X}` values.
- Strict final interpretation/ranked-ID output using temporary integers,
  runtime guards against invented IDs, and permission to omit irrelevant
  candidates.
- Versioned complete internal agent audit trace, secret redaction, and
  untruncated JSONL persistence contracts.
- Local exact-condition and numeric power/toughness tool execution against the
  complete derived catalog.
- Filter-before-sort semantic execution with no score cutoff, per-candidate
  cosine evidence, and automatic fallback to the original user intent when the
  model omits `semantic_sort`.
- Normalized `0-1` semantic closeness in each semantically sorted card's clean
  model-facing tool block.
- A single agent-visible local search tool; live Scryfall query generation is
  not exposed to the model.
- Direct OpenRouter two-call orchestration with exactly one intervening tool
  call and structured final output.
- Progressive fuzzy-preview and agentic POST endpoints.
- Drawer handoff that keeps confident previews visible while the agent runs.
- In-memory ranked search sessions that serve cached **Load more** batches
  without a model call and run one user-triggered continuation after exhaustion.
- Continuation prompts with full **Already showing** details, canonical
  displayed/considered-card exclusions, every prior structured tool request,
  explicit broaden-or-change guidance, retryable empty rounds, and per-round
  seven-step traces.
- Focused seven-step inline agent trace with system prompt, user input,
  provider-returned thinking, tool call/response, final thinking, and output.
- Markdown system prompt using the `# Task` / `# Inputs` / `# Output` /
  `# Tools` / `# Guidelines` skeleton, holding every rule and worked example
  with no runtime injection.
- Data-only user and tool messages built from labelled sections, a one-line
  tool description, and shape-only schema field descriptions, so no surface can
  contradict the system prompt (ADR 0020).
- URL-free candidate details with selectable non-overlapping fuzzy IDs, price,
  Oracle text, and power/toughness, and an exact readable tool-role message
  stored beside the untouched raw tool result.

Missing:

- Trace retention and size policy.

`search.agentic.enabled` is `true`. Semantic sorting has no enabled flag; a
missing or stale sidecar is an explicit unavailable state fixed by
`npm run catalog:sync`.

## Planned, Not Implemented

- Automatic weekly catalog-refresh scheduling.
- Backend deck CRUD, persistence, and typed mutation API.
- Browser-local deck import/migration into backend storage.
- Plaintext import and export.
- Full printing and finish selection.
- Mana curve, color production, probability, and functional analytics.
- Multi-select and bulk editing.
- Named deck snapshots, and server-side mutation history. The browser-local diff log
  is shipped (ADR 0036); making it survive a browser wipe or read across devices needs
  backend deck persistence first.
- Redo. The log replays forward as easily as backward, so it is nearly free, and it needs
  its own affordance (ADR 0036).
- A history panel for the user. The agent reads history through `read_history`; the user
  still sees only an Undo button.
- A mobile entry point for the deck agent.
- Any spend cap or budget: cost is reported, never enforced.

## Deferred

- Accounts, cloud sync, collaboration, and public deck discovery.
- Collection ownership and buy/sell cart workflows.
- Direct third-party account synchronization.
- Full playtest simulation.
- Bulk EDHREC mirroring and automated background acquisition.

## Important Current Boundaries

- Deck state is not stored by FastAPI. It lives in frontend `localStorage`.
- Backend deck Pydantic models exist, but no route or service owns mutations.
- The local catalog is a derived read model and can be rebuilt from Scryfall.
- The Tagger sidecar is optional derived data. Card details and explicit tag
  filters read it, while bounded gameplay concept names also enrich semantic
  document v2. Tagger relationships remain outside embeddings and ranking.
- The EDHREC sidecar is optional derived data populated one commander at a
  time. A 30-day cache miss may use the network; every failure keeps search at
  HTTP 200 with local ordering and a visible unavailable status.
- Card search, fuzzy tag lookup, canonical card lookup, card enrichment, and deck
  agent chat are the product APIs beyond health.
- The deck agent reads the deck from a snapshot posted with each turn, not from
  backend state, and resolves every card fact from the local catalog. `edit_deck` does not
  change that: the backend computes a resolved change and emits it, and the browser is the
  only thing that applies one. Command-zone legality and group existence live in
  `frontend/src/domain/deck.ts` and are deliberately not duplicated in the backend, so the
  browser can and does refuse an edit the backend emitted.
- Deck edit history is browser-local too, per deck, under `manabase.deck-history.v1`, in
  the same storage quota as the deck library and the chat transcripts. It does not survive
  a browser wipe and is not readable across devices.
- Search always starts locally. Natural-language or weak-title queries can
  continue through OpenRouter and one bounded structured local tool call.
- Scryfall images remain remote.
- Search returns one representative printing per gameplay card.

## Recommended Next Implementation Order

1. Define backend deck repository and typed mutation service without changing
   the current UI behavior.
2. Add browser-local library import and migration into that service.
3. Implement complete Commander validation against shared domain models.
4. Add plaintext import/export and full printing selection.
5. Move deck history behind that service so it survives a browser wipe, keeping the
   browser-local log as importable legacy data.
