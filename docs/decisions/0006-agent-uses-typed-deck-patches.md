# ADR 0006: Agent Uses Typed, Confirmed Deck Patches

- Status: Proposed
- Date: 2026-07-23

## Context

The planned Pydantic AI assistant should inspect decks, explain suggestions,
and edit them. Direct database writes or UI automation would bypass validation,
make changes difficult to review, and create different behavior from manual
editing.

## Proposed Decision

- Define typed deck commands and patch schemas in the backend domain.
- Route manual UI and agent mutations through the same deck service.
- Separate proposal from application.
- Show additions, removals, quantity changes, group changes, and validation
  effects as a visible diff.
- Require user confirmation before applying an agent patch.
- Apply a patch atomically.
- Record enough history to undo the complete patch as one operation.
- Let agent tools inspect and validate but never write SQLite directly.
- Keep Scryfall, web search, page fetch, and future EDHREC access behind typed
  tool/provider boundaries.

## Consequences

Positive:

- Manual and agent edits obey identical rules.
- Risky changes remain reviewable.
- Tests can exercise commands independently from chat.
- Model changes do not change persistence authority.

Costs:

- Backend deck services and persistence must exist before full agent editing.
- Patch schemas require versioning and conflict handling.
- Confirmation and undo add UI and service complexity.

## Prerequisites

- Backend deck repository.
- Typed deck mutation service.
- Full Commander validation model.
- Browser-local deck migration.
- Persisted mutation history or snapshots.
- Agent-safe read tools and structured output validation.

## Open Questions

- Patch conflict behavior when the deck changes after proposal.
- Whether suggestions can be grouped into independently confirmable chunks.
- How provenance and external evidence are attached to suggestions.
- How Rule Zero overrides are represented.
- What EDHREC access method is permitted and stable.
