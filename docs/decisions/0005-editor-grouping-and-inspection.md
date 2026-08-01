# ADR 0005: Custom Groups, Derived Types, And Modal Inspection

- Status: Grouping decisions superseded by [ADR 0037](0037-one-placement-axis-and-a-commander-the-agent-can-set.md); the rest accepted
- Date: 2026-07-23

## Context

Early editor iterations exposed fixed categories, a maybeboard, redundant Quick
Add, a local deck filter, and a persistent right inspector. These controls made
the workspace busier and conflicted with the intended functional deck-building
workflow and later agent chat.

## Decision

- Use one **Add cards** button that opens the focused search popup; remove
  separate Quick Add and persistent search fields.
- Offer two grouping modes:
  - Custom: editable placement.
  - Card types: derived, read-only placement.
- Start Custom grouping with:
  - Command zone.
  - Not assigned.
  - An always-available Add custom group slot.
- Allow card movement only between custom groups.
- Support drag-to-create a custom group.
- Remove the standalone maybeboard from the active editor model.
- Open card details in a centered dialog.
- Reserve the workspace right side for later agent chat.
- Keep deck creation in the left deck rail and use commander art as the deck
  thumbnail.

## Consequences

Positive:

- Functional groups such as ramp, draw, and removal match Commander planning.
- Derived type grouping cannot corrupt placement.
- The primary search and editing paths are clearer.
- The future agent has a dedicated spatial destination.

Costs:

- Users who rely on maybeboards need a future alternative such as snapshots or
  sideboards with explicit semantics.
- A modal interrupts scanning more than a permanent inspector.
- Legacy storage requires migration to Not assigned.
- Card movement controls must be conditional on grouping mode.

## Superseded Behavior

Do not restore without a new decision:

- Separate Quick Add.
- Editable fixed type/category sections.
- Standalone maybeboard.
- Persistent right-side card inspector.
- Independent Filter this deck control.
