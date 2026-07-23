# MTG Agentic Deck Builder

## Goal

Build a local-first Commander deck builder inspired by Archidekt. The first
version should be a useful manual deck editor. A later version will add a chat
agent that can inspect a deck, explain suggestions, and propose safe edits.

## Product Principles

- Local and single-user; no accounts or cloud sync.
- Commander-focused rather than a general-purpose MTG deck builder.
- Fast visual editing with card images, search, filters, and deck statistics.
- Support every legal Commander configuration rather than assuming one
  commander.
- Deck rules and mutations live in the backend so the UI and agent share them.
- Agent edits are proposed as a visible diff and require confirmation.
- External data access is cached and isolated behind provider interfaces.

## Proposed Stack

- Frontend: React, TypeScript, and Vite
- Backend: FastAPI and Python
- Storage: SQLite
- Card data: local SQLite catalog synchronized from Scryfall `default_cards`
- Pricing: Scryfall daily EUR estimates, cached per printing
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

- Search by exact card name, fuzzy card name, natural deck-building intent, or
  explicit Scryfall syntax.
- Compile common intents such as ramp, card draw, cheap creature types,
  finishers, untap effects, and +1/+1 counter multiplication into broad
  Scryfall candidate queries.
- Rank intent candidates locally with a small Hugging Face embedding model.
- Optionally apply a bounded OpenRouter rerank with
  `google/gemini-3.5-flash` at minimal reasoning effort.
- Filter every search by color identity using can-include or exact matching,
  including colorless, plus minimum/maximum mana value and EUR estimate.
- Support useful Scryfall-style filters.
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
- Use live Scryfall calls for new cards, advanced queries not supported locally,
  and fallback when a local lookup misses.
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

The assistant will use Pydantic AI. Start with `google/gemini-3.5-flash`
through OpenRouter at minimal reasoning effort, then change models only when
hands-on use exposes a concrete latency, reliability, quality, or cost problem.

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

## Initial Architecture

```text
React UI
   |
FastAPI routes
   |
Deck and rules services ----- Scryfall provider/cache
   |
SQLite

Later:
Chat agent -> typed tools -> deck and rules services
```

The agent must not write directly to SQLite. All deck mutations should pass
through typed domain actions so manual and agent changes have identical
validation, history, and tests.

## Milestones

1. Scaffold React and FastAPI applications with the uncommon development ports.
2. Add the Scryfall provider and atomic `default_cards` SQLite synchronization.
3. Add indexed local card search with live Scryfall fallback.
4. Implement daily EUR price refreshes and deck price totals.
5. Implement decks, all command-zone configurations, persistence, and
   plaintext import/export.
6. Add validation, categories, statistics, and the visual/list editing views.
7. Add focused backend and frontend tests for deck operations.
8. Add additional import formats.
9. Design Pydantic AI tools and a preview/confirm/undo workflow.
10. Add the chat assistant and permitted recommendation providers.
11. Add power-level guidance and an opening-hand/playtest view.

## Current Implementation

Completed in the first usable slice:

- React and FastAPI scaffolds on ports `41737` and `43127`.
- A typed, provider-neutral card-search boundary backed by live Scryfall search.
- Layered exact, fuzzy, intent, and explicit-Scryfall search routing.
- Local `BAAI/bge-small-en-v1.5` semantic ranking for intent candidates, with a
  bounded optional Gemini 3.5 Flash rerank through OpenRouter.
- Search filters for subset or exact color identity, colorless cards, mana
  value, and Scryfall EUR estimates.
- Search loading, empty, invalid-query, provider-error, and pagination states.
- A single detailed in-context search drawer with inline quantities.
- A persistent local deck library with creation, switching, renaming, commander
  thumbnails, add, remove, custom-group move, quantity, and 30-step undo.
- Command zone, Not assigned, user-created custom groups, and singleton warnings.
- Visual custom-group stacks, derived card-type grouping, dense list mode,
  sorting, and drag-and-drop placement between custom groups.
- Drop-to-create custom groups that move the dropped card in the same undoable
  deck change.
- Centered card-detail dialogs, selected-printing EUR estimates, and
  deck/custom-group totals.
- Command-zone color-identity validation in search, deck cards, and inspection.
- Purpose-built desktop and mobile layouts with keyboard-contained drawers.
- Backend, frontend, process-runner, production-build, and browser workflow
  verification.

The current live search is the provider foundation for milestones 2 and 3, not
their completion. The atomic local Scryfall catalog importer and indexed SQLite
search still come next. Full deck management and Commander validation also
remain milestone work; the current local deck proves the editor interaction
model without pretending to complete those broader contracts.

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
