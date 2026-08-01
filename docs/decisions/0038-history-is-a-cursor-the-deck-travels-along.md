# ADR 0038: History Is A Cursor The Deck Travels Along

- Status: Accepted
- Date: 2026-08-01

Extends [ADR 0036](0036-auto-applied-agent-edits-on-a-derived-deck-history.md), which
replaced the in-memory undo stack with a derived diff history and made undo *pop* it.

## Context

ADR 0036 gave the deck a durable log of derived diffs and rebuilt undo on top of it. Undo
worked by dropping the newest entry:

```ts
function withoutLastEdit(log: DeckHistory): DeckHistory
```

That is enough for undo and structurally cannot support anything else. The moment an edit
is reversed, the record of it is gone — so there is nothing to replay forward, and nothing
to show the user about what they just reversed. A redo button had no data to work from, and
neither did a history view.

The user asked for three things: a Forward button beside Back, a History button between
them, and the ability to move between the diffs in that history.

## Decision

**The log is the whole past, and where the deck stands in it is a cursor.**
`DeckHistory.at` holds the id of the newest edit the deck currently has applied, `null`
meaning the deck stands before every recorded edit. Undo no longer removes anything: it
moves the cursor back and replays one diff inverted. Everything after the cursor is an edit
that happened, was stepped back past, and can be stepped into again.

**One function plans every movement.** `planHistoryTravel(deck, history, destination)`
takes `"back"`, `"forward"` or `{ editId }`, walks the flattened line of edits, and returns
the deck to land on plus the cursor to record. A six-edit jump from the panel and six
single steps are the same code on the same path, so they cannot come to disagree — there is
no second implementation of "replay backwards" for the panel to drift away from.

**It plans rather than acts**, which is what `canGoBack` and `canGoForward` are computed
from. An entry whose pooled payload has been pruned is readable but not replayable, so
counting entries would light a button up for a step the reducer then refuses. This is the
same discipline `canUndo` already followed.

**A jump is refused whole.** If any edit on the path cannot be replayed, the deck does not
move and the refusal is announced. Landing halfway would put the deck in a state no
recorded edit describes, and the cursor would then name an edit that is not the one
applied.

**A new edit discards the undone tail.** `appendToHistory` truncates everything after the
cursor before appending. Those entries described a future the deck has been changed out of;
once it has, they can be replayed onto no deck that exists. Truncating is also what keeps
this function's own invariant — the cursor is the newest edit in the log — true by
construction, which every other reader relies on.

**The position is stored, so travel survives a reload.** ADR 0036's undo already survived a
reload where the thirty-step in-memory stack it replaced could not; a forward step now
survives one too.

**`read_history` marks the undone tail rather than hiding it.** A posted edit carries
`undone: true` when the deck does not have it, the tool prints `(undone)` on that line, and
it explains the marker once at the top — only when something is actually marked. "Put that
back" is exactly the question an undone edit answers, and a history that dropped them would
leave the agent unable to see what the user had just reversed. The count is of what was
*shown*, not of the whole log, because promising a marker the reader cannot find is worse
than not mentioning it.

## Consequences

- Payload retention now serves both directions. `pruneHistory` keeps payloads for the
  newest N edits, and the undone tail *is* the newest — so redo reads the pool it needs
  without a second cap. What used to be garbage-collected on undo is now collected when a
  new edit replaces the tail.
- `undo` is gone from `useDeck`'s surface, replaced by `back`, `forward` and `jumpToEdit`.
  `canUndo` is `canGoBack`. The transcript's own Undo affordance is unchanged: it still
  compares its block's `editId` against the edit the deck stands on, which is now the
  cursor rather than the log's tail — the same identity comparison, against a value that
  means the same thing.
- `historyEntries` carries the session's actor down onto every entry, because the panel
  renders it. The alternative was inferring the actor from the entry, and a reason is
  present on every agent edit *so far* — which makes it a proxy that works until a user
  edit is given one.
- `describeDeckCardChange` is now the one place a card change is put into words, read both
  by the summary stored on an entry and by the panel that renders it.
- Absent is not `null` in the stored field. A log written before the cursor existed has
  every recorded edit applied, so `parseDeckHistory` reads absent as the newest edit; a
  stored `null` survives the round trip, because reading it as the tip would silently
  reapply everything the user had stepped out of.

## Known gaps

- There is no branching. Stepping back and editing discards the tail, as every undo stack
  does. A user who wanted both futures has to keep two decks.
- The history panel offers every row, including rows a jump would refuse. Offering only the
  reachable ones would mean planning every jump on every render; the refusal is announced
  instead.
- `read_deck`'s "N earlier edits are recorded" counts the undone tail too. That is true —
  they are recorded — but a reader could take the number as the deck's depth of applied
  history.
