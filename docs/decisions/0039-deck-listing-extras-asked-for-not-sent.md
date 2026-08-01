# ADR 0039: The Deck Listing's Extras Are Asked For, Not Sent

- Status: Accepted
- Date: 2026-08-01

Narrows the `read_deck` output described in
[ADR 0029](0029-read-only-deck-agent-tools.md) and extended by
[ADR 0036](0036-auto-applied-agent-edits-on-a-derived-deck-history.md).

## Context

`read_deck` carried two summaries on every call, unasked: a quantity-weighted mana
curve drawn as an ASCII bar chart, and one line totalling the deck's EUR estimate. The
reasoning was that these are the two numbers a player checks first, and that a listing
which made the agent spend one of its four tool iterations learning its own curve would
be answering half the question.

Two things were wrong with it.

The bar chart was drawn for a human and read by a language model. Eight rows of
`█` blocks in two padded columns, each bar scaled down whenever the widest bucket
exceeded twenty cards, is a shape you *look* at; a model reads it by counting glyphs
and its own count is what the row already states in digits. The layout cost tokens on
every call to render a picture the reader had to parse back into the number beside it.

And "unasked" was the wrong default in the other direction too. The tool's own
description promised "names and ids only: no card text, no mana costs, no prices" while
the tool printed a price total, which is the same class of defect ADR 0037 found in the
placement field: prose that contradicts what the code does is read as the contract.
Meanwhile the figures a player asks about most — what *this* card costs, what *this*
section costs — were in neither the listing nor the summary, and getting them meant
`see_cards` on a hundred cards, one card at a time.

## Decision

**One argument, `extra_info`, holding any of `mana` and `price`.** Neither is sent
unless asked for, which makes the description true again and keeps a bare listing the
cheap thing to call first. Each value carries one figure down *every* card line and
totals it underneath, rather than being a separate report:

- `mana` puts each card's printed mana cost on its line and the curve under the deck.
- `price` puts each card's EUR estimate on its line, a total beside each type heading,
  and the deck's existing total at the bottom.

**The curve is a markdown table.** Two columns, mana value against card count, one row
per bucket, with the average underneath — the same buckets and the same two exclusions
as before (`_counts_toward_curve` is unchanged, so the tool and the statistics memo in
`useDeck.ts` still cannot give two different correct answers). The bars are gone
entirely, and with them `_CURVE_BAR_MAX`, `_CURVE_BLOCK` and `_curve_bar`.

**A card line's price is the line total, with the unit price beside it.** `4x One Drop
— EUR 2.00 (4 x 0.50)`. The heading totals are quantity-weighted, so unit prices alone
would not add up to them, and a reader who cannot reproduce a total has to trust it.

**What is missing is stated, never folded in.** A card with no EUR estimate reads `no
EUR estimate`; a heading whose section holds unpriced cards states the count beside its
total; a section with no estimates at all reports no figure rather than `EUR 0.00`.
This is the convention `_price_lines` already followed for the deck, applied one level
down: a card with no price is not a free card. The frontend still reads a missing
estimate as `0` in the deck header (`getCardPrice`), and that departure is deliberate
and documented where it happens.

**The extras are canonicalised, and the listing says which it is missing.** Asked for
in either order, or twice, they are applied in one order — cost before price — and the
tool line reads `read_deck(mana, price)` whatever arrived. Underneath, the listing
offers only the extras it did *not* carry, so a priced listing does not offer the price
again and a listing carrying both offers nothing.

## Consequences

- The tool line now carries an argument, so `read_deck()` is no longer the only
  signature the chat can show. It is built from the raw argument on the failure path,
  which is what makes a rejected `extra_info: ["colour"]` readable in the transcript.
- The system prompt gained a rule for *when* to ask: `extra_info` is for a question
  about the deck as a whole, `see_cards` for a question about a card. Without it the
  model has two ways to learn a price and no reason to prefer either.
- A card printed with no mana cost — a land, or a face the catalog stores without one —
  falls back to `MV <value>`, not to a blank and not to `MV 0`. Dryad Arbor is the case
  that separates those two, and it is pinned as one.
- The average mana value and the deck price no longer appear on a turn that did not ask
  for them, so a model that used to see them incidentally now has to ask. That is the
  trade this ADR makes: one argument against a summary nobody requested.

## Known gaps

- The curve table has no share column. A bucket's percentage of the deck is derivable
  from the counts, and a third column on eight rows is a token cost on every `mana`
  call.
- `price` totals per *type* heading, because that is what the listing is grouped by. A
  total per colour or per theme would need a different grouping, not another extra.
- Nothing caps how many extras one call may ask for, because there are two of them.
  A third would want the `see_cards` treatment: a default set in `config.yaml`.
