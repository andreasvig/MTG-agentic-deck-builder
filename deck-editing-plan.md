# Deck stats, `edit_deck`, and a durable deck history

> Project: mtg-agentic-deck-builder

Three asks, one shared mechanism:

- `read_deck` reports a mana curve and a total price without being asked.
- `edit_deck` takes a deck diff and changes the deck.
- Every edit is recorded in a durable, sessioned history the agent can read, each
  session tagged as the user's or the agent's.

They arrive together because parts (b) and (c) are the same derivation seen from two
directions, and part (a) is the first consumer of numbers the history will later need.

## The controlling constraint

**The backend holds no deck.** It lives in browser `localStorage` under
`manabase.deck-library.v2` and reaches the agent as a per-turn
`DeckAgentDeckSnapshot` carrying identity and placement only. Everything else — name,
type line, mana value, price — is resolved from the local catalog on arrival, so the
agent cannot be told the deck contains a card the catalog disagrees about
([ADR 0029](docs/decisions/0029-read-only-deck-agent-tools.md)).

So `edit_deck` **cannot mutate anything.** It computes a change against the deck as
posted and emits it; the browser applies it. That is not a workaround — it is the same
shape `card_links` already uses, where the backend resolves what the frontend then
acts on.

The second constraint is subtler. `useDeck`'s `addCard` takes a **full
`CardSearchResult`**, not an id, because `validateCommandZoneAddition` and
`getColorIdentityWarnings` need the card's colours and type line. The browser does not
have that object for a card it has never seen. So an edit that adds a card must carry
the resolved card payload with it — which only the backend has.

## Decisions taken

| | Decision | Why |
| --- | --- | --- |
| Apply model | **Auto-apply.** The diff lands as one undo step with a toast naming what changed. | Andreas, 2026-08-01. The agent can then verify its own work on the next turn's snapshot instead of asking. |
| Undo source | **History replaces the undo stack.** Undo replays the diff log backwards. | Andreas, 2026-08-01. It also repairs auto-apply's one real weakness: today's undo is in-memory and a reload strands it. |
| Session window | **3 minutes.** | Andreas, 2026-08-01. A whole editing stretch reads as one session. |

Decided without asking, because the code or an existing rule already settles it:

- **History records user edits and agent edits alike.** "A value for if it was made by
  an agent or a user" is only meaningful if both appear.
- **History lives in `localStorage`, beside the deck.** Server-side history means
  inventing server-side deck persistence, which is a product decision nobody has made.
- **An agent edit may touch the command zone**, but the result names the cards that
  just fell out of colour identity. The board already treats out-of-identity as a
  warning rather than a block, and an agent held to a stricter rule than the drag
  target would be inconsistent in a way the user cannot see.
- **The browser is the only authority on what gets applied.** The backend blocks
  nothing but an unresolvable card and an out-of-range quantity; command-zone legality
  and group existence stay in `domain/deck.ts`, unduplicated.

## Part A — `read_deck` reports the curve and the price

`_read_deck` already resolves every entry to a full `CardSearchResult`, so
`mana_value` and `prices.eur` are in hand. This is rendering, not a new data path.

Appended before the existing `see_cards` pointer:

```
Curve — non-land cards outside the command zone
  0  ██ 2      4  ████████ 8
  1  ████ 4    5  ████ 4
  2  ██████████ 10   6  ██ 2
  3  ████████ 8   7+ ██ 2
Average mana value 2.84 across 40 cards.

Price EUR 412.50 for all 99 cards. 3 of them have no price estimate, so the
real total is higher.
```

### It must agree with the number already on screen

`useDeck.ts:384` **already computes both figures.** Only one of them is rendered:
`statistics.price` reaches the deck header at `App.tsx:476`, while `averageMana`
(`useDeck.ts:419`) is computed and consumed nowhere — verified 2026-08-01, one grep
across `frontend/src` and `e2e` returns only its definition. So "must agree with the
number on screen" is literally true of the price and, for the curve, is agreement with a
convention against the day the interface starts showing it.

