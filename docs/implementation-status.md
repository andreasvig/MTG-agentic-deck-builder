# Implementation Status

Last verified: 2026-07-30

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
  one representative result per Oracle card.
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
  commander context and may sort by semantic closeness, inclusion, or synergy.
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
- Clickable tags that open a tag-only search, plus fuzzy tag lookup and
  removable multi-tag filter chips.
- Explicit tag filters intersect local Oracle-card memberships before fuzzy or
  agentic ranking. Separately, bounded and deduplicated gameplay-concept tags
  enrich semantic document v2 when the optional sidecar is installed. Exact
  Tagger relationships do not enter embeddings, expand search candidates, or
  rerank results.

### Search Diagnostics

- Browser-persisted Search debug log toggle.
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

### Deck Editor

- Browser-local deck library with active-deck switching.
- Create, inline rename, confirm-delete, and session-restore decks.
- Deleting the final deck creates a fresh empty fallback; restoring it removes
  that untouched placeholder.
- Commander-art thumbnails in the deck rail.
- Add, remove, and change printing quantity.
- Thirty-step per-deck undo history for current-session mutations.
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
- Named deck snapshots and persisted mutation history.
- Deck assistant beyond the shipped card-search agent.
- Agent chat interface in the reserved right workspace.
- Typed agent tools for inspect, validate, search, propose patch, confirm, apply,
  and undo.

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
- Card search, fuzzy tag lookup, canonical card lookup, and card enrichment are
  the product APIs beyond health.
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
5. Introduce agent patch schemas and confirmation flow before building chat.
