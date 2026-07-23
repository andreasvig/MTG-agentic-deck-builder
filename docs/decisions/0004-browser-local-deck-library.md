# ADR 0004: Browser-Local Deck Library As Transitional Persistence

- Status: Accepted (transitional)
- Date: 2026-07-23

## Context

The manual editor needed to become useful before backend persistence, catalog
sync, and agent tooling were designed. A private personal application can
deliver deck creation, editing, grouping, and undo through browser storage
without accounts or database migrations.

## Decision

- Persist the current deck library in browser `localStorage`.
- Use `manabase.deck-library.v2` as the active key.
- Read `manabase.active-deck.v1` only as a legacy migration source.
- Keep all current manual mutations in `useDeck.ts`.
- Store selected printing details with deck entries.
- Keep thirty prior deck snapshots per active session and deck.
- Treat this as a transitional application service, not the final agent
  mutation boundary.

## Consequences

Positive:

- Manual editing works now without backend schema work.
- The product remains private and local.
- Undo and migration behavior are easy to exercise in frontend tests.

Costs:

- Decks are tied to one browser profile.
- There is no cross-device access, backup, or transactional database.
- Undo history is not persisted across reloads.
- The backend and future agent cannot inspect or modify a deck.
- Stored card details can become stale.

## Migration Requirement

The future backend deck service must:

1. Accept and validate an import of `deck-library.v2`.
2. Preserve deck IDs, selected printings, custom groups, and timestamps where
   valid.
3. Reconcile missing or stale card details through the card provider.
4. Move unknown legacy placement to Not assigned.
5. Avoid silently deleting the browser copy before successful import.

This ADR should be superseded when backend deck persistence becomes the default.
