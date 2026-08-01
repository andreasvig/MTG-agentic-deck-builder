# ADR 0037: One Placement Axis, And A Commander The Agent Can Set

- Status: Accepted
- Date: 2026-08-01

Supersedes the grouping half of
[ADR 0005](0005-editor-grouping-and-inspection.md) — custom groups, the two grouping
modes, and drag-to-create. Its other decisions (one Add cards button, no maybeboard,
modal card details, the right side reserved for the agent) stand.

Narrows the placement field of
[ADR 0036](0036-auto-applied-agent-edits-on-a-derived-deck-history.md)'s `edit_deck` from
a custom-group name to a zone.

## Context

The editor had two ways to group a deck: `Custom`, holding a permanent Command zone, a
permanent Not assigned group, and any number of user-created groups; and `Card types`,
derived from each card's type line and read-only. `Card types` was the default and the
one actually used. Custom groups cost:

- a `custom_groups[]` array on `Deck`, and a `categories[]` array on every card entry
  whose only content was one group id
- a whole change axis in the derived history: `DeckGroupChange`, `DeckGroupPlacement`,
  group insertion/rename/removal in `applyDeckDiff`, and five rows in the round-trip
  property table
- a group *name* travelling to the agent on every posted card and every recorded
  placement, plus the resolution of that name back to an id on the way in
- `addCustomGroup`, `AddGroupSlot`, a drop target for creating a group, and a grouping
  select in the toolbar

**Two defects came out of the same design.** Both were reported by the user in one
message.

**Drag was gated on the mode nobody used.** `DeckBoard` computed
`const dragEnabled = group === "custom"`, and the card inspector's placement select was
gated on the same thing. In `Card types` — the default — there was therefore *no way for
the user to put a card in the command zone at all*. Not by drag, not from the inspector.
The affordance existed only in the mode the toolbar had to be switched into.

**The agent could not set a commander.** The mechanism was complete:
`applyEditChange` handled `command_zone` with the full legality checks, and the browser
resolved the literal string `"Command zone"` back to the section. The *contract text* was
what stopped it. `agent.tools.edit_deck_description` described the field as

> `group` — the custom group the card should sit in afterwards. […] The group has to be
> one that already exists.

A deck with an empty command zone has no such group on screen, so a model reading that
sentence correctly concludes it cannot put anything there. The one worked example showed
a card being filed under `"Ramp"`. This is the second time in two ADRs that a capability
was built correctly and left unreachable by its own description — the first was
`search_cards`' `edhrec_theme`.

## Decision

**Placement is a `DeckSection` and nothing else.** `custom_groups` and the per-card
`categories` array are deleted from the model, along with `groupIdForEntry`,
`placementForGroup` and the `unassigned` group id. A "group id" and a section were the
same two values once the custom ones went, so everything that passed a group id around
now passes a section: `addCard`, `moveCard`, `DeckEditChange`, the board's drop targets,
the search drawer's add target.

**The board groups by derived card type, under a permanent Command zone heading.** There
is no grouping control. `sectionLabel` names the two sections — `Command zone` and
`Deck` — in the one place, so the heading, the inspector control, and any label the agent
reads cannot disagree.

**Drag stays, with the command zone as its only meaning.** Every group is a drop target
carrying a section: the Command zone heading carries `command_zone` and every card-type
heading carries `mainboard`. Dropping a card on `Creature` cannot mean "make this a
creature", so it means the only thing it can mean — put it in the deck. Drag is now
unconditional, which is what makes the command zone reachable in the only view there is.

**The card inspector's placement control is unconditional too**, and is the keyboard path
to the same move.

**`edit_deck` names a zone, not a group.** `zone: "commander" | "deck"`, an enum in the
schema the model reads, with `_section_for_zone` as the single place the model's
vocabulary meets the browser's. The description says what it does, and two of the worked
examples set a commander — including the swap, in one call, because the outgoing
commander has to leave before the incoming one is legal.

**Absent stays absent.** A change that says nothing about placement travels with
`section: None` and is applied as "leave placement alone". It is never resolved to
`mainboard`: the same field carries an ordinary quantity change on a card that happens to
be the commander, and defaulting it would take the user's commander out of the zone on an
edit that never mentioned placement. A section present but outside the two fails the
whole edit at the stream reader, for the same reason — reading an unrecognised section as
"not the command zone" is the one wrong answer that loses data.

## Migration

The storage keys are deliberately **not** bumped, on either side.

- A stored **deck** carrying `custom_groups` and per-card `categories` loads with both
  dropped and every card kept. What is lost is where a card was filed, never whether the
  deck holds it. `isDeckEntry` no longer requires `categories`, because a deck this build
  writes has none and requiring one would reject every deck saved from here on.
- A stored **history** keeps `categories` inside its placements and a `groups` array on
  its diffs. Both are ignored rather than rejected, so an old log stays readable and its
  card changes stay replayable — bumping the key would have cost the user their undo
  depth to no benefit.

## Consequences

- The command zone is reachable by drag, by the inspector, by the Command zone heading's
  add button, and by the agent. Before this it was reachable by exactly one of those, and
  only after switching modes.
- The history derivation lost an entire axis. `DeckDiff` is now `{ summary, cards, name? }`
  and `deriveDeckDiff` walks one list instead of two.
- The posted placement is `{ quantity, section }`. The group name that used to travel with
  it is gone, and `index` still does not travel: it is a restoration hint, and a position
  in `Deck.cards` means nothing to a reader who sees the deck grouped by type.
- A user who had named groups loses those names. This is the intended trade — they had no
  display and no control left once the grouping mode went, so keeping them in storage
  would have been keeping a field nothing could ever show.
- The price cast that
  [ADR 0036](0036-auto-applied-agent-edits-on-a-derived-deck-history.md) removed from the
  statistics memo turned out to exist twice more, in the board's own group header and its
  price sort. `getKnownCardPrice` now takes the absence, and there is no `as
  CardSearchResult` anywhere: this was the same defect on two more branches, so it is
  fixed once rather than three times.

## Known gaps

- Command-zone eligibility is not checked at all for the *first* commander.
  `validateCommandZoneAddition` returns `allowed` when the zone is empty, so any card —
  an artifact, a land — can be made the commander by drag, by the inspector, or by the
  agent. Pre-existing, and now easier to reach.
- Partner and background command zones remain unhandled in `edit_deck`, as in `see_cards`
  and `search_cards`.
- `existing?.section` is the fallback when a change names no zone, and its only
  observable case is a deck already holding two copies in the command zone — an illegal
  state `getCommandZoneProblem` reports and storage permits. That is the case the test
  covers.
