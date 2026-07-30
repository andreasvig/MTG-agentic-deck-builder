# ADR 0013: Recoverable Deck Deletion And Command-Zone Guards

- Status: Accepted (transitional)
- Date: 2026-07-29

## Context

The browser-local editor allowed decks to be created and renamed but not
deleted. It also treated the Command zone like any other custom placement,
which allowed extra cards and quantities even when they could not legally be
co-commanders.

Decks still live only in browser storage, so both behaviors must currently be
owned by the frontend deck application service. They must later move unchanged
to the shared backend deck/rules service.

## Decision

- Delete only after a deck-specific confirmation.
- Select a deterministic neighboring deck after deletion.
- If the final deck is deleted, create one empty replacement so the editor
  always has an active deck.
- Retain the most recently deleted deck in memory and offer a current-session
  restore. Remove an untouched auto-created replacement when restoring.
- Keep command-zone quantities at one.
- Allow one command-zone card without adding new single-commander eligibility
  checks in this slice.
- Allow a second command-zone card only when both cards are Commander-legal and
  form one of these recognized pairings:
  - both have Partner;
  - both have Friends forever;
  - reciprocal Partner with names;
  - Choose a Background plus a legendary Background;
  - Doctor's companion plus a legendary Time Lord Doctor.
- Reject a third command-zone card.
- Apply the same guard in `useDeck` to search additions, group movement,
  drag/drop, and quantity changes.
- Preserve invalid legacy data rather than silently deleting it, but mark the
  deck for review and reject further invalid additions.

## Consequences

Positive:

- Accidental deck deletion requires confirmation and remains recoverable during
  the session.
- Every current manual mutation path enforces the same command-zone limit.
- Common legal co-commander combinations remain available.
- Existing invalid browser data is surfaced without destructive migration.

Costs:

- Restore is not persisted across reloads.
- Oracle-text parsing is a transitional rules implementation.
- Single-commander eligibility, Rule Zero overrides, and unusual or future
  pairing mechanics remain incomplete.

## Migration Requirement

The future backend deck service must own deletion recovery and Commander rules
before the browser library migrates. The frontend must then call typed
operations rather than duplicate these checks.
