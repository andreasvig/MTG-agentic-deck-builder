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

## Test And Build

```bash
npm test
npm run build
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
[`changelog.md`](changelog.md).
