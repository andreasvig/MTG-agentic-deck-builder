# ADR 0033: The Agent Braces Card Names, And The Backend Turns Them Into Cards

- Status: Accepted
- Date: 2026-08-01

## Context

The deck agent's whole job is naming specific cards, and the system prompt tells it to.
But a name in prose is only a name: the reader who wants to see `Fyndhorn Elves` has to
go and search for it, in an application that is already showing that card two panels
over. Everything needed to show it is local.

Recognising a card name in free prose is the hard half. Fuzzy-matching every capitalised
phrase against a catalog of thirty thousand names would find cards in sentences that
contain none, so the agent marks them instead.

## Decision

### The agent braces, the catalog decides, the browser renders

The prompt requires every card name in an answer to be written `{Sol Ring}`, in full,
every time. The backend then resolves those braces against the same catalog `see_cards`
reads, and the reply carries a `card_links` list of `{name, oracle_id}` alongside the
prose. The browser renders the name as an element, hover shows the card image, click
opens the card in the inspector the deck board already uses.

Resolution is the **backend's** for three reasons, and each of them is load-bearing:

- **Braces already mean mana in Magic.** The agent quotes rules text, so `{T}`, `{C}{C}`
  and `{W/U}` appear in answers. Only a catalog can say that no card is called `T`.
- The interface needs an Oracle id to open anything, and it has no name-to-card route.
- The catalog corrects the agent's casing to the printed name and matches a
  double-faced card by its front face, exactly as it does for `see_cards`.

Deduplication is by case-folded name, first mention first, capped at
`MAX_CARD_LINKS` — an answer naming sixty distinct cards has problems a cap will not fix,
but it should not become an unbounded query on the way.

### An unresolved brace is still a card name

A name the catalog does not recognise renders as the words the agent wrote, without the
braces and without an underline. The braces never reach the reader: a stray `{` is a
defect in the answer's *prose*, which is worse than a name that happens not to open.
Dropping the underline is the honest part — the underline is the promise that clicking
does something.

### Streaming shows the same words, and gains the links at the end

Nothing is resolved until the turn commits, so the live view parses with no links at
all. Because a braced name renders as its name either way, the visible words are already
final while streaming and only the ability to open a card arrives with `done`. That
keeps [ADR 0031](0031-streamed-deck-agent-turns.md)'s invariant intact: what streams
converges on what is committed.

The parser refuses to match across a line break for the same reason — mid-stream a chunk
ends anywhere, and a greedy marker would blank the rest of the answer until its closing
character arrived. The backend regex carries the same restriction so the two sides
cannot disagree about where a name ends.

### Bold and italic, because the renderer had to exist anyway

`**bold**` and `*italic*` were rendering as literal asterisks; the prompt has always
asked for short Markdown. Turning text into nodes for card names made this a few lines
rather than a project. Lists, headings and links are deliberately not handled — the
prompt forbids them, and code guarding against output the agent should not produce is
code nobody will ever see run.

Emphasis holds **tokens, not text**, so the parse descends into it. The agent bolds the
card it recommends — `**{Overwhelming Stampede}**` — and the first version of this parser
was flat, which rendered exactly that as literal braces in bold. The card the reader
most wants to click was the one card that could not be clicked, while an ordinary
unbolded mention beside it worked. Nesting is not an edge case here; it is the common
case, and it was missed because every test wrote the two constructs separately.

## Consequences

- Card links are stored with the transcript, so a restored conversation is still
  clickable. They are small enough that the storage budget never trades them away.
- One extra catalog query per turn, on an indexed name lookup. A catalog that cannot be
  read costs the turn nothing: links are an enhancement, and failing an answered turn
  over one would be absurd.
- The preview is portalled to `document.body`. Inside the transcript, which scrolls, it
  would be clipped by the first card name near an edge.
- Card images are fetched on hover and cached per message, so a card named three times
  in one answer is fetched once and a long conversation does not accumulate images
  nobody is looking at.
- **A name that does not resolve is silent.** Nothing tells the user, or us, that the
  agent named a card the catalog could not find. If the agent turns out to abbreviate
  names in practice, the evidence will be a missing underline rather than a report.

## Verification

Live against the real model and catalog: asked for one-mana ramp on a Ghalta deck, the
agent answered *"I'd play {Llanowar Elves} and {Elvish Mystic}; each taps for one green
mana. {Fyndhorn Elves} is an identical alternative"* and all three resolved.

In a real browser, hovering a name showed the card image positioned to the left of the
name and fully on screen, and clicking opened the same inspector the board opens. Both
were screenshotted and read. `{C}{C}` stayed as written and an unresolvable name
rendered as plain words.

Fourteen planted mutants died, each killed by the test meant to kill it: resolution
skipped, dedup made case-sensitive, the cap removed, unresolved names linked anyway,
braces allowed to span a newline, mana symbols treated as cards, unresolved names
dropped from the render, link lookup made case-sensitive, markers allowed to span a line
break, the image cache removed, the hover never cleared, and — after the nesting fix —
emphasis flattened back to text, which killed the two nesting tests and nothing else.

**The browser found a bug that jsdom could not.** The preview never appeared in the real
application, while seven component tests passed. A `useEffect` cleanup cleared a
"still mounted" ref that nothing ever set, and StrictMode mounts, cleans up and mounts
again — so in the dev build the flag was false from the first render and every fetched
card was discarded. The fix is one line; the durable part is that `AgentAnswer`'s tests
now render inside `StrictMode`, which was confirmed by replanting the bug and watching
three of them fail.
