# ADR 0029: Two Read-Only Deck Agent Tools, Answered From A Posted Deck Snapshot

- Status: Accepted
- Date: 2026-07-31

## Context

[ADR 0027](0027-conversational-deck-agent-without-tools.md) shipped the deck agent
deliberately without tools, taking the panel, transport, memory model and failure
states first. Its prompt had to say *"you have no tools, no access to the open deck"*
and ask the user to type out their own deck list — which is the thing the application
already knows.

The eventual version in `plan.md` is typed tools that inspect the deck, run shared
validation, search the catalog and propose a patch the user confirms. Reading and
mutating are separable, and only mutation needs a patch schema, a confirmation flow
and an undo story. Reading needs none of that.

## Decision

Give the agent exactly two tools, both **read-only**, and show every call in the
chat.

### `read_deck()`

No arguments — there is only ever one deck open. Returns the deck grouped under each
card's primary type, with names, a short id and the on-screen custom group, and
**deliberately no card text**:

```text
Deck "Ghalta Stompy" — 35 cards, 6 distinct.

Commander (1)
  Ghalta, Primal Hunger [b0b6be0c]

Artifact (1)
  Sol Ring [6ad8011d]  [group: Ramp]

Land (30)
  30x Forest [b34bb2dc]
```

Withholding rules text is the point: a hundred-card deck with full Oracle text is a
large, mostly irrelevant payload on every turn. The listing ends by naming
`see_cards` as where to go for more.

### `see_cards(cards, details)`

`cards` takes exact names, full ids, or the short ids `read_deck` handed out.
`details` chooses the depth per card, from a closed set where **every value is backed
by data the application already holds**: `rules`, `prices`, `tags` (Scryfall Tagger),
`similar` (EDHREC), `inclusion` (EDHREC, for this deck's commander) and `legality`.
It defaults to `rules`, so an EDHREC lookup only happens when it was asked for.

## The deck travels with the turn

The backend holds no deck — decks are browser-local per ADR 0027 — so
`DeckAgentChatRequest` gained an optional `deck` snapshot that the browser posts
alongside the transcript, carrying only identity and placement
(`scryfall_id`, `quantity`, `section`, `group`).

Names, type lines, rules and prices are resolved **from the local catalog**, never
from the client. The agent therefore cannot be told the deck holds a card the catalog
disagrees about, and a printing the catalog does not know is reported as such rather
than dropped from the list.

The snapshot is a snapshot, not a subscription: the agent sees the deck as it was
when the question was asked, and the prompt says to read it again if the user has
just changed something.

## One bounded loop per turn, always ending in prose

A turn is now `agent.tools.max_iterations` rounds of *ask → run tools → ask again*,
followed by **one final completion that advertises no tools at all**. A model that
would keep calling tools forever still has to answer, so a turn can never end with
nothing the user can read.

That last pass also carries `agent.tools.final_pass_instruction`, which tells the model
in words what the missing toolbox tells it in structure. Taking the tools away is not
self-explanatory: the model is mid-task, its own instructions require a lookup it can no
longer make, and what it does instead is write the call it wanted as prose —
`to=search_local_cards` and an arguments object, delivered as the answer. Measured
2026-08-02 against `openai/gpt-5.6-luna`: 5 of 5 forced final passes leaked without the
instruction, 0 of 3 with it, while the same conversation *with* tools advertised was
clean 4 of 4. The leaking replies also cost three to seven times as many completion
tokens as the answers that replaced them.

The tier matters too — `gpt-5.6-terra`, at ten times the price, was clean 3 of 3 on the
same prompt — but the instruction fixes it on the cheap tier for nothing, and the trap
is one this loop sets rather than one the model brings.

Consequences:

- **A turn costs several completions.** `cost_usd` sums every one of them, and
  `unpriced_call_count` reports how many returned no figure, so a part-priced turn
  reads as `$0.0020+` rather than silently low.
- Tool failures are **not** turn failures. An unavailable catalog, sidecar or EDHREC
  page comes back as text the model reads and adapts to, and as a struck-through line
  in the chat. Only an unreachable provider is still a 503.
- Malformed tool arguments are passed to the toolbox rather than dropped, so the
  model gets a correction it can act on instead of silently repeating itself.

## Every call is visible

The reply carries `tool_calls`, each with the `signature` the backend rendered —
`read_deck()`, `see_cards(Sol Ring, Cultivate · inclusion, tags)` — and the panel
prints one small monospace line per call above the answer it produced. The interface
never reconstructs a call from its arguments, so what is displayed cannot drift from
what ran. Tool lines show regardless of debug mode: what the agent read is part of
the answer, not diagnostics.

## Prompts stay in `config.yaml`

Both tool descriptions live in `agent.tools` beside the system prompt. They are the
only thing telling the model when a tool is worth calling, so they are prompt text,
and keeping them in code would put half the prompt out of reach.

## Alternatives considered

- **Client-side tool execution** — the backend returns a tool call, the browser runs
  it and posts back. Keeps the deck entirely local, but turns one request into a
  multi-round protocol and puts the loop's correctness in the client.
- **Sending the resolved deck** (names, type lines and text) instead of ids. Larger
  payload, and it makes the client the authority on card data.
- **A `search_cards` tool** so the agent could propose cards outside the deck. This
  is the search agent's job and it has its own tuned prompt, filters and evaluation
  gap; wiring a second, differently-tuned caller into it belongs in its own decision.
- **Mutation tools now.** Deliberately deferred: needs a patch schema, a confirmation
  flow and undo, which is the next ADR rather than this one.

## Consequences

- The agent answers questions about the deck without asking the user to retype it,
  and quotes real Oracle text and real prices.
- Reading is consistent with the interface by construction: the same catalog, the
  same Tagger sidecar, the same EDHREC cache, and the same primary-type precedence
  the board uses.
- That precedence is now expressed twice — `_PRIMARY_TYPE_PRECEDENCE` in
  `deck_agent_tools.py` and `primaryCardType` in `frontend/src/domain/card.ts`. Both
  carry a comment naming the other; the alternative was making the client the
  authority on card types.
- `see_cards` reports Tagger's tags unfiltered, matching the card details panel,
  which means naming-scheme labels such as "single English word name" appear
  alongside gameplay tags. The exclusion list in `search.semantic_sort` exists for
  the embedding document only; a second tag policy for the agent was not worth
  diverging from what the user sees.
- Still no mutation, no catalog search, no persistence across reload, and no mobile
  entry point.

## Verification

Beyond unit and contract tests, this was exercised live against
`openai/gpt-5.6-luna` at `xhigh`, because a tool loop fails at the provider boundary
where no local test reaches:

- A question spanning both tools produced `read_deck()` then
  `see_cards(6ad8011d · rules, prices)` — the model reused the **short id** from the
  listing — and answered with the real Oracle text and the real €0.73 / $1.88 price.
- An EDHREC question produced `see_cards(Sol Ring, Cultivate · inclusion, tags)` with
  real figures (73% of 6,249 Ghalta decks, synergy +0.02).
- Turns cost ~$0.0004 over three completions and took 13–16 seconds.
- The first live run leaked a mid-sentence self-correction into the prose
  (*"**4,?** Wait tool says 6,249"*), which added a line to the prompt's Output
  section; it did not recur in two re-runs.
