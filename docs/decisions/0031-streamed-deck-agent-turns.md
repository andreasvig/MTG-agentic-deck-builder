# ADR 0031: Stream A Deck Agent Turn, Tool Calls First

- Status: Accepted
- Date: 2026-07-31

## Context

A deck agent turn at `xhigh` reasoning effort takes eight to sixteen seconds, and
[ADR 0029](0029-read-only-deck-agent-tools.md) made it longer still: a turn is now one
completion per tool round plus a final one. Until it finished, the panel showed
"Thinking…" and nothing else — no sign that the deck had been read, no sign of what
the agent was looking up, and no text until every byte of it existed.

The measured turn from ADR 0029's verification is the case in point: `read_deck` had
finished at 8.1 seconds and `see_cards` at 10.2, but the first thing the user could see
arrived at 11.4.

## Decision

### One loop, two transports

`DeckAgentService._run` is the single implementation of a turn. It takes optional
emitters; `chat()` passes none and uses `chat_completion`, while `stream()` passes
both and uses `stream_chat_completion`. Both assemble the same assistant message
shape, so the loop around them cannot tell which transport ran, and both end in the
identical `DeckAgentChatReply`.

`POST /agent/chat/stream` yields server-sent events:

- `tool` — one finished tool call, sent the moment it runs;
- `text` — a piece of the answer as the model writes it;
- `done` — the finished turn, carrying exactly the reply `POST /agent/chat` returns;
- `error` — a failure that happened after the response had already begun.

Everything the interface *keeps* comes from `done`. Text and tool events are
presentation only, which is what keeps the streamed and non-streamed paths from
diverging in what they store, what they charge, or what they replay.

### Streamed text converges on the committed message

Text from a round that then calls tools is preamble, not the answer — the committed
turn keeps only the final round's prose, as it always has. So when a `tool` event
arrives, the panel discards the live text it has accumulated and starts fresh.

That rule exists to hold one invariant: **what streams must converge on what is
committed.** Without it, the bubble would silently change content at `done`, and the
transcript would disagree with what the user just watched being written.

Reasoning deltas are deliberately *not* streamed. At `xhigh` they are most of the
turn and none of the answer, so the panel says it is thinking rather than narrating
the thinking.

### An error after the first byte has to travel in-band

A status code is spent once the response starts, so the route checks
`agent.available` *before* returning a `StreamingResponse` — an agent that is switched
off still fails as an ordinary `503`. Anything that fails later becomes an `error`
event carrying the same code and wording the JSON route would have used, from one
shared definition so the two cannot drift.

### Streaming stays inside the existing provider boundary

`OpenRouterClient` grew `stream_chat_completion` rather than an HTTP dependency: the
connection is opened and read line by line in worker threads, keeping the injectable
`open_url` that makes the boundary testable. Reads are strictly sequential, so the
response object is only ever touched by one thread at a time.

Two things about the wire that had to be handled rather than assumed:

- `: OPENROUTER PROCESSING` keep-alive comments arrive while a reasoning model
  thinks. They are ordinary traffic, not faults.
- A streamed tool call is delivered in pieces — id and name in one chunk, arguments a
  few characters at a time across the next several, keyed only by `index`. They are
  reassembled into exactly the shape a non-streamed call has, because the loop and the
  echo back to the provider both read it that way.

Cost needs `usage: {include: true}`, since a streamed response otherwise reports none.
Verified live: it does not conflict with `provider.require_parameters`.

## Consequences

- **The interface uses only the streaming route.** The frontend's JSON client method
  was removed rather than kept as a fallback: an untested fallback is worse than none.
  `POST /agent/chat` remains as the plain-JSON API contract with its own tests.
- A turn that fails mid-stream has already put text on screen. It is discarded and the
  question is kept, exactly as a turn that failed before producing anything.
- Switching decks mid-stream drops the partial answer as well as the request. Only a
  finished turn is ever stored.
- The live bubble is hidden from assistive technology (`aria-hidden`). A live region
  announcing every chunk would be unusable; the committed turn is announced once,
  whole.
- Playwright fulfils a route with one whole body, so the browser tests prove the wire
  format and the parsing rather than the timing. Incremental rendering is asserted
  where it can be driven event by event — the panel's own tests — and observed live.

## Verification

Measured against `openai/gpt-5.6-luna` at `xhigh`, on a two-card Ghalta deck, with the
same question ADR 0029 used:

| event | before | streamed |
| --- | --- | --- |
| `read_deck()` visible | — | 8.1s |
| `see_cards(...)` visible | — | 10.2s |
| first text on screen | 11.4s | 11.0s |
| turn committed | 11.4s | 11.4s |

48 text events, `cost_usd` `$0.000165` with `unpriced_call_count` 0 — so streamed
usage accounting works. In the real interface against the real backend, the tool line
appeared at 1.5s and the caret at 2.3s for a `read_deck`-only turn, and the committed
transcript held exactly one copy of the answer.

Ten planted mutants died: tool events emitted only at the end, argument fragments
overwritten instead of joined, the first usage figure kept instead of the last,
`[DONE]` treated as a chunk, a streamed error yielded instead of raised, and five
frontend mutants covering per-deck chat, drafts and the expander.
