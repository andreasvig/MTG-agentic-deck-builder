# ADR 0030: One Chat Per Deck, Saved Locally, With Expandable Tool Calls

- Status: Accepted
- Date: 2026-07-31

## Context

[ADR 0027](0027-conversational-deck-agent-without-tools.md) put the deck agent's
transcript in the browser, held by `DeckAgentPanel` as component state. That was
right for one deck and wrong for a library: the panel stays mounted across a deck
switch, so a conversation about *Ghalta Stompy* was still on screen — and still being
posted back to the model — after the user opened a different deck. Switching decks
also left that transcript as the only place the old conversation existed, so it went
away on reload while the decks themselves persisted.

[ADR 0029](0029-read-only-deck-agent-tools.md) then made every tool call visible as a
line of text. What the line does not say is *what the agent actually read* — the
difference between a good answer and a plausible one is usually in the tool's output,
and the search agent already answers exactly that question with its expandable trace.

## Decision

### The conversation belongs to the deck

`useDeckAgentChats(deckId)` holds every deck's conversation — turns, running spend,
unpriced-call count and the unsent draft — keyed by deck id, and persists the store
under `manabase.deck-agent-chats.v1`. Switching decks switches conversation; coming back
to a deck comes back to what was already said about it, spend included. **Reset chat**
clears one deck's conversation and no other's.

The composer's draft is part of that state rather than component state: a half-written
question about one deck is about that deck, so it waits there instead of following the
user to the next one. It is saved with the conversation, so a reload does not lose it,
and a restored draft is held to the composer's own 8,000-character limit so it can
always be sent.

The whole store is held rather than one conversation at a time, and every mutator takes
its deck id explicitly, so a reply cannot be filed against whichever deck happens to be
on screen when it lands.

### A reply in flight is abandoned on a deck switch

Answering into a deck the user has left is worse than not answering, so the pending
request is aborted when `deckId` changes. The question stays in the transcript it was
asked in — the same behaviour as a failed turn — so going back and sending again
retries it.

### The chat store has a byte budget

The deck library shares the same browser-storage quota and holds every card's full
Scryfall payload. A chat store that grew without limit would eventually stop *decks*
from saving, which is a far worse failure than losing an old transcript, so
`serializeAgentChats` spends a fixed character budget newest-chat-first and
newest-turn-first:

1. only the twelve most recently used decks' conversations are written at all;
2. a turn is written whole while there is room;
3. then without its tool payloads;
4. and once there is no room, the remaining older turns are left out.

Diagnostics are therefore dropped before transcripts, and the conversation the user is
looking at is the last thing to go.

### A tool call opens onto what it read

`DeckAgentToolCall` gained `arguments_json` — the arguments the model sent, as JSON
text — and `result`, the exact text handed back to it. With debug mode on, the tool
line becomes a disclosure holding two sub-boxes, **Call** and **Result**, the same
shape as the search trace's nested layers.

Both fields are populated **only for a turn whose request set `debug`**, mirroring how
the search trace is only built for a search that asked for it. A `read_deck` result is
kilobytes of text, and posting it back to a client with nowhere to show it is waste.
The consequence is that turns taken before debug mode was switched on stay plain
lines: null means *not requested*, never "the call had no arguments" or "it returned
nothing", and a line that opened onto an empty box would be claiming the latter.

Payloads that exceed `MAX_TOOL_PAYLOAD_CHARS` are truncated with a visible marker
naming how much is missing, because a listing that looks complete and is not is worse
than one that admits it was cut. Only the copy sent back to the browser is trimmed —
the model read the whole thing.

## Consequences

- A deleted deck's conversation is kept rather than deleted with it, so the delete's
  **Undo** restores a working conversation. The twelve-chat cap collects it later.
- A deck whose only content is an unsent draft is still persisted, since that draft is
  the question the user was in the middle of asking.
- Restoring a chat from storage can produce turns whose payloads were dropped by the
  budget. They render as plain lines, which is what a turn with no payload is.
- Two mixed naming conventions now sit in one persisted object: the wire shape of a
  tool call (`arguments_json`) inside locally-shaped chat state (`spentUsd`). Each half
  matches its origin; renaming either would mean rewriting it on every read.
- The panel is no longer self-contained — it needs a deck id — which is the honest
  shape now that conversations belong to decks rather than to the panel.

## Verification

Beyond the unit, contract and browser tests, both halves were exercised live against
`openai/gpt-5.6-luna`:

- A debug turn asking about a two-card Ghalta deck produced `read_deck()` and
  `see_cards(Sol Ring · prices, inclusion)` with the model's real arguments
  (`{"cards": ["Sol Ring"], "details": ["prices", "inclusion"]}`) and the real result
  text, answering with 73% of 6,249 Ghalta decks and €0.73 / $1.88. $0.00029, 8.7s.
- The same request with `debug: false` — the disabled control — returned every payload
  as null and a 750-character reply, proving the gate is the flag and not the presence
  of tools.
- Per-deck switching, its persistence across a reload, and the sub-boxes actually
  becoming visible on click were verified in Chrome, because `<details>` content is in
  the DOM whether or not it is open and jsdom cannot tell the two apart.
- Eight planted mutants — four backend, four frontend — were each killed by the
  intended test.
