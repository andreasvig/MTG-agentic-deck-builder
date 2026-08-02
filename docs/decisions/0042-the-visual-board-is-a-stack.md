# ADR 0042: The Visual Board Is A Stack, And A Card Can Be Carried Into The Chat

- Status: Accepted
- Date: 2026-08-02

Extends [ADR 0037](0037-deck-grouping-is-derived-from-card-type.md), which made every
group a drop target carrying a `DeckSection`.

## Context

The visual board spent a full card's height on every card. A commander deck's land
column is thirty-odd cards, so the one group a builder scans most was the one that could
never be seen at once — reading it meant scrolling past thirty pictures to count lands.
The pictures were not the point at rest; the names were.

## Decision

**The visual view stacks. It is not a third mode.** Each card is overlapped by the one
below it so that all that shows is the top of it, and the card under the pointer opens by
pushing the rest of the column down. A third view would have left the spaced-out grid to
be kept and tested for the sake of a layout the stack is strictly better at.

**What a closed card shows is the card.** Every Magic card prints its name and mana cost
across a band at its top, in the same place on all of them, so the column reveals exactly
that band and lets the artwork below it be covered. The first build of this drew a strip
instead — the same name and cost, in the application's own type, over a card cropped by
exactly enough to hide its printed one. It worked and it was wrong: it spent the one part
of a stacked card that is always on screen redrawing what the card already said.

That is the rule the rest of this follows. **Nothing the application draws sits on that
band.** The copy count is a badge outside the top-left corner and any validation warning
outside the top-right, both small, both clear of where a printed name can begin. The
quantity controls and the price are a row *beneath* the card, not an overlay on it: over
the art they covered the bottom of the single card in the column anyone was looking at.

**Which card is open is not state.** The pull-up is a margin and the opening is
`:hover +` / `:focus-within +`. Held in React instead, every mouse movement across a
column would re-render the column, and the open card would have to be owned by the group
rather than by the card.

The mechanism rests on one CSS rule that reads like a mistake: **a percentage margin
resolves against the containing block's width, vertical margins included.** A card is a
fixed ratio of the column width, so its height has no pixel value at any column width —
but it does have a percentage one, and pulling a card up by all of that except the title
band leaves the card above showing exactly its title band. `--stack-card` and
`--stack-peek` are those two percentages.

The band is also why the stack needs no mobile sizing of its own. A strip is a number of
pixels and has to be told to grow on a phone; a share of the column width grows because
the column did.

**The art box carries the aspect ratio, not the image.** Sized by its image, a printing
with no art — an older saved deck, a card the catalog has no picture for — collapses to
the height of the "image unavailable" placeholder while the pull-up still subtracts a
whole card. Every later card in that column is then hauled up out of it. This was
measured, not reasoned about: a probe fixture without images put the last card's controls
in the toolbar.

**A closed card's controls are collapsed, not switched off.** The row beneath the card is
zero-height with its content clipped by its own `overflow`, which keeps a closed card
costing exactly a card's height and so keeps the pull-up a pure function of the card.
`pointer-events: none` would do the same job in a browser and none of it under test —
jsdom computes the property but implements no `:hover`, so the buttons would be
permanently unpressable there and every test that presses one would be asserting against
a UI that does not exist. Clipping also keeps the controls in the accessibility tree and
reachable by tab, which is why focus has to open a card too: otherwise tabbing through a
column lands on buttons nobody can see.

**A card is dragged by its own art, and one drag serves both targets.** Dropped on a
group it moves there; dropped anywhere on the agent panel it puts the card's name in the
composer. It is one gesture because it can only be one: the browser turns a `draggable`
element into a native drag as soon as the pointer moves and stops sending the pointer
events a second drag library would have to activate on, so a card cannot carry both a
native drag and a dnd-kit one. The first build gave the art to the chat and left a handle
for dnd-kit, which is what put a control back on the printed band.

The two sides therefore meet at the `DataTransfer` and nowhere else. It carries the name
under one type, the id and section under another, and `text/plain` as well so a card
dropped somewhere that has never heard of this application still yields its name. The
target under the cursor decides which of the two the drag turned out to be. `types` is
readable during `dragover` while `getData` is not, which is exactly enough for a group to
light up before it knows which card is coming.

Against the list, which keeps dnd-kit and its handles: two drag mechanisms in one
application is a real cost, paid because the list has no printed band to protect and
because dnd-kit is what makes card movement keyboard-reachable at all.

**The hover preview in the chat prices the card.** The agent is instructed never to repeat
a price out of a web summary, which makes the one number a reader most often wants the one
number it may not say — and it is already on the card the hover fetched. Labelled as the
catalog labels it everywhere else, an estimate, and showing an em dash rather than €0.00
for a printing that has no EUR price.

## Consequences

**The last card in every column always shows in full**, because nothing overlaps it. That
is the shape of the mechanism rather than a special case, and it happens to be useful: a
column is never a wall of text with no picture in it.

**Moving a card between groups in the visual view is now pointer-only.** A native drag has
no keyboard equivalent, and the handle that dnd-kit listened on is gone. The keyboard path
is the list view's handles and the card inspector's placement control, which was already
the documented way to reach the command zone without a pointer — but it is a narrowing,
and it is the price of the card's top belonging to the card.

**Nothing about this is visible to the test suite.** jsdom computes no layout, so the
overlap, the collapse and the scoot are exactly the things 246 unit tests cannot see. The
geometry is asserted in the browser instead, in `e2e/deck-builder.spec.ts`, against
consecutive card positions and `document.elementFromPoint` — including the count badge's
box against the card's, because "small, in the corner, clear of the printed name" is a
geometric claim and nothing else in the suite can hold it.

Both halves were mutation-controlled — seventeen mutations against the final design, no
survivors, after three earlier survivors worth recording. Two deleted the clip and left
the browser test green, because the card asserted on was a *covered* one: a card with
another card lying on top of it is protected by that card whatever the CSS does, so only
the last card in a column discriminates. The third was subtler and cost a test: a
same-group drop being inert survived removing the component's guard, because `useDeck`
declines that move too and already has its own test for it. The component keeps the guard
as a statement of intent, but the assertion was replaced with one this component actually
owns — that a drop it does not recognise is left *unprevented*, so the browser still does
whatever it would have done with it.

**A card image is assumed to be 488 × 680.** Both the peek and the pull-up are that ratio
written out, so a catalog that started serving a different one would need both changed
together.
