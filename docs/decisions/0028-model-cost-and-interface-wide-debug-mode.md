# ADR 0028: Report Model Cost From The Provider's Own Accounting, Behind One Interface-Wide Debug Mode

- Status: Accepted
- Date: 2026-07-31
- Amends: [ADR 0027](0027-conversational-deck-agent-without-tools.md)

## Context

Two agents now spend money on the user's behalf: the search agent runs two model
calls on every weak-title query, and the deck agent runs one per chat turn at
`xhigh` reasoning effort. Neither showed what it cost. The trace view reported
duration to the millisecond and price not at all, and a chat conversation gave no
indication of its running total.

Debug mode, which decides whether the trace is requested at all, lived in a
`Settings` popover inside the card-search drawer. That was the right home while it
governed only search tracing, and the wrong one as soon as a second surface needed
the same preference.

## Decision

**Cost comes from `usage.cost` in the provider's response, never from token
arithmetic.** OpenRouter reports what it actually charged, in USD credits.
Multiplying token counts by a hardcoded price would drift silently the moment a
model, its pricing or its routing changed, and the drift would look like a fact.
The parser lives in `providers/openrouter.py` with the rest of that wire format, and
both agents call it.

**An unreported cost is `None`, never `0.0`.** "Not reported" and "free" are
different claims and only one of them is safe to add into a total:

- A local fuzzy search makes no model call, so its trace carries no price and the
  trace view shows no badge rather than showing `$0.0000`.
- A chat turn the provider did not price increments a separate count, and the
  panel renders the total as `$0.0020+` so a total missing a turn says so instead of
  quietly reading low.
- A non-zero cost too small to render at four decimals shows `<$0.0001`, because a
  real charge displayed as `$0.0000` is the one reading that would be wrong.

**A search round's price is the sum over its model calls**, read back out of the
raw responses the trace already captures. Nothing new is recorded to compute it, and
a run that failed late still reports the calls it paid for — a failure is exactly
when the user most wants to know whether they were charged.

**The chat total belongs to the conversation, not the session**, so **Reset chat**
clears it along with the transcript.

**Debug mode is one interface-wide preference**, owned by the workspace shell in
`useDebugMode` and passed to both the search drawer and the deck agent. It is
reachable from `Settings` in the editor toolbar without opening card search first.
The `manabase.search-debug` storage key is deliberately unchanged: renaming it to
match its wider scope would silently reset the preference for no benefit.

## Consequences

- Both prices are only visible with debug mode on. The trace was already gated that
  way; the chat total now is too, so the panel header stays quiet by default.
- The search drawer no longer owns a settings control, and the search trace can no
  longer be enabled from inside the drawer. Flipping it mid-search was never
  reachable anyway, since the toolbar is inert while the drawer is open.
- Removing the drawer toggle exposed a test that had been relying on the previous
  test's `localStorage` write for its debug state. It now passes the preference
  explicitly, which is better isolation than it had before.
- `SearchDebugSummary` gains `total_cost_usd` and the deck agent reply gains
  `cost_usd`. Both are nullable, so a client that has not been updated keeps
  validating.
- Cost is reported, not budgeted. There is no spend cap, no daily total and no
  persistence across a reload; if a ceiling is ever wanted, this is the figure to
  enforce it against.