The tool adopts both conventions exactly, because two different correct answers on one
screen is worse than one slightly-wrong answer:

- **Price** sums `prices.eur × quantity` over **every** card, command zone included.
- **Average mana value** is quantity-weighted over cards that are **not** in the
  command zone and whose `type_line` does not contain `"Land"`.

That land test is a substring match, so it also excludes Dryad Arbor and every
Legendary Land. Matching the quirk is deliberate; diverging silently is the failure
mode. Recorded here so the next person does not "fix" one side of it.

### Two defects not to inherit

- `getCardPrice` returns **0** for a card with no EUR price, so the on-screen total
  silently under-reports. The tool reports the unpriced count in words. A card with no
  price is not free.
- The frontend prices the **card details cached at add time**; the backend prices the
  **catalog as it is now**. The two totals can legitimately differ after a catalog
  refresh. The tool says "EUR 412.50" and never "which matches the sidebar".

No new argument. Andreas asked for it "automatically", so it is always present, at a
cost of about twelve lines per call.

## Part B — `edit_deck`

### One declarative statement per card, not four verbs

The tempting schema has `action: "add" | "remove" | "set_quantity" | "move"` with
conditionally-required fields, which is exactly the shape a model malforms. Collapse it
instead: **state the copy count you want afterwards.**

```python
class DeckEditChange(DeckAgentModel):
    card: CardToken                       # a name or a short id, resolved like see_cards
    quantity: Annotated[int, Field(ge=0, le=99)]   # the count you want AFTER; 0 removes
    group: ShortLabel | None = None       # where it should sit; omit to leave placement alone

class EditDeckArguments(DeckAgentModel):
    changes: Annotated[list[DeckEditChange], Field(min_length=1, max_length=100)]
    reason: ShortLabel                    # one line, recorded in history
```

Add is `quantity: 1`. Cut is `quantity: 0`. Move is the same quantity with a new
group. Swap is two changes. There is no discriminator, no conditional field, and the
call is idempotent — sending it twice is a no-op the second time, which matters because
an auto-applying tool that the model retries must not double-add.

`quantity` is **required**, so absent is impossible. The frontend applier rejects an
operation whose quantity is not a finite integer rather than coercing it, because
coercing `undefined` to 0 deletes a card.

`reason` is per call, not per card: one intent usually covers a swap. It is the field
that makes history worth reading later.

### The tool result can be accurate, not "proposed"

The snapshot is in the request, so the backend can compute what the change does to the
deck as posted and say so plainly — no hedging, no waiting a turn:

```
## Edit
Applied to "Gruul Stompy": 2 added, 2 removed, 96 cards now.
  + Sol Ring (1)
  + Arcane Signet (1)
  − Wayfarer's Bauble (was 1)
  − Rampant Growth (was 1)
Arcane Signet was already in the deck at 1 copy, so that change did nothing.
```

Per the tool-result rule, the caller's own arguments are not echoed. What it could not
know: which names resolved, what the deck held **before**, which changes were therefore
no-ops, the new card count, and any warning the change introduced (out of colour
identity, a second nonbasic copy, over 100 cards).

The one real divergence is the user dragging a card between the request and the apply.
It is bounded and self-correcting — next turn's snapshot is the truth — and the prompt
says the deck is as it was when the turn started.

### Transport and application

A fifth stream event:

```python
class DeckAgentDeckEditEvent(DeckAgentModel):
    type: Literal["deck_edit"] = "deck_edit"
    edit: DeckAgentDeckEdit      # resolved changes + the reason + the cards' payloads
```

It carries a `CardSearchResult` for every card being added, because the browser cannot
construct one. Sent the moment the tool finishes, like `DeckAgentToolEvent`.

Wiring mirrors `onOpenCard` exactly: `DeckAgentPanel` gains an `onDeckEdit` prop,
`App.tsx` builds the handler from `useDeck`, and the panel never touches deck state
itself.

