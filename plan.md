# MAGE — Magic's Agentic Gathering Engine

## Goal

Build a private, local-first Commander deck builder with fast manual editing,
strong card discovery, and a deck-scoped agent that can inspect, research, and
change the same deck the user is editing.

This file is the forward-looking product roadmap. Read
[`docs/implementation-status.md`](docs/implementation-status.md) for the exact
shipped boundary and [`docs/decisions/README.md`](docs/decisions/README.md) for
durable product and architecture decisions.

## Product Principles

- Local and single-user; no accounts or cloud sync in the current product.
- Commander-focused rather than a general-purpose MTG deck builder.
- Card-first visual editing with a compact list alternative.
- One placement axis: Command zone or deck. Card-type columns are derived, not
  user-authored categories.
- Support legal multi-card command zones rather than assuming one commander.
- Keep canonical card data and typed search local; make optional community
  enrichment explicit, bounded, cached, and safely degradable.
- Agent edits apply immediately through the browser's typed deck operations and
  are protected by the same durable history as manual edits. Do not restore the
  superseded proposed-patch/confirmation flow without a new product decision.
- Route future persisted deck mutations through one typed backend service shared
  by the UI and agent. Neither should write directly to SQLite.
- Keep the deck's shared brief as current intent, not an append-only chat diary.

## Shipped Foundation

### Editor

- Browser-local multi-deck library with create, switch, inline rename,
  confirm-delete, and current-session restore.
- One derived card-type grouping under a permanent Command zone heading; custom
  groups and the maybeboard are not part of the active model.
- Stacked visual and dense list views, card movement between the two sections,
  quantity editing, price totals, and mana-cost/name/price sorting.
- Durable per-deck edit history with back, forward, and a jump to any retained
  diff. History and cursor position survive reload.
- Singleton and commander color-identity warnings plus recognized Partner,
  Partner with, Friends forever, Background, and Doctor's companion pairs.
- A 2,000-character shared Markdown intent brief, edited whole by the user or
  maintained by the deck agent, and recorded in the same history as card edits.
- Plain-text, MTG Arena, and CSV export, plus a prefilled TCGplayer cart.
- Paper/ink visual system and a hand-drawn 12x12 pixel icon set.

### Card Search And Data

- Scryfall `default_cards` imported atomically into a local SQLite catalog, one
  cheapest ordinary printing per Oracle card.
- Complete-catalog RapidFuzz title ranking, local filters, six-card pages, and
  progressive agentic search for weak-title or natural-language requests.
- Exactly one `search_local_cards` call per search-agent round, local semantic
  sorting with no cutoff, and explicit continuation rounds after cached pages.
- Optional resumable Tagger sidecar for labels, relationships, filters, and
  bounded semantic-document concepts.
- Optional on-demand EDHREC commander/theme and similar-card caches with visible
  fallback when unavailable.
- Interface-wide debug mode, focused seven-step traces, provider-reported cost,
  and complete secret-redacted JSONL diagnostics.

### Deck Agent

- Desktop chat panel with one persisted conversation, draft, cost total, and
  running turn per deck; up to three decks may run concurrently.
- Streamed tools and prose, interruption that preserves completed work, and
  replay of completed calls with stale deck-dependent results substituted.
- Eight tools: `read_deck`, `see_cards`, `search_cards`, `read_history`,
  `search_web`, `read_page`, `edit_deck`, and `edit_deck_text`.
- Card edits and name/brief replacements auto-apply to the deck that started the
  turn as one reducer action, one history entry, and one undoable step.
- Local catalog data remains authoritative. Sonar and fetched pages are research
  leads, with known deck sites read through structured adapters where possible.

## Current And Target Architecture

```text
Current
Browser localStorage owns decks, shared briefs, chats, and edit history
Browser deck store applies manual and agent edits
FastAPI owns card discovery and resolves deck-agent tool events from posted snapshots
Local SQLite owns derived card/search/enrichment data

Next persistence boundary
React UI and deck agent
  -> typed backend deck/rules service
  -> SQLite deck repository and mutation history
```

The migration must preserve existing browser libraries, descriptions, histories,
and chat ownership. The current agent event contract remains useful during the
migration: a successful write must still be atomic, deck-scoped, accurately
reported, and undoable.

## Roadmap

### 1. Backend Deck Foundation — Next

- Define the SQLite deck repository and migrations.
- Define typed deck commands and one mutation service.
- Import `manabase.deck-library.v2`, descriptions, and browser-local history
  without deleting the local source before server import succeeds.
- Preserve current UI behavior and agent ownership while moving authority.
- Persist atomic mutation history and named snapshots.

### 2. Complete Commander Rules

- Validate 100-card size, singleton exceptions, format legality, and color
  identity through a shared result model.
- Validate single-commander eligibility and remaining special or future
  command-zone combinations.
- Separate errors, warnings, and explicit Rule Zero overrides.
- Keep manual and agent edits on the same validation boundary.

### 3. Portability, Printing, Pricing, And Insight

- Add plaintext import with preview and unmatched-line reporting; export is
  already shipped.
- Add complete printing and finish selection.
- Persist timestamped price observations only if trend history proves useful.
- Add mana curve, color production, probability, functional-category, and deck
  completion analysis.
- Add multi-select and bulk editing where it shortens repeated work.

### 4. Deck-Agent Hardening

- Add a mobile entry point.
- Let the rail stop a background turn and surface a background failure without
  opening that deck first.
- Add full-reload browser coverage for interrupted-turn replay.
- Build an evaluation set for deck advice, tool choice, and edit quality before
  changing the prompt or model from anecdotes.
- Decide whether unresolved braced card names need debug-visible diagnostics.

### 5. Search Refinement

- Build a representative query evaluation set before changing the 75% routing
  boundary, semantic document, or embedding model.
- Add a trace retention and size policy.
- Schedule catalog refreshes only when the local workflow needs automation.
- Revisit Tagger descriptions or relationship-based retrieval only against
  measured search failures.

## Deferred

- Accounts, hosted collaboration, public deck discovery, and cloud sync.
- Collection inventory and third-party account synchronization.
- Full game simulation and automated playtesting.
- Power or bracket scoring until a clear product model is chosen.
- Bulk or background scraping of recommendation sites.
- A model spend cap; cost is reported rather than enforced today.

## Open Decisions

- Whether backend persistence should import browser history as authoritative
  history or as a one-time legacy snapshot.
- Whether deck pricing should continue following the selected printing once full
  printing choice exists, and whether price history merits another provider.
- Which evaluation cases should govern future search-model and deck-agent changes.
- Whether Tagger descriptions or relationship classifiers should support a
  separate concept vector or exact candidate expansion.
- How a mobile deck-agent entry point shares space with the existing deck-action
  toolbar without pushing the deck out of view.
