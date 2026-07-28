# MTG Agentic Deck Builder

## Goal

Build a local-first Commander deck builder inspired by Archidekt. The first
version should be a useful manual deck editor. A later version will add a chat
agent that can inspect a deck, explain suggestions, and propose safe edits.

This file defines product scope and sequence. It is not the implementation
ledger. Read [`docs/implementation-status.md`](docs/implementation-status.md)
for shipped, partial, and planned behavior and
[`docs/decisions/README.md`](docs/decisions/README.md) for durable decisions.

## Product Principles

- Local and single-user; no accounts or cloud sync.
- Commander-focused rather than a general-purpose MTG deck builder.
- Fast visual editing with card images, search, filters, and deck statistics.
- Support every legal Commander configuration rather than assuming one
  commander.
- Target state: deck rules and mutations live in the backend so the UI and
  agent share them. The current manual slice is browser-local.
- Agent edits are proposed as a visible diff and require confirmation.
- External data access is cached and isolated behind provider interfaces.

## Target Stack

- Frontend: React, TypeScript, and Vite. Shipped.
- Backend: FastAPI and Python. Search API shipped; deck API planned.
- Storage: SQLite. Planned.
- Card data: Scryfall authority with a derived local SQLite catalog. Bulk
  synchronization and local title search shipped.
- Pricing: Scryfall daily EUR estimates, cached per printing. Current display
  shipped; persistent cache/history planned.
- Development URLs:
  - Frontend: `http://127.0.0.1:41737`
  - Backend: `http://127.0.0.1:43127`

## MVP Scope

### Deck Management

- Create, rename, duplicate, and delete local decks.
- Select any legal command-zone configuration, including partners, named
  partners, Friends Forever, backgrounds, Doctor's companion, and a companion.
- Add, remove, and change card quantities.
- Use visual custom-group columns as the primary editing view, with a compact
  list view and derived card-type grouping available as toggles.
- Start each deck with Command zone and Not assigned groups, then let the user
  create functional groups such as ramp, removal, and draw.
- Keep cards movable only between custom groups; card-type grouping is derived
  from card data and cannot be edited.
- Persist all changes locally.

### Card Discovery

- Search every input as an exact, partial, segmented, or misspelled card title.
- Score the local SQLite title catalog with RapidFuzz `WRatio`.
- Rank the complete catalog without a score threshold or candidate cap.
- Apply local filters, then page canonical card results.
- Show the per-result coverage-aware title confidence while search debug mode
  is enabled; retain WRatio as separate internal ranking evidence.
- Filter every search by color identity using can-include or exact matching,
  including colorless, plus minimum/maximum mana value and EUR estimate.
- Show card image, mana cost, type, rules text, color identity, and legality.
- Filter results to the commander's color identity by default.
- Preserve the selected printing so its image and price are deterministic.

### Local Card Catalog

- Treat Scryfall as the authoritative source and SQLite as a derived read model.
- Stream the compressed `default_cards` dataset into SQLite during initial
  setup without loading the entire export into memory.
- Store card metadata and remote image URLs; do not download the complete image
  library.
- Use `oracle_id` for card identity and `scryfall_id` for a selected printing.
- Index names, rules text, type lines, colors, color identity, legality, mana
  value, keywords, sets, and finishes for local search.
- Refresh gameplay metadata weekly and after set releases.
- Perform imports atomically so an interrupted refresh keeps the prior catalog.
- Refresh explicitly from Scryfall bulk data; advanced live-query fallback is
  deferred until there is a concrete product need.
- Keep Scryfall-specific access behind a provider so the UI, rules service, and
  agent do not depend on transport details.

### Pricing

- Show Scryfall's current daily EUR estimate for the selected printing.
- Support non-foil and foil values through `prices.eur` and `prices.eur_foil`.
- Show individual card prices and the estimated total deck price.
- Refresh active-deck prices through the live Scryfall API once daily.
- Cache price snapshots with their source and observation timestamp.
- Link to the matching Cardmarket product through Scryfall's `cardmarket_id` or
  `purchase_uris.cardmarket` so the estimate can be verified before buying.
- Label these values as estimates rather than guaranteed marketplace offers.
- Keep the provider replaceable. MTGJSON's free daily `AllPricesToday` bulk file
  is a later option when exact Cardmarket trend semantics or price history
  justify the additional catalog-mapping work.
- Defer collection ownership and budget enforcement until a later phase.

### Commander Validation

- Validate deck size.
- Validate Commander legality and color identity.
- Validate compatibility between multiple commanders and command-zone cards.
- Validate singleton rules and cards with quantity exceptions.
- Show errors separately from warnings.
- Allow explicit Rule Zero overrides, but retain and display the underlying
  legality warning.

### Deck Insight

- Mana curve and color distribution.
- Card type and functional-category counts.
- Land and average mana-value summaries.
- Clear deck completion and validation status.

### Portability

- Import common plaintext deck lists.
- Export a canonical plaintext deck list.
- Defer Archidekt, Moxfield, file, and URL imports until a later phase.
- Defer direct third-party account sync until the local workflow is solid.

## Later Agent Phase

Add a deck-scoped chat assistant with tools that can:

- Inspect the current deck, commander, statistics, and validation results.
- Search Scryfall for legal cards.
- Suggest additions, removals, and one-for-one swaps.
- Explain synergy, curve, interaction, budget, and win-condition gaps.
- Propose a structured deck patch before making changes.
- Apply a confirmed patch through the same deck service used by the UI.
- Preserve an undoable change history.

The assistant will use Pydantic AI. Start with
`google/gemini-3.5-flash-lite` through OpenRouter at minimal reasoning effort,
then change models only when hands-on use exposes a concrete latency,
reliability, quality, or cost problem.

Planned tools:

- Inspect, validate, and summarize the current deck.
- Propose and apply typed deck patches through the deck service.
- Search Scryfall through a custom card-data tool.
- Search the web through a Sonar-backed tool.
- Fetch and extract a specific web page.
- Query EDHREC through a custom provider only after a permitted, stable access
  method is identified.

The recommendation layer should use provider interfaces. Scryfall is the first
supported card-data provider. Direct EDHREC scraping is not acceptable because
the site restricts automated queries.

## Target Architecture

```text
React UI
   |
FastAPI routes
   |
Deck and rules services ----- derived Scryfall SQLite catalog
   |
SQLite

Later:
Chat agent -> typed tools -> deck and rules services
```

The agent must not write directly to SQLite. All deck mutations should pass
through typed domain actions so manual and agent changes have identical
validation, history, and tests.

## Delivery Phases

### Phase 1: Manual Editor Foundation - Shipped

- React/FastAPI runtime on uncommon ports.
- Provider-neutral local SQLite title search.
- One fuzzy title path with filters, percentages, and a one-stage trace.
- Uncapped, threshold-free fuzzy-title ranking with local filters and numbered
  12-card **Load more** pages.
- Browser-local multi-deck library, custom groups, quantities, and undo.
- Visual/list layouts, derived card types, card dialog, desktop/mobile shells.
- Singleton and color-identity warnings.
- Backend, frontend, smoke, build, and Playwright verification.

### Phase 2: Backend Deck Foundation - Next

- Define SQLite deck repository and migrations.
- Define typed deck commands and mutation service.
- Import `manabase.deck-library.v2` safely.
- Preserve current UI behavior through the service migration.
- Persist atomic mutation history and deck snapshots.

### Phase 3: Complete Commander Rules

- Model command-zone eligibility and supported multi-commander configurations.
- Validate size, singleton exceptions, legality, color identity, and
  partner/background/companion compatibility.
- Separate errors, warnings, and explicit Rule Zero overrides.
- Use the same validation from UI and future agent tools.

### Phase 4: Local Card Catalog And Title Recall - Partially Shipped

- Shipped: stream Scryfall `default_cards` into a derived SQLite read model.
- Shipped: atomic timestamp-aware import and explicit refresh command.
- Shipped: preserve the same fuzzy scoring contract against the local catalog.
- Next: schedule weekly refreshes.
- Build a title-query evaluation corpus for a later semantic-routing threshold.
- Use that evidence to define a later weak-fuzzy-to-semantic fallback; do not
  impose a minimum score on the current title-ranking phase.
- Shipped: stricter preview confidence, one-tool agentic contracts, executable
  local/Scryfall tools, OpenRouter orchestration, progressive preview/final
  responses, complete debug traces, and saved ranked-ID sessions under ADR
  0009.
- Next: evaluate and implement a real semantic embedding index inside the local
  tool; keep `semantic_query` disabled until that index exists.

### Phase 5: Portability, Printing, Pricing, And Insight

- Add plaintext import/export with preview and unmatched-line reporting.
- Add complete printing and finish selection.
- Persist daily price observations and optional Cardmarket trend history.
- Add mana curve, color production, type, category, and completion analysis.

### Phase 6: Safe Agent

- Finalize typed deck-patch schemas.
- Add inspect, validate, Scryfall, Sonar, and fetch-page tools.
- Show agent proposals as confirmable diffs.
- Apply confirmed patches atomically through the deck service.
- Make each applied patch undoable as one operation.
- Add permitted EDHREC data only through a stable provider boundary.

### Phase 7: Later Experiments

- Power/bracket guidance after a product model is selected.
- Opening-hand and limited playtest views.
- Additional import formats.

## Current Implementation

The full current ledger lives in
[`docs/implementation-status.md`](docs/implementation-status.md). The critical
boundary is:

```text
Shipped: local-catalog card discovery and browser-local manual editing
Planned: backend deck persistence, complete rules, import/export, analytics,
         automatic catalog scheduling, and agent chat
```

## Out of Scope for MVP

- User accounts, hosted deployment, and multiplayer collaboration
- Card collection and inventory management
- Buying cards or marketplace integration
- Full game simulation or rules engine
- Power-level or Commander-bracket scoring
- Opening-hand and playtest views
- Archidekt, Moxfield, file, and URL imports
- Direct EDHREC scraping

## Open Decisions

- Whether deck pricing uses the selected printing or the cheapest eligible
  printing by default
- Whether to add MTGJSON Cardmarket trend prices and history after the MVP
- Exact Sonar web-search provider and API
- Permitted source for commander-specific recommendation data
- Desired power-level or Commander-bracket model for the later phase
- Conflict semantics when an agent patch is applied to a deck that changed
  after the proposal