`useDeck` gains **one** reducer action, `apply_edit`, so the whole diff is a single undo
step — which is also what "one edit" means in the history model. It runs the same
validators the drag path runs; anything refused is reported through the existing
announcement channel and, critically, **the whole edit is refused rather than half
applied.** A half-applied agent edit is the worst outcome available, because history
then records an intent that did not happen.

## Part C — history, and undo rebuilt on it

### What exists today is not history

`historyByDeck: Record<string, Deck[]>` holds **full `Deck` snapshots**, in memory
only — `createInitialState` sets it to `{}` — capped at `MAX_UNDO_STEPS = 30`. It dies
on reload and it records no actor, no time and no reason. It is an undo buffer.

### The central derivation, which is the whole trick

Every mutation in `useDeck` goes through one reducer action taking a
`(current: Deck) => { deck, announcement } | { error }` closure. The reducer gets the
deck before and the deck after, and today it throws the pair away after pushing the
"before" onto the stack.

So: **derive the diff in the reducer, from the before/after pair it already has.**

- No mutator changes. `addCard`, `setQuantity`, `removeCard`, `moveCard`,
  `addCustomGroup` and `renameDeck` are untouched, and a mutator added next year is
  recorded automatically.
- The diff is complete by construction, because it is derived from what actually
  changed rather than from what a call site remembered to declare.
- **Invertibility is free.** Each change stores `before` and `after`; inverting is
  swapping them. There is no per-mutation inverse to write and none to forget.

This is what makes Andreas's second choice cheap. "Every mutation must be invertible"
was the honest warning on the option card; the central derivation makes it true of every
mutation at once, in one place.

The safety property is testable: for every mutator, derive the diff, apply it
backwards, and assert the deck equals the original. That is a property test over the
real mutators, not an assertion about a schema.

The condition it depends on: **the diff schema must model everything a `Deck` can
differ by** — `cards[]` (quantity, section, categories), `custom_groups[]`, and `name`.
If it models all of them, backward replay is indistinguishable from restoring a
snapshot. If it misses one, undo silently stops undoing that thing. The property test
above is what keeps that honest.

### Schema

```ts
// frontend/src/domain/history.ts
export const DECK_HISTORY_STORAGE_KEY = "manabase.deck-history.v1";

export interface DeckCardPlacement {
  quantity: number;
  section: DeckSection;
  categories: string[];
}

export interface DeckCardChange {
  scryfall_id: string;
  name: string;                          // denormalised so history reads without the catalog
  before: DeckCardPlacement | null;      // null — the card was not in the deck
  after: DeckCardPlacement | null;       // null — it was removed
}

export interface DeckEditEntry {
  id: string;
  at: string;                            // ISO
  reason?: string;                       // agent edits carry the model's one-liner
  summary: string;                       // "+2 / −2" plus names, for display
  cards: DeckCardChange[];
  groups?: DeckGroupChange[];
  name?: { before: string; after: string };
}

export interface DeckSession {
  id: string;
  actor: "user" | "agent";
  started_at: string;
  ended_at: string;
  edits: DeckEditEntry[];
}

export interface DeckHistory {
  deck_id: string;
  sessions: DeckSession[];               // oldest first
  cards: Record<string, CardSearchResult>;  // payload pool, see below
}
```

`actor` sits on the **session**, as Andreas specified, and every edit inside a session
therefore shares it.

### Sessions are materialised, with one rule

Append the edit to the last session **iff** the actor matches **and** the gap since
that session's `ended_at` is ≤ 180s. Otherwise open a new one.

An agent edit never joins a user session and vice versa, because the actor differs.
That is exactly what was asked for, and it falls out of the rule rather than needing a
special case.

### The payload pool, and why undo needs it

