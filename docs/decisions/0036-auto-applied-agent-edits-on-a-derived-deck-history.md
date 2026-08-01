# ADR 0036: Agent Edits Auto-Apply, Undone From A Diff History Derived In The Reducer

- Status: Accepted
- Date: 2026-08-01

Supersedes [ADR 0006](0006-agent-uses-typed-deck-patches.md), which proposed the same
capability as a confirmed patch flow. Extends
[ADR 0029](0029-read-only-deck-agent-tools.md), whose closing alternative was
*"mutation tools now — deliberately deferred: needs a patch schema, a confirmation flow
and undo, which is the next ADR rather than this one."* This is that ADR, and it keeps
the schema, drops the confirmation, and rebuilds undo from underneath.

## Context

The deck agent could read the open deck, look up cards it could name
([ADR 0029](0029-read-only-deck-agent-tools.md)) and search the whole catalog under
filters it wrote itself ([ADR 0035](0035-the-deck-agent-searches-the-catalog-itself.md)).
It could not change anything. "Swap this ramp package for two rocks" was a paragraph of
instructions the user then carried out by hand on a board sitting two feet away from the
answer.

Three facts about this codebase settled most of the design before any design work:

**The backend holds no deck.** Decks live in browser `localStorage` under
`manabase.deck-library.v2` ([ADR 0004](0004-browser-local-deck-library.md)) and reach the
agent as a per-turn snapshot carrying identity and placement only
([ADR 0029](0029-read-only-deck-agent-tools.md)). So a mutation tool cannot mutate. It can
only compute a change and hand it somewhere that can.

**`useDeck.addCard` takes a full `CardSearchResult`, not an id.**
`validateCommandZoneAddition` and `getColorIdentityWarnings` read the card's colours and
its type line, and the browser has no such object for a card it has never seen. So an edit
that adds a card has to carry the resolved payload with it, and only the backend has one.

**What the editor called undo was not history.** `historyByDeck: Record<string, Deck[]>`
held full `Deck` snapshots, in memory only — `createInitialState` set it to `{}` — capped
at thirty. It recorded no actor, no time and no reason, and a reload stranded every step of
it. That is an undo buffer, and it is the weakest possible foundation for the one decision
below that most needed a strong one.

## Decision

### The mechanism: derive the diff in the reducer, from the pair it already has

This is the load-bearing part, and everything else in this ADR is cheap because of it.

Every mutation in `useDeck` already goes through **one** reducer action taking a
`(current: Deck) => { deck, announcement } | { error }` closure. The reducer therefore holds
the deck **before** and the deck **after** every mutation, and it used to throw that pair
away after pushing the "before" onto the snapshot stack. It now derives the diff from the
pair instead, in one place, and appends it to the deck's history log.

Three properties follow, and none of them had to be built:

- **No mutator changed.** `addCard`, `setQuantity`, `removeCard`, `moveCard`,
  `addCustomGroup` and `renameDeck` are untouched, and a mutator added next year is
  recorded with no extra wiring.
- **The record is complete by construction**, because it is derived from what actually
  changed rather than from what a call site remembered to declare. There is no per-mutation
  diff to write and none to forget.
- **Invertibility is free.** Each change stores `before` and `after`; inverting is swapping
  them. "Every mutation must be invertible" was the honest warning on the option card when
  history was chosen as the undo source, and the central derivation makes it true of every
  mutation at once.

The condition it depends on is that the diff must model everything a `Deck` can differ by —
`cards[]` quantity, section and categories, `custom_groups[]`, and the deck's own name. If
it models all of them, backward replay is indistinguishable from restoring a snapshot; if it
misses one, undo silently stops undoing that thing. So the safety property is tested
directly and in both directions, over a twelve-case table of before/after pairs and over the
real mutators rather than over a schema: derive, invert, apply, and assert the deck equals
the original. `updated_at` is excluded deliberately and the expectations say so out loud
rather than relying on fixtures that happen to agree.

