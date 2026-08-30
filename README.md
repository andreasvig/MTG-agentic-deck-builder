# MAGE

### Magic's Agentic Gathering Engine

MAGE is a local-first Commander deck builder built around a simple idea: an AI
agent should not sit beside a product as a generic chat box. It should understand
the product, use the same domain tools as the user, and make changes that remain
visible and reversible.

The result is a complete deck-building workspace with fast manual editing,
intent-based card search, and a deck agent that can inspect a list, research an
idea, find cards, explain its reasoning, and edit the deck through the same typed
operations as the interface.

This is an experimental personal project, but the editor, search system, and deck
agent are working software with a substantial automated test suite.

## The interesting parts

### Search intent instead of filter syntax

Traditional card search asks the player to translate an idea into names, rules
text, types, colors, and price controls. MAGE lets the player state the intent:

> Cards which untap Elves for less than €1

The search model compiles that request into one typed local-catalog call:

```text
search_local_cards({
  semantic_sort: "untap target creature, untap another creature, repeatable untap",
  price_eur: { maximum: 1 },
  sort_by: "semantic"
})
```

The local engine applies hard filters, semantically orders the bounded candidate
set, and gives the model only those candidates to rerank. The model interprets;
SQLite and typed contracts keep it grounded.

### An agent with product tools

The deck agent can:

| Understand | Research | Act |
| --- | --- | --- |
| `read_deck` | `search_web` | `edit_deck` |
| `see_cards` | `read_page` | `edit_deck_text` |
| `search_cards` |  |  |
| `read_history` |  |  |

A request such as “add a little more card draw” can become a real loop: read the
deck, infer what kind of draw suits the commander and curve, search the local
catalog, compare candidates, and apply the chosen cards. Agent edits use the same
deck reducer as manual edits, enter the durable history, and remain undoable.

### Local-first, observable, reversible

- Decks, conversations, drafts, and edit history live in browser `localStorage`.
- Card data, embeddings, tags, and EDHREC caches live in ignored local SQLite
  sidecars.
- Search exposes a focused seven-step trace and provider-reported cost in Debug
  mode.
- The browser—not the model or backend—is the final authority that applies deck
  edits.
- Manual and agent changes share one history model, including undo, redo, and
  direct travel to a recorded diff.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 22.12 or newer