Undoing a removal has to put back a `CardReference` including its
`details: CardSearchResult`, or the restored entry loses its price, its mana value and
its validation inputs. But a `CardSearchResult` is 2–4KB of JSON and history is
unbounded, so storing one per change would exhaust the quota the deck library is already
spending.

Hence `cards: Record<scryfall_id, CardSearchResult>` — **one payload per printing, not
per change.** Adding and cutting the same card ten times stores it once. Ids no live
entry references are garbage-collected on write.

This gives two honest depths:

- **Undo depth** = entries whose payloads are still pooled. Capped at 50, which is
  strictly better than today's 30, and unlike today it survives a reload.
- **Read depth** = every retained session. Pruned entries keep identity, name, counts,
  time, actor and reason — everything the agent reads — and lose only the payload,
  which is what undo needed and reading does not.

Prune oldest-first at a configured cap. The cap bounds undo depth too, so any value
≥ 30 is not a regression.

### Deleting a deck must archive its history

`delete_deck` already stashes a `DeletedDeckSnapshot` carrying that deck's undo
`history: Deck[]` so `restore_deleted_deck` brings it back. That field becomes the
deck's diff log, and the same discipline applies: archive it with the deck, restore it
with the deck. Dropping it would make restore a deck with no past.

### How the agent reads it

A fourth tool rather than an argument on `read_deck`, so `read_deck` stays about the
deck as it is now:

```python
class ReadHistoryArguments(DeckAgentModel):
    limit: Annotated[int, Field(ge=1, le=50)] = 10   # most recent sessions
```

```
## History
"Gruul Stompy" — 4 sessions recorded, showing the last 3.

You, 14:02–14:06 (4 changes)
  + Sol Ring, + Arcane Signet, − Rampant Growth, + Command Tower

Me, 14:11 (2 changes) — "swapping the weakest ramp for two rocks"
  + Mind Stone, − Wayfarer's Bauble

You, 14:24 (1 change)
  Ghalta, Primal Hunger → command zone
```

"You" and "Me" rather than `user` / `agent`: the tool speaks to the model, and the
model is the agent.

Transport matches the deck snapshot — `DeckAgentChatRequest.history:
DeckAgentDeckHistory | None`, bounded at 50 sessions and 500 edits. It costs request
body on every turn and **model context only when the tool runs**, which is the same
trade the deck snapshot already makes.

`read_deck`'s footer gains one line — "14 earlier edits are recorded; call
`read_history` to see them" — the same pointer pattern it already uses for `see_cards`.

## File map

| Path | Change |
| --- | --- |
| `domain/agent_chat.py` | `EditDeckArguments`, `DeckEditChange`, `ReadHistoryArguments`, `DeckAgentDeckEdit`, `DeckAgentDeckEditEvent`, `DeckAgentDeckHistory` + session/edit models, `history` on `DeckAgentChatRequest`, the event added to the `DeckAgentStreamEvent` union |
| `deck_agent_tools.py` | `EDIT_DECK`, `READ_HISTORY`, `_edit_deck`, `_read_history`, `_curve_lines`, `_price_lines`, two `definitions()` entries, two `run()` branches, two signature builders through the existing `_bounded()` clamp |
| `deck_agent.py` | emit `DeckAgentDeckEditEvent` when `edit_deck` succeeds; thread `history` from request to toolbox |
| `config.py` / `config.yaml` | `edit_deck_description`, `read_history_description`, `read_history_default_sessions`, `history_max_sessions`; the blank-description validator gains two names; `agent.system_prompt` gains an editing section |
| `frontend/src/domain/history.ts` | new — the schema above, plus `deriveDeckDiff`, `invertDeckDiff`, `applyDeckDiff`, `appendToHistory` (the session rule), `pruneHistory` |
| `frontend/src/hooks/useDeck.ts` | `apply_edit` action; the reducer derives and appends a diff on every mutation; `undo` replays backwards; `historyByDeck` deleted; `MAX_UNDO_STEPS` becomes the payload-pool cap; history persisted in the existing `useEffect`; `delete_deck` / `restore_deleted_deck` carry history |
| `frontend/src/domain/agent.ts` | the `deck_edit` event in the stream parser |
| `frontend/src/components/DeckAgentPanel.tsx` | `onDeckEdit` prop; render the applied-edit block with its Undo affordance |
| `frontend/src/App.tsx` | build the handler from `useDeck`, pass `history` into the chat request |
| `docs/decisions/00xx-…md` | one ADR: the backend proposes, the browser applies, and history is the undo source |