`frontend/src/domain/history.ts` holds the whole derivation as pure functions with no React
and no storage — `deriveDeckDiff`, `invertDeckDiff`, `applyDeckDiff`, `appendToHistory`,
`pruneHistory`, `parseDeckHistory` — so the property test exercises the same code the hook
runs. History persists under `manabase.deck-history.v1`, beside the deck library rather than
inside it.

### Auto-apply, with undo as the net, and history is what makes that safe

An agent edit **applies itself.** The whole diff lands as one reducer action, one history
entry and one undo step, and the transcript reports it in the past tense with an Undo
beside it. There is no proposed diff and no confirm button.

The reason is not convenience. A proposed edit makes the agent's next turn blind: it has to
ask, wait, and then guess whether the user accepted. An applied edit shows up in the next
turn's deck snapshot, so the agent can verify its own work against the deck instead of
asking about it.

The reason this is *safe* is the decision above. Auto-apply's one real weakness is a
mistake the user does not notice until later — and the undo that existed was in-memory,
so a reload stranded it exactly when it was most valuable. Undo now replays the last
recorded entry backwards and survives the reload. The two decisions are one decision;
auto-apply without a durable log would be a worse product than the confirmation flow it
replaces.

Undo **pops** the entry rather than recording its inverse. Recording it would make undo
itself undoable, and would leave the log describing an edit the deck no longer contains —
and the agent reads this log to decide what to do next, so a log that disagrees with the
deck is the same class of error as a half-applied edit.

`canUndo` is established by planning the undo through the real applier rather than by
counting entries, because an entry can be readable and not replayable (see the payload pool
below). Both causes arrive as the same typed refusal, which is announced rather than thrown.

### A target count, not an operation

The tempting schema is `action: "add" | "remove" | "set_quantity" | "move"` with
conditionally-required fields, which is precisely the shape a model malforms. The shipped
`DeckEditChange` collapses it to three fields, and `quantity` is **the count you want
afterwards**:

```python
card: CardToken                                 # a name or a short id, resolved like see_cards
quantity: Annotated[int, Field(ge=0, le=99)]    # the count wanted AFTER; 0 removes
group: ShortLabel | None = None                 # omit to leave placement alone
```

Add is `quantity: 1`. Cut is `quantity: 0`. A move is the same quantity with a new group. A
swap is two changes. There is no discriminator and no conditional field.

The property that matters most is that this is **idempotent**: a change the deck already
satisfies is dropped before the edit is emitted, so sending the same call twice is a no-op
the second time. An auto-applying tool the model may retry must not double-add, and that
follows from the schema rather than from a guard.

`quantity` is required, so absent is impossible, and the browser's applier rejects a
quantity that is not a finite integer rather than coercing it — coercing `undefined` to `0`
deletes a card. `reason` is per call rather than per card, because one intent usually covers
a whole swap, and it is the field that makes history worth reading a week later.

### The backend holds no deck, so `edit_deck` emits a resolved change

`edit_deck` resolves each change against the snapshot the browser posted and emits a
`deck_edit` stream event — the fifth event type, beside `text`, `tool`, `done` and `error`
([ADR 0031](0031-streamed-deck-agent-turns.md)) — which the browser applies. That is not a
workaround: it is the shape `card_links` already uses, where the backend resolves what the
frontend then acts on.

Because the snapshot is in the request, the tool result is **accurate rather than
proposed.** It reports the deck as it was, which changes were therefore no-ops, the
resulting card count and any warning the edit introduced — and none of the caller's own
arguments, which are still sitting in its own tool call. The one real divergence is the user
dragging a card between the request and the apply; it is bounded and self-correcting,
because next turn's snapshot is the truth.

The event carries a full `CardSearchResult` for every card being **added**, because the
browser cannot construct one and the deck's own validators read fields only the payload has.
A change that cuts or moves carries no payload, since the deck already holds the card; that
payload comes from the deck during translation, and a card the deck cannot produce one for
refuses the whole edit rather than dropping that change.

