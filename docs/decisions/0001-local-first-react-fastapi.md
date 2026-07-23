# ADR 0001: Local-First React And FastAPI Runtime

- Status: Accepted
- Date: 2026-07-23

## Context

The project is a private Commander deck builder for local personal use. It
needs a rich browser editing surface, Python access for later AI tooling, and a
clean separation between interaction state and external card providers.

Common development ports should be avoided because this repository is expected
to run beside other local tools.

## Decision

- Use React and TypeScript with Vite for the frontend.
- Use FastAPI and Pydantic for the backend.
- Keep the application single-user and local-first.
- Do not require accounts, Docker, or cloud infrastructure.
- Run on loopback by default:
  - Frontend `127.0.0.1:41737`
  - Backend `127.0.0.1:43127`
- Use one root runner to start and stop both services.
- Keep the working deck editor as the first screen.

## Consequences

Positive:

- The UI can evolve independently from provider and agent code.
- Python domain models can later be shared with Pydantic AI tools.
- Local setup remains small and inspectable.
- Uncommon ports reduce collisions.

Costs:

- Public contracts exist in both Python and TypeScript.
- Browser and backend lifecycles must be tested together.
- Local persistence needs explicit migration when backend storage arrives.

## Rejected Alternatives

- Frontend-only application: rejected because agent tools, provider isolation,
  and future persistence benefit from Python services.
- Backend-rendered UI: rejected because the editor requires dense,
  stateful interaction.
- Docker-first development: rejected as unnecessary friction for a private
  local project.
- Default ports such as 3000 and 8000: rejected to avoid common collisions.