## Prompt work

The system prompt gains `# Editing the deck`, and the two rules that matter are the two
this codebase has already been burned by:

- **State the count you want, not the operation.** No reason attached, because a reason
  the model can satisfy while still breaking the rule reads as permission.
- **Read before you write.** An `edit_deck` against a deck it has not read this turn is
  a guess about what is in it.
- The edit **has already happened** when the result comes back. It must not say "shall
  I add it?" after adding it, and must not say "I have added" before calling.

Every new field gets a worked example, including `group` and a `quantity: 0` cut,
because a field with no example reads as dead — that is precisely how `edhrec_theme`
went unused.

## Verification

- **Property test, both directions**: for each of the six mutators, derive the diff,
  invert it, apply it, assert the deck is byte-identical to the original. This is the
  test that protects the whole design.
- **Mutation controls** on the derivation: drop `categories` from the diff schema, drop
  `custom_groups`, drop the actor comparison from the session rule, make the payload
  pool store per-change instead of per-printing. Each must kill a named test.
- **Session boundaries** at 179s and 181s, and an agent edit landing 5s after a user
  edit — which must still open a new session.
- **Idempotence**: the same `edit_deck` twice appends one history entry, not two.
- **Quota**: prune at the cap and assert the pooled payloads for surviving entries are
  intact and the orphans are gone.
- **Curve and price against the UI**: one deck, both code paths, same numbers —
  including a deck holding a card with no EUR price and one holding Dryad Arbor.
- **Failure controls, live**: an unresolvable card name, `quantity: 100`, an edit with
  no deck open, an edit the browser refuses, and a `read_history` on a deck with no
  history.
- **Live model turns**: an add, a swap, a cut, and a "what did we change earlier?"
  question that should hit `read_history` and nothing else.

## Phases and verification protocol

Six phases. File ownership is disjoint within each wave, so parallel workers cannot
collide.

### Phase 1 — `read_deck` reports the curve and the price

**Owns**: `backend/src/mtg_deck_builder/deck_agent_tools.py`,
`backend/tests/test_deck_agent_tools.py`. Nothing else. No frontend.

Implements Part A. Add `_curve_lines` and `_price_lines`, call both from `_read_deck`
between the section listing and the existing `see_cards` pointer.

**Verification protocol**

```
cd backend && .venv/bin/python -m pytest tests/test_deck_agent_tools.py -q
cd backend && .venv/bin/python -m ruff check src tests
```

- **A1** A deck with a commander and non-land cards renders a `Curve` block whose
  buckets are `0,1,2,3,4,5,6,7+`, weighted by quantity.
- **A2** The average mana value **excludes** the command zone and every card whose
  `type_line` contains `Land`, matching `useDeck.ts:383`. A fixture holding Dryad Arbor
  (`Legendary Creature — Land Dryad`) asserts it is excluded from the curve.
- **A3** The price line sums `prices.eur × quantity` over **every** card including the
  command zone.
- **A4** A card with no EUR price is reported as an unpriced **count in words**, and the
  total does not treat it as 0 silently. Negative check: the output must not claim a
  card is free and must not omit the count.
- **A5** An empty deck and a `None` deck still return their existing messages with no
  curve or price block.

### Phase 2 — the history module: derive, invert, apply, session, prune

**Owns**: `frontend/src/domain/history.ts` (new),
`frontend/src/domain/history.test.ts` (new). Nothing else — it must not touch
`useDeck.ts` this phase.