The event is read whole or not at all. One unreadable change refuses the entire edit,
because an edit applied minus one of its changes is the half-applied edit the whole design
refuses — history would then record an intent that did not happen. A `null` from the reader
is dropped exactly as an unknown event `type` is, so the forward-compatibility contract
survives a malformed edit as well as a future event.

The event's contract and validator live in `domain/agent.ts`; the three-line dispatch lives
in `lib/api.ts` beside the rest of the stream reader, because AGENTS.md puts API validation
and transport there. `DeckAgentPanel` gains an `onDeckEdit` prop threaded from `App.tsx`
exactly as `onOpenCard` is, and never touches deck state itself.

### The browser is the only authority on what gets applied

The backend blocks exactly two things: a card it cannot resolve, and a quantity outside
`0..99`. Either fails the whole call. Everything else it can see is a **warning** reported
in the result — colour identity, the singleton rule, and passing a hundred cards — because
the board already treats those as warnings, and an agent held to a stricter rule than the
drag target is inconsistent in a way the user cannot see.

Command-zone legality and group existence stay in `domain/deck.ts`, unduplicated. So the
reducer can refuse an edit the backend was happy to emit — an illegal second commander, a
third commander, a group the deck does not have, more than 99 copies — and that is normal
operation rather than an error path.

The divergence this deliberately avoids is a version that shows a warning and then withholds
the warned change from the emitted edit. That is the one outcome the decision exists to
prevent, because the board would then keep a card the agent believed it had added.

### Position is a restoration hint, not an edit axis

`DeckCardPlacement` carries an `index`, and `DeckGroupPlacement` exists, because without a
recorded position undoing a removal re-appends the card and the restored deck is
order-different from the original — the round-trip property fails for every
middle-of-list edit.

`index` is nevertheless **excluded from change detection.** Cutting one card from a hundred
shifts fifty-nine positions, and counting those as fifty-nine changes would make every
summary wrong and would break the negative check that one edit derives one change. Position
is a restoration hint, not an edit axis.

### Payloads pooled one per printing, and two honest depths

Undoing a removal has to put a `CardReference` back **including** its
`details: CardSearchResult`, or the restored entry loses its price, its mana value and its
validation inputs. A `CardSearchResult` is 2–4KB of JSON and this log shares the browser
storage budget the deck library is already spending, so one payload per change is not
affordable.

Hence `cards: Record<scryfall_id, CardSearchResult>` — **one payload per printing, not per
change.** Adding and cutting the same card ten times stores it once. Ids no live entry
references are collected on write. Only a card entering or leaving the deck is pooled;
pooling one for every quantity change, section move and category change would spend
kilobytes per edit that no replay ever reads.

That gives two depths, and they are deliberately different numbers of a different kind:

- **Undo depth** is entries whose payloads are still pooled, capped at
  `DECK_HISTORY_PAYLOAD_CAP` (50) — better than the thirty it replaces, and unlike the
  thirty it survives a reload.
- **Read depth** is every retained session, capped at `DECK_HISTORY_SESSION_CAP` (50).
  A pruned entry keeps identity, name, counts, time, actor and reason — everything the
  agent reads — and loses only the payload, which is what undo needed and reading does not.

Replaying an entry whose payload is gone **refuses** with a typed failure rather than
producing a detail-less entry, and the refusal states what is true without asserting a
cause: pruning is one reason a payload is missing, and a card that never had `details` to
pool — a deck written by an older build hydrates that way — is another, and the applier
cannot tell them apart.

Separately, the number of sessions the browser **posts** is its own constant rather than the
storage cap. The two are both 50 and they mean different things: one is storage depth tuned
against the quota, the other is the backend's `MAX_HISTORY_SESSIONS`, where exceeding it is a
422 that fails the whole chat turn. Sharing one symbol meant a quota-motivated change to
storage depth would have silently stopped the agent answering, with the test still green
because it asserted against the same symbol.

### Sessions: three minutes, same actor

