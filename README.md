# MTG Agentic Deck Builder

A private, local-first Commander deck builder with a React frontend and a
FastAPI backend. The initial application focuses on manual deck building; the
planned agent will use the same validated deck operations as the UI.

## Prerequisites

- Node.js 22.12 or newer, with npm
- [uv](https://docs.astral.sh/uv/)

`uv` installs a compatible Python version when one is not already available.
Docker is not required.

## Setup

```bash
git clone git@github.com:andreasvig/MTG-agentic-deck-builder.git
cd MTG-agentic-deck-builder
npm run setup
```

The checked-in defaults are suitable for local development. To override them,
create a local environment file:

```bash
cp .env.example .env
```

## Run

Start both development servers from the repository root:

```bash
npm run dev
```

- Frontend: <http://127.0.0.1:41737>
- Backend health: <http://127.0.0.1:43127/api/v1/health>

The runner checks that both ports are free before starting. `Ctrl+C` stops both
services, including their reload subprocesses.

## Current Workflow

- Search Scryfall-backed card data by exact name, typo-tolerant name, natural
  deck-building intent, or Scryfall syntax.
- Narrow every search by allowed or exact color identity, mana value, and daily
  Scryfall EUR estimate.
- Rank intent candidates with the local `BAAI/bge-small-en-v1.5` embedding
  model, then optionally rerank a bounded result set through OpenRouter.
- Search and add cards through one detailed in-context workflow.
- Edit quantities and sections, remove cards, and undo recent changes.
- Switch between visual category stacks and a dense list.
- Group, sort, and locally filter the current deck.
- Inspect card text, printing details, Commander legality, and daily EUR
  estimates.
- Warn before and after adding cards outside the command-zone color identity.
- Keep one local Commander deck across browser sessions.

The current provider returns one representative printing per gameplay card.
Full printing and finish selection is tracked as the next search enhancement.
The semantic layer currently ranks a live Scryfall candidate page; the local
SQLite catalog remains the planned path to broader semantic recall. Complete
Commander validation, imports, analytics, and the chat agent also remain
planned phases.

The public embedding model runs locally and does not require a Hugging Face
token. Set `OPENROUTER_API_KEY` to enable the optional
`google/gemini-3.5-flash-lite` reranker, which uses minimal reasoning. Exact,
fuzzy, and explicit Scryfall searches do not call OpenRouter.

Model, provider, and reasoning can be pinned independently:

```dotenv
MTG_OPENROUTER_MODEL=openai/gpt-oss-120b
MTG_OPENROUTER_PROVIDER=Cerebras
MTG_OPENROUTER_REASONING_EFFORT=low
MTG_OPENROUTER_MAX_TOKENS=2200
```

## Search Debugging

Open search settings and enable **Search debug log** to trace individual
searches. The choice is stored locally in the browser. To make tracing the
default for every client, enable it in `.env`, then restart the servers:

```dotenv
MTG_SEARCH_DEBUG_ENABLED=true
MTG_SEARCH_DEBUG_LOG_PATH=local-data/search-debug.jsonl
MTG_SEARCH_DEBUG_RESULT_LIMIT=25
```

Debug responses expose a compact stage and timing summary in the search
drawer. The append-only JSONL file records the raw query and filters,
classification decision, generated Scryfall query, provider ordering and
counts, per-layer timings, before/after rankings, rank deltas, warnings, and
final results. For the LLM layer it also records the complete parsed and raw
JSON request and response bodies, response status, model, provider, and
reasoning effort. Credentials and authorization headers are never included.

Each line is an independent JSON object, so an interrupted write cannot corrupt
earlier searches. Read the complete log as a JSON array with:

```bash
jq -s '.' local-data/search-debug.jsonl
```

Run the live reranker latency comparison with:

```bash
npm run benchmark:rerankers
```

The summary is written to `local-data/search-reranker-benchmark.json`; its
complete request and response traces are written to
`local-data/search-reranker-benchmark.jsonl`.

## Test And Build

```bash
npm test
npm run build
npm run test:e2e
```

Run one side independently when narrowing a failure:

```bash
uv --directory backend run pytest
npm test --prefix frontend
```

## Project Layout

```text
backend/   FastAPI application and domain services
frontend/  React and Vite application
scripts/   Root development utilities
```

Product scope, architecture decisions, and milestones live in
[`plan.md`](plan.md). Notable changes are recorded in
[`changelog.md`](changelog.md). The researched interaction target and explicit
parity boundary are recorded in
[`docs/archidekt-ux-benchmark.md`](docs/archidekt-ux-benchmark.md).