Implements the Part C schema and these pure functions.

**Built and verified 2026-08-01. The list below is the real API — the sketch that
preceded it was wrong in five places, each load-bearing. Phase 3 consumes exactly this,
not the sketch.**

```ts
export const DECK_HISTORY_STORAGE_KEY = "manabase.deck-history.v1";
export const DECK_HISTORY_SESSION_WINDOW_SECONDS = 180;
export const DECK_HISTORY_SESSION_CAP = 50;
export const DECK_HISTORY_PAYLOAD_CAP = 50;

createDeckHistory(deckId: string): DeckHistory
deriveDeckDiff(before: Deck, after: Deck): DeckDiffDerivation   // { diff, payloads }
isEmptyDeckDiff(diff: DeckDiff): boolean
invertDeckDiff(entry: DeckEditEntry): DeckEditEntry
applyDeckDiff(deck, diff, payloads): DeckDiffApplyResult        // { ok: true, deck } | failure
appendToHistory(history, { entry, payloads, actor, newSessionId }): DeckHistory
pruneHistory(history, sessionCap, payloadCap): DeckHistory
parseDeckHistory(value: unknown, fallback: DeckHistory): DeckHistory
```

1. **`DeckCardPlacement` carries `index`, and `DeckGroupPlacement` exists.** Without a
   recorded position, undoing a removal re-appends the card and the restored deck is
   order-different from the original — the round-trip property fails for every
   middle-of-list edit. `index` is deliberately **excluded from change detection**:
   cutting one card from a hundred shifts 59 positions, and counting those as 59 changes
   would break B8 and make every summary wrong. Position is a restoration hint, not an
   edit axis. **The honest limit this leaves**: a pure reorder of `cards` or
   `custom_groups` derives zero changes. No mutator reorders either list today — display
   order comes from `DeckBoard`'s sort — so it is unreachable, but it is the one way two
   `Deck`s can differ that this diff does not model.
2. **`DeckCardChange` carries `oracle_id`** as well as `scryfall_id`. `CardReference`
   requires it, so a restore needs it, and it is the identity the singleton and
   colour-identity warnings key on — so a change stays readable and linkable without the
   catalog *and* without the payload pool.
3. **`applyDeckDiff` takes the payload pool as a third argument and returns a typed
   result**, not a `Deck`. The two-argument sketch had no way to reach the payloads. A
   refusal is recoverable so the reducer can announce it rather than be stranded by a
   throw, and a restore whose payload was pruned **refuses** rather than producing a
   detail-less entry. Corrected 2026-08-01 after Phase 2's audit, because the original
   claim understated it: such an entry does **not** price at zero. `getCardPrice`
   (`domain/card.ts:272`) dereferences `card.prices` with no guard, and the `statistics`
   memo calls it as `getCardPrice(entry.card.details as CardSearchResult)` — a cast that
   launders `undefined` past the type checker — so a details-less entry **throws inside a
   `useMemo` and takes the board down**. It is reachable without any diff at all:
   `isDeckEntry` does not require `details`, so a deck persisted by an older build
   hydrates into that state. Phase 3 guards it.
4. **`appendToHistory` takes an options object and has no `now`.** The session gap is
   measured from `entry.at`, which the entry already carries; two sources for one edit's
   time is a disagreement waiting to happen. Refusing an empty diff returns **the same
   history object**, so the caller detects it by reference.
5. **`parseDeckHistory` and `createDeckHistory` were added.** Phase 3 owns persistence but
   not this file, so without a validator here it would have to invent one inside a hook,
   against the convention that puts `parseStoredDeck` / `parseStoredDeckLibrary` in
   `domain/`. It takes an already-parsed `unknown` rather than a JSON string, leaving the
   storage envelope Phase 3's choice.

Two further properties Phases 3 and 5 depend on: `invertDeckDiff` preserves `id`, `at` and
`reason` and recomputes only `summary`, so the **reducer** decides whether an undo pops the
entry or records a new one; and `applyDeckDiff` never checks the `before` side against the
deck it finds, which makes it **idempotent** — the property Phase 5's StrictMode assertion
needs.