An edit joins the previous session **iff** the actor matches and the gap since that
session's `ended_at` is at most 180 seconds. Otherwise it opens a new one. `actor` sits on
the session rather than on the edit, so every edit inside one shares it and "who did this"
has one answer per block.

An agent edit therefore never joins a user's session, and a user's never joins an agent's.
That was the requirement, and it falls out of the actor comparison rather than needing a
special case.

The session gap is measured from the entry's own `at`, not from a `now` passed in, because
two sources for one edit's time is a disagreement waiting to happen.

A fourth tool, `read_history`, reads the posted log newest session first, rendering the
actor as **You** and **Me** — the tool speaks to the model, and the model is the agent. A
client that posted no history and a deck with no recorded edits say so differently, because
they lead somewhere different. It is a separate tool rather than an argument on `read_deck`,
so `read_deck` stays about the deck as it is now; `read_deck`'s footer gains a pointer to it
when history exists, matching the pointer pattern it already uses for `see_cards`.

Deleting a deck archives its history with it and restoring the deck restores the log, the
same discipline `DeletedDeckSnapshot` already applied to the old undo stack. Dropping it
would restore a deck with no past.

### The transcript must not claim an edit the deck refused

The transcript block is stored as a **summary** rather than as the event, because the event
carries a whole `CardSearchResult` per added card, which the deck needs and the conversation
does not. A restored turn therefore still reads without spending the chat's storage budget
on payloads.

The reducer can refuse an edit whole, so `applyEdit` **answers with what became of the
edit** rather than dispatching and returning nothing. Without that, a refused edit left a
durable transcript entry reading `Applied: +2 / −1` with an Undo, while only a transient
toast disagreed — and it is reachable in normal use, precisely because the backend
deliberately does not enforce command-zone legality. The verdict is reached by running the
same pure closure the reducer runs over the same deck, because `dispatch` cannot answer its
caller; the reducer stays the authority on the deck and this is only its report.

Two further branches a returned verdict alone does not reach are reported by the translation
itself, which is the only place that knows the edit got no further: a translation that
cannot produce a card payload refuses the edit outright, and a change that keeps a card's
quantity while naming a group the deck does not have is a no-op that must not render as a
move.

A refusal needs no new field and deliberately has none. A block that names no card and
counts no copy is not something that happened, nothing else can produce that shape, and the
fields the stored transcript already carries are what makes a refusal survive a reload — a
flag the stored-transcript reader had never heard of would quietly come back as an applied
block. `reason` carries the deck's own sentence, so the transcript and the toast cannot word
it differently. A refused block has no Undo, because nothing was recorded.

The Undo affordance sits on the newest edited turn only. `undo` reverses the deck's last
recorded change, so an Undo left on an older block would promise that block's reversal and
deliver a different one.

## Consequences

- The agent edits the deck, and the user sees the board change while the answer is still
  streaming. The confirmation step ADR 0006 required is gone, and the safety it was buying
  is now bought by a durable, invertible log instead.
- **Undo is now a different, better thing, and also a different, worse thing.** It survives
  a reload and it carries an actor, a time and a reason, which the thirty-step in-memory
  stack never did. It is also capped by a payload pool rather than by a step count, so an
  entry can be visible in history and not replayable. That state is announced, not hidden,
  but it is a state the old stack could not be in.
- **History costs browser storage on every mutation**, in the same quota the deck library and
  the chat transcripts spend. The payload pool is the mitigation and the caps are the
  ceiling; nothing yet reports how close a deck is to either.
- **History costs request body on every turn** and model context only when `read_history`
  runs — the same trade the deck snapshot already makes. It is read at the moment the turn is
  *sent* rather than held in state, because the log is written by an effect after the render
  that changed the deck, so a value captured in that render would be missing exactly the edit
  the question is about.
- A stored change the backend would refuse is dropped from the posted history rather than
  sent. `deriveDeckDiff` cannot produce one, but the log is read back out of `localStorage`
  and the parser validates the container rather than every leaf, so a corrupted log could
  hold one — and a rejected request is refused whole, which would cost the agent the whole
  turn rather than some history it could have read.
