# MTG Agentic Deck Builder

## Goal

Build a local-first Commander deck builder inspired by Archidekt: fast manual
editing today, strong card discovery, and eventually a deck-scoped assistant
that can explain and propose safe changes.

This file is the forward-looking product roadmap. Read
[`docs/implementation-status.md`](docs/implementation-status.md) for the
shipped boundary and [`docs/decisions/README.md`](docs/decisions/README.md) for
durable technical decisions.

## Product Principles

- Local and single-user; no accounts or cloud sync.
- Commander-focused rather than a general-purpose MTG deck builder.
- Card-first visual editing with a compact list alternative.
- Support legal multi-card command zones rather than assuming one commander.
- Keep card-data reads local during normal use.
- Route future deck mutations through one typed backend service shared by the
  UI and assistant.
- Show assistant changes as a visible diff and require confirmation.

## Shipped Foundation

### Editor

- Browser-local multi-deck library.
- Command zone, Not assigned, and user-created custom groups.
- Visual and list layouts with Custom and derived Card types grouping.
- Add, remove, quantity, movement, sorting, prices, and session undo.
- Singleton and commander color-identity warnings.
- Desktop and mobile search, inspection, and editing workflows.

### Card Search

- Scryfall `default_cards` bulk data imported atomically into local SQLite.
- One representative printing per Oracle card in search results.
- Complete-catalog RapidFuzz title ranking without a result threshold or
  candidate-pool cap.
- Six-card pages with local color, mana-value, and EUR filters.
- A 75% preview-confidence boundary used only to decide whether the first six
  fuzzy results are strong enough; it never truncates the fuzzy ranking.
- Progressive agentic search for weak-title and natural-language queries.
- Exactly one `search_local_cards` tool call per agent round.
- Cached agent-ranked pages followed by explicit user-triggered continuation
  rounds that exclude cards already shown or examined.
- Always-on local semantic sorting after structured filters, with no similarity
  cutoff.
- Seven-step debug traces plus complete secret-redacted JSONL diagnostics.

Normal search does not query Scryfall. Scryfall is used for explicit catalog
refreshes and remote card images.

## Target Architecture

```text
React UI
  |- current browser-local deck library
  `- card search drawer
          |
          v
FastAPI
  |- local SQLite card catalog
  |- fuzzy title search
  |- local semantic vector sidecar
  `- one-tool OpenRouter search agent

Next:
React UI -> typed deck/rules service -> SQLite deck storage
Deck assistant -> the same typed deck/rules service
```

The assistant must never write directly to SQLite. Manual and assistant changes
must have identical validation, persistence, history, and undo behavior.

## Roadmap

### 1. Backend Deck Foundation — Next

- Define the SQLite deck repository and migrations.
- Define typed deck commands and one mutation service.
- Import `manabase.deck-library.v2` safely.
- Preserve current UI behavior during the migration.
- Persist atomic mutation history and named snapshots.

### 2. Complete Commander Rules

- Validate 100-card size, singleton exceptions, format legality, and color
  identity.
- Validate commander eligibility and partner, background, companion, and other
  supported command-zone combinations.
- Separate errors, warnings, and explicit Rule Zero overrides.
- Use the same validation from the UI and future assistant tools.

### 3. Portability, Printing, Pricing, And Insight

- Add plaintext import/export with preview and unmatched-line reporting.
- Add complete printing and finish selection.
- Persist timestamped price observations if trend history proves useful.
- Add mana curve, color production, card-type, functional-category, and deck
  completion analysis.
- Add multi-select and bulk editing where it shortens repeated work.

### 4. Safe Deck Assistant

- Add a deck-scoped chat interface in the reserved workspace.
- Give it typed tools to inspect the deck, run shared validation, search the
  local card catalog, and propose a deck patch.
- Show additions, removals, swaps, and explanations before confirmation.
- Apply confirmed patches atomically through the deck service.
- Make each applied patch undoable as one operation.

The current OpenRouter card-search implementation does not commit the future
deck assistant to a particular orchestration framework.

### 5. Search Refinement

- Build a representative query evaluation set before changing the 75% routing
  boundary.
- Evaluate semantic-sort quality and tune the embedding document or model only
  against measured queries.
- Add a trace retention and size policy.
- Schedule catalog refreshes only when the local workflow needs automation.

## Deferred

- Accounts, hosted collaboration, public deck discovery, and cloud sync.
- Collection inventory and marketplace cart workflows.
- Direct third-party account synchronization.
- Full game simulation and automated playtesting.
- Power or bracket scoring until a clear product model is chosen.
- Automated scraping of recommendation sites.

## Open Decisions

- Whether deck pricing defaults to the selected printing or the cheapest
  eligible printing.
- Whether price history provides enough value to add another data provider.
- How to handle a confirmed assistant patch when the deck changed after the
  proposal was created.
- Which evaluation cases should govern future semantic-model changes.