**Verification protocol**

```
npm test --prefix frontend -- history
npx tsc --noEmit -p frontend
```

- **B1 (the load-bearing property test)** For a table of before/after deck pairs
  covering add, remove, quantity change, section move, group move, category change,
  group creation and deck rename: `applyDeckDiff(after, invertDeckDiff(derive(before,
  after)))` deep-equals `before`. Every field of `Deck` participates.
- **B2** Round-trip forward too: `applyDeckDiff(before, derive(before, after))`
  deep-equals `after`.
- **B3** A no-op mutation (`before` deep-equals `after`) derives an entry with zero
  changes, and `appendToHistory` refuses it — no empty entry is ever recorded.
- **B4** Session boundary: an edit 179s after the previous one by the same actor joins
  that session; 181s opens a new one. Assert `sessions.length` in both directions.
- **B5** Actor boundary: an `agent` edit 5s after a `user` edit opens a **new** session.
  Assert the new session's `actor` is `"agent"` and the user session is unchanged.
- **B6** Payload pool: adding and removing the same printing three times stores exactly
  **one** `CardSearchResult` under `cards`. Assert `Object.keys(history.cards).length`.
- **B7** Prune: at a cap of 3 sessions, the oldest is dropped, payloads referenced only
  by dropped entries are gone from `cards`, and payloads still referenced by surviving
  entries remain. Assert both sets by id.
- **B8 (negative check)** `deriveDeckDiff` must not emit a change for a card that did
  not change. A 100-card deck with one edit derives exactly one card change.

### Phase 3 — `useDeck` runs on the history log

**Owns**: `frontend/src/hooks/useDeck.ts`, `frontend/src/hooks/useDeck.test.ts`.
Depends on Phase 2.

Derive the diff centrally in the reducer from the before/after pair it already has;
append it to history with actor `"user"`; delete `historyByDeck`; make `undo` replay the
last entry backwards; persist history in the existing `useEffect`; add the `apply_edit`
action taking a resolved edit and an actor; carry history through `delete_deck` /
`restore_deleted_deck`.

**Verification protocol**

```
npm test --prefix frontend -- useDeck
npm test --prefix frontend
```

- **C1** Every existing `useDeck.test.ts` assertion still passes unchanged. Undo
  behaviour is preserved for all six mutators.
- **C2** Undo survives a remount: mutate, unmount, remount from `localStorage`, undo —
  the deck returns to its prior state. This is the behaviour today's in-memory stack
  cannot deliver, so it is the phase's headline assertion.
- **C3** `apply_edit` with a multi-card diff produces **one** history entry, and a single
  `undo` reverses the whole diff.
- **C4** An `apply_edit` the validators refuse changes nothing at all — no partial
  application and no history entry.
- **C5** History is written under `manabase.deck-history.v1`; the deck library key is
  untouched.
- **C6** `delete_deck` then `restore_deleted_deck` restores the deck **and** its history;
  `canUndo` is true afterwards.
- **C7 (negative check)** `historyByDeck` no longer appears anywhere in the file.

### Phase 4 — the contracts and the two tools

**Owns**: `backend/src/mtg_deck_builder/domain/agent_chat.py`,
`backend/src/mtg_deck_builder/deck_agent.py`,
`backend/src/mtg_deck_builder/deck_agent_tools.py`,
`backend/src/mtg_deck_builder/config.py`, `config.yaml`,
`backend/tests/test_deck_agent_tools.py`, `backend/tests/test_deck_agent.py`.
Depends on Phase 1 (same file).

Contracts, `edit_deck`, `read_history`, the `deck_edit` stream event, both tool
descriptions and the prompt's `# Editing the deck` section.

**Verification protocol**

```
cd backend && .venv/bin/python -m pytest -q
cd backend && .venv/bin/python -m ruff check src tests
```