- **The diff schema is now a third place that has to know every field of `Deck`.** Adding a
  field to `Deck` without adding it to the diff makes undo silently stop undoing that field.
  The round-trip property test is the only thing standing between that mistake and a shipped
  regression, and it is a table the author of the new field has to extend.
- `useDeck`'s public surface grew one operation, `applyEdit(edit, actor)`, which is the only
  mutator that takes an actor. Everything else records `"user"`.
- The board's own warnings and the agent's are the same warnings, from the same code, and
  the agent can leave a deck in a warned state exactly as a drag can. Colour identity in
  particular is a warning on both paths; an agent that refused what the drag target allows
  would be inconsistent invisibly.
- Two of the three deferred items ADR 0029 named are now shipped and the third is
  deliberately not: there is a patch schema and there is undo, and there is no confirmation
  flow.
- **Redo is nearly free and is not built.** The log replays forward as easily as backward;
  it needs its own affordance, and nothing asked for it.
- **The user cannot see history.** The agent reads it; the user still sees only an Undo
  button. The data supports a timeline view whenever that is wanted.
- History is per deck and browser-local, like the chat transcript. It does not survive a
  browser wipe and is not readable across devices, and server-side history needs server-side
  deck persistence first — a product decision nobody has made.
- `edit_deck` can place a card in an existing group but cannot create one. Creating a group
  is `addCustomGroup`'s job and would widen the diff schema.

## Known Gaps

Every one of these was found by an audit during this build and deliberately left. They are
recorded because an undocumented gap is rediscovered as a bug.

The three that came out of auditing the hand-driven store, added after the ADR was first
written:

- **`summarizeDeckEditRecord` names at least one card only because no mutator records a
  rename-only or groups-only edit through `applyEdit`.** `isEmptyDeckDiff` counts
  `custom_groups` and `name`, while `deckEditMutation` only ever touches `cards`. A future
  mutator that recorded one would produce a block with three empty name lists, which
  `isRefusedDeckEdit` reads as a refusal — an applied edit rendering "Not applied". The
  docstring states the assumption; nothing enforces it.
- **The transcript's Undo is not gated on `canUndo` while the toolbar's is.** In the state
  where they disagree — the newest entry recorded but its pooled payload pruned — the toolbar
  button is disabled and the transcript still offers an Undo. Clicking it degrades correctly:
  the deck is untouched and the deck's own "history holds no card details" message is shown.
  Nothing durable becomes wrong; it is an affordance asymmetry.
- **There is no lint configuration in the repository.** Several `useCallback`s declare `[]`
  deps while closing over `dispatch`, which is correct only because `commit` is stable. A
  dependency added to `commit` later would break them silently, and nothing would catch it.

Two further findings from the same audit were **fixed rather than recorded**, and are noted
here only so the reasoning is not lost: the render-time write to the deck ref was redundant
and reintroduced the staleness the store exists to remove, and a `deck_edit` frame arriving
after the user switched decks was prevented only by abort semantics in another module.

- **A pure reorder of `cards` or `custom_groups` derives zero changes.** Position is not an
  edit axis, by the decision above. Unreachable today — no mutator reorders either list, and
  `DeckBoard` sorts a copy for display — but it is the one way two `Deck`s can differ that
  this diff does not model.
- **A change whose group the deck has, but whose relocation the reducer declines for another
  reason, can still be reported as a move.** The translation only knows about a group name
  the deck does not have. Closing it needs the reducer's fold to return the names it
  actually moved.
- **The `toDeckEdit`-null refusal produces no toast**, only the transcript block, because
  the deck is never asked and therefore announces nothing.
- **Two of the three StrictMode assertions are tautologies.** `applyEditChange` is
  idempotent by design, so re-applying proves nothing; only the block count distinguishes
  one hand-over from two.
