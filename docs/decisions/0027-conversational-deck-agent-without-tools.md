# ADR 0027: A Conversational Deck Agent With No Tools And A Client-Held Transcript

- Status: Accepted
- Date: 2026-07-31

## Context

The right side of the workspace has been reserved for a deck agent since the first
layout decision, and `plan.md` describes the eventual version: typed tools to
inspect the deck, run shared validation, search the catalog and propose a patch the
user confirms. None of that machinery exists yet — there is no deck API, no patch
schema and no confirmation flow, and [ADR 0018](0018-runtime-owned-and-query-explicit-filters.md)'s
recommended order puts patch schemas before chat.

Waiting for all of it before putting anything in that column means the panel, its
transport, its memory model and its failure states all arrive at once, in the same
change as the tools. This ADR takes the plumbing first, deliberately without tools.

## Decision

Ship a plain conversational agent in the reserved right column: one model call per
turn, no tools, no deck access, no deck mutations.

**The transcript lives in the browser and is posted back in full on every turn.**
There is no server-side chat session.

- It matches where state already lives. Decks are browser-local and FastAPI holds
  no user state; a chat session cache would be the first exception, and the second
  place a conversation could be lost.
- It survives the backend. `npm run dev` runs uvicorn with `--reload`, so a saved
  backend file restarts the process. A server-side transcript would be dropped on
  every edit, in the exact workflow this is used in.
- It makes **Reset chat** honest. Forgetting is local and immediate, and there is
  no server copy that could outlive the button.
- `agent.max_history_messages` (default 40) is therefore the whole of the agent's
  memory: the browser may hold a longer conversation, but only the newest messages
  within the window are replayed. Trimming takes the newest end, never the oldest,
  so the current question always survives.

**The prompt states what the agent cannot see.** With no tools, the failure mode is
not a wrong tool call but a confident answer about a deck the agent never read. The
system prompt says it has no tools and no deck access, and requires it to ask for
the commander, the list or the budget rather than guess, and never to state card
text or a price as though it had looked it up. Verified live: asked "what is the
single most important card to add, and can you see what is already in my deck?", it
answered *"I can't see your decklist or open deck — only what you type here"* before
recommending anything.

**All of it is configured under a top-level `agent:` block**, separate from
`search.agentic`, because the two are separate agents with separate budgets:

| | Search agent | Deck agent |
| --- | --- | --- |
| Model | `openai/gpt-5.6-luna` | `openai/gpt-5.6-luna` |
| `reasoning_effort` | `low` | `xhigh` |
| `timeout_seconds` | 20 | 180 |
| Tools | `search_local_cards`, exactly once | none |

The search agent runs on every weak-title query and pays for effort in latency the
user is waiting on; a deck answer is asked for deliberately and can afford to
think. They also get separate `OpenRouterClient` instances, because a shared client
would apply one of the two timeouts to both.

`reasoning_effort` accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and
`max`. `provider.require_parameters` is on, so an unsupported value fails the call
with an HTTP 400 that names the accepted set rather than being silently dropped —
verified live for `xhigh`, with a deliberately invalid value as the control.

**An empty reply is a contract error, not an answer.** A reasoning model can spend
its budget thinking and return empty content beside a populated `reasoning` field.
That is HTTP 200 with nothing to show, so it answers 502, while an unreachable
provider answers 503. `temperature` stays absent unless configured, for the same
`require_parameters` reason as the search agent.

**The panel is desktop-only for now.** A 328px column beside the board does not fit
a phone, and a full-width panel below the board would push the deck off screen.

## Consequences

- The reserved right column is no longer empty, and the invariant that it belongs
  to the deck agent is now satisfied rather than pending.
- The agent cannot answer anything that depends on the deck. This is the honest
  state of a no-tool agent and the prompt is written to say so out loud, but it does
  limit the panel to general Commander advice until tools land.
- A conversation is lost on page reload. The transcript is React state, not
  `localStorage`, so nothing new is persisted and no storage key or migration is
  introduced by this change.
- Cost is visible rather than implicit: each turn's price is reported and the panel
  totals the conversation while debug mode is on
  ([ADR 0028](0028-model-cost-and-interface-wide-debug-mode.md)).
- When typed tools arrive they extend this transport rather than replace it, and
  the patch/confirm/undo flow `plan.md` describes is still required before the agent
  is allowed to touch a deck. Nothing here grants it that.
- The two agents now build near-identical OpenRouter payloads in two places. That
  duplication is deliberate for one no-tool agent and should be unified into a
  shared payload builder when the deck agent gains its own tool loop, not before.
