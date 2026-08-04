# ADR 0046: The Deck Description Is Shared Intent

- Status: Accepted
- Date: 2026-08-04

## Context

A card list records what a deck contains, but not why it exists. Power target, desired play
pattern, pilot complexity, interaction tolerance, combo length, budget, exclusions and open
decisions otherwise survive only in chat history. That is poor memory for both participants:
the user cannot inspect it at a glance, and the agent may lose it when the transcript window
moves on.

The description also has two audiences. A polished player-facing summary alone loses useful
unresolved constraints; an append-only scratchpad becomes a diary nobody can reliably read.

## Decision

Every deck has one plain-text `description`, at most 2,000 characters. It appears immediately
under the deck name, preserves line breaks, and collapses to three lines with **See all**. The
user edits the whole value directly.

The field is a shared current brief: polished enough to read, with concise open notes where an
unresolved decision matters. It is rewritten into one current account, never appended as a
chronological log. It does not hold hidden model reasoning, temporary tasks, unverified web
claims, or prose that merely repeats the card list.

The agent receives the name and description on every turn and may call
`edit_deck_text(name, description, reason)`. Supplied values are full replacements; omitted
values stay unchanged, and both may change atomically. The edit is auto-applied like
`edit_deck`, appears in the transcript, records the agent's reason, and is one undo step.

The agent maintains the brief proactively when the user reveals durable intent. It may freely
replace the exact default name **Untitled Commander** once the deck's identity is clear. A real
name is changed only on explicit user instruction.

Description changes bump `updated_at`. A prior deck-dependent replay is therefore stale after
the brief changes, which is correct: advice answered under a different intent is an observation
of a different deck even when no card moved.

## Consequences

- Decks written before this field migrate to an empty description without changing the storage
  key.
- History diffs now model cards, name and description. Forward replay, inversion and idempotence
  cover all three, preserving the invariant that Undo models every mutable `Deck` field.
- The backend still stores no deck. It validates and emits the requested replacement; the
  browser applies it to the deck that owns the turn, including a background deck.
- The description is durable local state, but remains subject to the browser-local persistence
  limitations of the rest of the deck library.