- **D1** `edit_deck` with `quantity: 1` for a card not in the deck reports it added;
  with `quantity: 0` for a card in the deck reports it removed with its previous count.
- **D2** Idempotence: `quantity: 1` for a card already at 1 copy reports the change did
  nothing, and the emitted edit carries no change for it.
- **D3** An unresolvable card name fails the call with a message naming that card, and
  no `deck_edit` event is emitted.
- **D4** `quantity: 100` fails schema validation; `quantity` absent fails validation.
- **D5** An edit with no deck open is a failed `ToolOutcome`, not an exception.
- **D6** Warnings are reported, not enforced: an add outside the commander's colour
  identity succeeds **and** the result names the violation.
- **D7** `read_history` renders sessions newest-first with `You` / `Me` for the actor,
  honours `limit`, and says so plainly when no history exists.
- **D8 (negative check)** Neither tool result echoes the caller's own arguments — no
  restated quantity list, no restated reason.
- **D9** `read_deck`'s footer points at `read_history` only when history is present.
- **D10** Both new signatures pass through `_bounded()`; a 100-change edit cannot
  overflow `ShortLabel`'s 200 characters.

### Phase 5 — the browser applies the edit

**Owns**: `frontend/src/domain/agent.ts`, `frontend/src/domain/agent.test.ts`,
`frontend/src/components/DeckAgentPanel.tsx`,
`frontend/src/components/DeckAgentPanel.test.tsx`, `frontend/src/App.tsx`,
`frontend/src/App.test.tsx`. Depends on Phases 3 and 4.

Parse the `deck_edit` event, hand it to `onDeckEdit`, apply through `apply_edit` with
actor `"agent"`, render the applied-edit block with its Undo affordance, and post
`history` on the chat request.

**Verification protocol**

```
npm test --prefix frontend
npm run build
```

- **E1** A stream carrying a `deck_edit` event applies it: the deck gains the card and
  the transcript shows the applied block with the counts.
- **E2** The Undo affordance in that block reverses the whole edit in one click.
- **E3** An unknown event `type` is ignored without breaking the stream — the existing
  forward-compatibility contract.
- **E4** The chat request body carries `history`, bounded to the configured session cap.
- **E5** Rendered in `StrictMode`, a `deck_edit` event applies **once**, not twice. The
  reducer is the guard; assert the final quantity.
- **E6 (negative check)** No deck mutation happens from a turn with no `deck_edit`
  event.

### Phase 6 — docs, ADR, and the full gate

**Owns**: `docs/decisions/0036-*.md` (new), `docs/decisions/README.md`,
`docs/architecture.md`, `docs/implementation-status.md`, `changelog.md`, `AGENTS.md`,
`README.md`. Depends on Phases 1–5.

**Verification protocol**

```
npm test
npm run build
npx playwright test
cd backend && .venv/bin/python -m ruff check src tests
```

- **F1** Full gate green: backend pytest, frontend vitest, smoke, build, Playwright,
  ruff. Report the counts.
- **F2** The ADR records the three decisions taken and names the central derivation as
  the mechanism.
- **F3** `docs/decisions/README.md` lists 0036 and no number is skipped.

## Deferred

- **Redo.** The log makes it nearly free — replay forward — but nothing asked for it and
  it needs its own UI affordance.
- **A history panel for the user.** The agent reads history; the user still sees only
  the Undo button. The data supports a timeline view whenever that is wanted.
- **Cross-deck history.** Scoped per deck, like the chat transcript.
- **Server-side history.** Would make it survive a browser wipe and readable across
  devices, and it needs deck persistence first.
- **`edit_deck` creating groups.** It can place a card in an existing group; making a
  new one is `addCustomGroup`'s job and would widen the diff schema.
- **Partner and background command zones**, still unhandled here as in `see_cards` and
  `search_cards`. `plan.md` calls multi-card command zones a product principle, so all
  three should be fixed together.
