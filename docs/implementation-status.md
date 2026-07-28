# Implementation Status

Last verified: 2026-07-28

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
- One fuzzy title path for exact names, typos, words, and partial segments.
- Local full-title, face, and before-comma aliases.
- RapidFuzz `WRatio` scores normalized to `0..1`.
- Exact title first, followed by partial and typo matches in score order.
- Complete-catalog fuzzy ranking with no score threshold or candidate cap.
- Local filtering followed by full six-card numbered pages and **Load more**.
- No network requests during normal search.
- Search filters for subset/exact color identity, colorless, mana-value range,
  and EUR-price range.
- Paper-card restriction for matched titles.
- Loading, empty, provider-unavailable, and retry states.
- Per-result daily Scryfall EUR estimate and Cardmarket verification links.

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
- Create and inline rename deck.
- Commander-art thumbnails in the deck rail.
- Add, remove, and change printing quantity.
- Thirty-step per-deck undo history for current-session mutations.
- Permanent Command zone and Not assigned groups.
- User-created custom groups.
- Drop-to-create a custom group and move the card in one undoable action.
- Pointer, touch, and keyboard-accessible card movement between custom groups.
- Visual stacks and dense list views.
- Custom and derived Card types grouping modes.
- Alphabetic, mana-value, and price sorting.
- Deck, group, and selected-printing price totals.
- Singleton warnings.
- Commander color-identity union across known command-zone cards.
- Pre-add and persisted warnings for cards outside commander color identity.
- Centered card detail dialog on desktop and contained full-screen mobile view.
- Desktop navigation rail and mobile deck-action toolbar.
- Responsive search, deck-name editing, custom-group creation, and card actions.

### Verification

- Backend tests for contracts, provider mapping, errors, filters, routing,
  ranking, configuration, traces, and deck models.
- Frontend tests for API validation, deck migration, mutations, search, traces,
  and primary application workflows.
- Playwright workflows for desktop editing, search failure recovery, filters,
  color warnings, and mobile containment.
- Production frontend build.
- Paired-process startup and shutdown smoke test.

## Partial

### Commander Validation

Implemented:

- Color-identity warnings based on command-zone card details.
- Singleton warnings.
- Command-zone grouping and multiple command-zone entries.

Missing:

- Complete 100-card size validation.
- Commander eligibility and partner/background/companion compatibility rules.
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
- Validated YAML settings and system prompt for semantic and agentic search.
- Strict all-optional `search_local_cards` input with merged mana fields,
  semantic Oracle-text query, exact conditions, structured filters, and
  bounded candidate counts.
- Multiset `must_contain_all` semantics for duplicate symbols such as two
  `{X}` values.
- Strict final interpretation/ranked-ID output using temporary integers,
  runtime guards against invented IDs, and permission to omit irrelevant
  candidates.
- Versioned complete internal agent audit trace, secret redaction, and
  untruncated JSONL persistence contracts.
- Local exact-condition and numeric power/toughness tool execution against the
  complete derived catalog.
- A single agent-visible local search tool; live Scryfall query generation is
  not exposed to the model.
- Direct OpenRouter two-call orchestration with exactly one intervening tool
  call and structured final output.
- Progressive fuzzy-preview and agentic POST endpoints.
- Drawer handoff that keeps confident previews visible while the agent runs.
- In-memory ranked search sessions that serve cached **Load more** batches
  without a model call and run one user-triggered continuation after exhaustion.
- Continuation prompts with full **Already showing** details, canonical
  displayed/considered-card exclusions, retryable empty rounds, and per-round
  seven-step traces.
- Focused seven-step inline agent trace with system prompt, user input,
  provider-returned thinking, tool call/response, final thinking, and output.
- Natural URL-free user prompts with selectable, non-overlapping fuzzy IDs plus
  price, Oracle text, and power/toughness, and an exact
  readable tool-role message stored beside the untouched raw tool result.

Missing:

- Embedding model, semantic index, and local-tool execution.
- Trace retention and size policy.

`search.agentic.enabled` is `true`. `search.semantic.enabled` remains `false`;
semantic-query tool requests are rejected rather than pretending lexical
matching is an embedding result.

## Planned, Not Implemented

- Automatic weekly catalog-refresh scheduling.
- Backend deck CRUD, persistence, and typed mutation API.
- Browser-local deck import/migration into backend storage.
- Plaintext import and export.
- Full printing and finish selection.
- Mana curve, color production, probability, and functional analytics.
- Multi-select and bulk editing.
- Named deck snapshots and persisted mutation history.
- Pydantic AI deck assistant beyond the card-search contract foundation.
- Agent chat interface in the reserved right workspace.
- Typed agent tools for inspect, validate, search, propose patch, confirm, apply,
  and undo.
- Sonar web search and fetch-page tools.
- A permitted, stable EDHREC provider.

## Deferred

- Accounts, cloud sync, collaboration, and public deck discovery.
- Collection ownership and buy/sell cart workflows.
- Direct third-party account synchronization.
- Full playtest simulation.
- Automated EDHREC scraping.

## Important Current Boundaries

- Deck state is not stored by FastAPI. It lives in frontend `localStorage`.
- Backend deck Pydantic models exist, but no route or service owns mutations.
- The local catalog is a derived read model and can be rebuilt from Scryfall.
- Search is the only product API beyond health.
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