- **The `search_cards` description's "Defaults to 12" is not compared to its setting**, so
  changing `search_cards_default_max_results` would leave the prompt lying with a green
  suite. `read_history` now pins its own advertised default against
  `read_history_default_sessions`; `search_cards` does not. Pre-existing, from
  [ADR 0035](0035-the-deck-agent-searches-the-catalog-itself.md).
- **An EDHREC 404 is not negatively cached.** Pre-existing, from
  [ADR 0035](0035-the-deck-agent-searches-the-catalog-itself.md).
- **`domain/__init__.py`'s barrel exports some deck-agent contracts and not the new ones.**
  `DeckAgentDeckSnapshot` and `DeckAgentDeckCard` are re-exported; `DeckAgentDeckEdit`,
  `DeckAgentDeckHistory`, `DeckEditChange` and the rest are not. Adding them for symmetry
  was tried and reverted as out of scope.
- **A block of frontend assertions pin the U+2212 MINUS SIGN and the exact
  `Applied: +N / −M` wording**, across `App.test.tsx` and `DeckAgentPanel.test.tsx`, so
  retuning the presentation breaks tests that mean to pin counts and names. `history.test.ts`
  already avoids this by parsing a summary through a helper; the component tests do not.
- **No test moves an existing card between two named groups** through `applyEdit`, and the
  "a named group is honoured at all" direction is killed only incidentally, by a test named
  for history rather than for placement.
- **Nothing pins that `App` posts the current deck's id after a deck switch.** Correct today
  via a `useCallback`'s dependency list, and unpinned.
- **`read_history`'s `_bounded()` call is unreachable** by construction — the rendered
  signature cannot exceed the bound. True in the code, untestable.
- **The `DeckEditChange` schema docstring leaks engineering rationale to the model** — "which
  is the shape a model malforms" is prompt surface saying nothing the model can act on.
- **Partner and background command zones remain unhandled**, as in `see_cards` and
  `search_cards`. `plan.md` calls multi-card command zones a product principle, so all three
  should be fixed together.

## Alternatives Considered

- **A proposed diff the user confirms**, as ADR 0006 specified. Rejected on the product
  decision above: it blinds the agent's next turn, and the safety it buys is bought more
  cheaply by a durable undo. Recorded rather than deleted, because it is the obvious design
  and someone will propose it again.
- **Keeping the snapshot stack and writing history beside it.** Two records of the same
  mutation, which is two records that can disagree — and the agent reads one of them.
- **Per-mutation inverse functions.** Six to write today, one per mutator forever, and each
  a place to forget a field. The central derivation makes inversion a property of the data
  instead.
- **A discriminated `action` union for `DeckEditChange`.** Four verbs with conditionally
  required fields, which the codebase already has evidence models get wrong, and it gives up
  idempotence — the property that makes a retried auto-applying call safe.
- **Recording undo's inverse instead of popping the entry.** Makes undo undoable, which is
  redo by accident, and leaves the log describing an edit the deck no longer contains.
- **Enforcing read-before-edit in code.** `deck_agent.py` already knows which tools have run
  this turn. Rejected: a change states the count it wants, so an edit made without reading is
  redundant rather than wrong, and idempotence is already enforced and tested. Spending one
  of four tool iterations on every editing turn to prevent a redundancy the contract absorbs
  is the wrong trade. The rule stays a bare imperative in the prompt, with no justification
  attached, because a reason the model can satisfy while still breaking the rule reads as
  permission.
- **Enforcing command-zone legality in the backend too.** It would let the tool result be
  wrong less often, at the cost of a second copy of a policy that already lives in
  `domain/deck.ts` — and the copies would drift. The browser refusing an emitted edit is
  handled instead, and the transcript reports the refusal.
- **Storing the `deck_edit` event in the transcript** rather than a summary of it. Simplest,
  and it spends the chat's whole character budget on card payloads the conversation never
  reads.
- **A payload per change instead of per printing.** Kilobytes per edit for a pool that would
  hold the same printing many times over.
- **Server-side history.** Survives a browser wipe and reads across devices, and it needs
  backend deck persistence first.