- npm
- [uv](https://docs.astral.sh/uv/)
- Google Chrome only if you want to run the Playwright end-to-end tests

Docker is not required.

### 1. Install the project

```bash
git clone https://github.com/andreasvig/MTG-agentic-deck-builder.git
cd MTG-agentic-deck-builder
npm run setup
cp .env.example .env
```

`npm run setup` creates the backend environment from `backend/uv.lock` and
installs the frontend dependencies.

### 2. Configure AI features

Title search and manual deck editing work without an API key. To use natural-
language search or the deck agent, add an [OpenRouter](https://openrouter.ai/) key
to `.env`:

```dotenv
OPENROUTER_API_KEY=your_key_here
```

Models, prompts, tool descriptions, limits, and ranking behavior live in
[`config.yaml`](config.yaml).

### 3. Build the local card catalog

```bash
npm run catalog:sync
```

This downloads Scryfall's bulk card data, selects one representative paper
printing per Oracle card, writes the local SQLite catalog, downloads the configured
embedding model, and builds the semantic index. Later runs reuse current artifacts.

Optional: add Scryfall Tagger labels and card relationships:

```bash
npm run tagger:sync
```

That sync is resumable. It also refreshes semantic documents when the added Tagger
concepts change them.

### 4. Run MAGE

```bash
npm run dev
```

Open <http://127.0.0.1:41737>.

The paired development runner starts and stops both services:

- Frontend: <http://127.0.0.1:41737>
- Backend health: <http://127.0.0.1:43127/api/v1/health>
- OpenAPI: <http://127.0.0.1:43127/api/v1/openapi.json>

Ports and origins can be changed in `.env`.

## What is included

- A browser-local multi-deck Commander library
- Visual card stacks and a compact list view
- Drag-and-drop command-zone editing
- Quantity controls, price totals, warnings, and card details
- Plain-text, Arena, and CSV export plus a prefilled TCGplayer cart
- Complete-catalog fuzzy title matching with typo tolerance
- Color, legality, mana-value, type, subtype, tag, and EUR-price filters
- Local semantic card sorting with no relevance cutoff
- Optional EDHREC commander, theme, synergy, and inclusion evidence
- Optional Tagger labels, relationships, and semantic concepts
- Progressive one-tool agentic search with continuation rounds
- An eight-tool, streamed, deck-scoped agent
- Per-deck agent conversations and concurrent background turns
- Auto-applied, inspectable, undoable agent edits
- Debug traces using secret-redacted local diagnostics

The exact shipped boundary and known gaps are maintained in
[`docs/implementation-status.md`](docs/implementation-status.md).

## How it is built

```text
React 19 + TypeScript + Vite
  ├─ deck library, agent conversations, and edit history in localStorage
  ├─ manual editing, search UI, traces, and streamed agent events
  └─ applies every manual or agent-authored deck operation
                         │
                         │ JSON + server-sent events
                         ▼
FastAPI + Pydantic
  ├─ local SQLite card catalog
  ├─ RapidFuzz title matching and typed hard filters
  ├─ local FastEmbed semantic index
  ├─ optional Tagger and EDHREC sidecars
  ├─ bounded OpenRouter search orchestration
  └─ deck-agent tool loop over posted deck and history snapshots
```

The backend does not persist or mutate decks. For each turn, the browser posts the
relevant deck snapshot and bounded history; writing tools return typed edit events,
and the browser decides whether they are valid to apply.

For module boundaries, contracts, failure behavior, and the persistence target,
read [`docs/architecture.md`](docs/architecture.md).

## Development

```bash
# Backend tests + frontend tests + paired-server smoke test
npm test

# Type-check and build the frontend
npm run build

# Browser end-to-end tests
npm run test:e2e

# Backend lint
backend/.venv/bin/python -m ruff check backend/src backend/tests
```

Useful maintenance commands:

```bash
npm run catalog:sync  # refresh cards and semantic index
npm run tagger:sync   # resume/refresh optional Tagger data
npm run symbols:sync  # refresh the committed card-symbol asset set
```

Repository map:

```text
backend/       FastAPI application, providers, domain contracts, and tests
frontend/      React application, browser domain model, and tests
contracts/     Cross-runtime replay fixtures
docs/          Architecture, search internals, development guide, and ADRs
e2e/           Playwright flows
scripts/       Development runner, smoke test, and symbol sync
config.yaml    Search and deck-agent behavior
plan.md        Product direction and deferred scope
```

Start with [`docs/development.md`](docs/development.md) before making a larger
change. Durable product and architecture choices are recorded in the
[`docs/decisions`](docs/decisions/README.md) index.

## Current boundaries

- Decks are browser-local; there is no account system, cloud sync, or backend deck
  database.
- The deck agent is desktop-only.
- Deck import and analytics are not implemented.
- Commander legality and color identity are surfaced as warnings in some editing
  paths rather than enforced as a complete rules engine.
- Agent calls send the labelled request context—and for deck turns, the posted deck
  snapshot and bounded conversation—to the configured model provider. Local-first
  persistence does not mean model calls are offline.
- EDHREC and Tagger are optional enrichment sources. The core catalog remains
  Scryfall-derived and normal search degrades when enrichment is unavailable.

## Contributing

Issues and focused pull requests are welcome. Keep the current architecture and
product invariants in [`AGENTS.md`](AGENTS.md) in view, update documentation with
behavioral changes, and include tests that fail when the new contract is broken.

MAGE is unofficial fan software and is not endorsed by Wizards of the Coast.
Magic: The Gathering and its associated properties belong to Wizards of the Coast.
Card data and images are provided by [Scryfall](https://scryfall.com/).
