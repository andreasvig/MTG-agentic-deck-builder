# ADR 0040: Web Research Through Sonar, With the Catalog Still the Authority

- Status: Accepted
- Date: 2026-08-02

Adds two tools to the set established by
[ADR 0029](0029-read-only-deck-agent-tools.md) and extended by
[ADR 0035](0035-the-deck-agent-searches-the-catalog-itself.md).

## Context

Every tool the deck agent had read local data: the card catalog, the Tagger sidecar,
the EDHREC cache, the posted deck and its history. That covers what a card *is* and
what it is *played with*, and it cannot answer the question a player actually opens the
chat panel with when they are looking for a direction — has anyone built this, what do
people do with this commander, why is this card suddenly showing up, what came out last
month. Those answers exist in primers, brew threads, published lists and write-ups, and
none of that is in a card database.

The obvious way to add it is a general web search. The question was which one, and what
to believe of what it returns.

## The bake-off

All four Perplexity Sonar tiers OpenRouter carries were run against five deliberately
hard deck-inspiration questions — obscure commanders with real combos, archetypes
built from a mechanic nobody rates, budget cEDH, brand-new sets — with latency, cost,
citation yield and answer quality recorded, plus a separate six-call reliability
sample per tier.

| tier | median | median $/call | citations | deck-site cites | clean runs |
| --- | --- | --- | --- | --- | --- |
| `sonar` | **5.1s** | **$0.0056** | 47 | 8 | 6/6 |
| `sonar-pro` | 19.6s | $0.0401 | 47 | 8 | 6/6 |
| `sonar-reasoning-pro` | 42.5s | $0.0136 | 64 | 13 | **4/6** |
| `sonar-pro-search` | 26.3s | $0.0558 | **137** | **52** | 6/6 |

`perplexity/sonar-reasoning` was also requested and does not exist on OpenRouter — the
model id 404s with "No endpoints found".

Three findings decided it.

**The pro tiers buy length, not accuracy.** `sonar-pro` costs seven times `sonar` and
runs four times slower for *the same 47 citations and the same 8 deck-site links*. On
the questions where the tiers disagreed, the disagreement was verbosity.

**`sonar-reasoning-pro` is not reliable enough to build on.** It returned a body with
`finish_reason: stop`, no content and no usage block at all, twice; and stopped with
`finish_reason: length` at 577 and 975 completion tokens against a 4000-token cap. A
control at the same cap finished cleanly at 1924 and 1637 tokens, so the truncation is
upstream, not ours. Roughly a third of its calls were degraded.

**Every tier is right about mechanics and wrong about identifiers.** This is the
finding that shaped the design, because it is invisible to a reader:

- Rules reasoning held up under checking. The Denry Klin persist line the models
  described is real — the +1/+1 counter its trigger applies cancels persist's -1/-1,
  so with a sacrifice outlet it loops. All four tiers named the correct recent sets.
- Every EDHREC number was fabricated. Against EDHREC's own JSON: Esika **25,116** decks
  reported as 854, Go-Shintai **20,304** reported as 159, Eladamri **850** reported as
  6. Wrong by up to 128x, stated flatly, with a citation attached.
- Card names arrive corrupted rather than invented. `sonar-pro` produced a complete
  budget deck — ability text, a €0.14 price, a full total — around "Gretian Titcho".
  No such card. The real one is **Gretchen Titchwillow**, and the colours, the 0/4
  body, the four-mana activated cost and the exact ability were all correct. Only the
  name was wrong.

A corrupted name is the dangerous case here, because the name is the catalog's lookup
key. Prose that is 95% right and names a card that does not exist reads exactly like
prose that is right.

## Decision

**`perplexity/sonar` is the tier**, in `agent.tools.web.model`. It is a tenth the price
and a fifth the latency of `sonar-pro-search` for the same conclusions, and neither
invented card name in the bake-off came from it.

**Two tools, advertised as a pair.** `search_web(question)` returns Sonar's prose with
its citations numbered beneath it; `read_page(url)` fetches one of those URLs as text.
A search that produces links is half a tool without a way to follow them, so if either
half cannot run, neither is advertised.

**The catalog stays the authority, and the boundary is stated in the result.** Every
web tool result ends with the same sentence: nothing in it has been checked, and any
card the agent means to name goes through `see_cards` or `search_cards` first. The
system prompt carries the same rule with the failure mode spelled out, including the
instruction that a name the catalog rejects usually means a mangled name rather than a
fictional card — the card is probably real and worth searching for.

This also closed a loophole ADR 0029's phrasing had opened. The standing rule was
"never recommend a card you have not seen in a tool result this turn", and a web result
*is* a tool result. It now names the three local tools explicitly.

**Sources keep Sonar's order.** Its prose cites `[1]`, `[2]` positionally, so the list
is rendered in the order returned and duplicates are dropped in place. Sorting or
renumbering would repoint every marker in the summary.

**Plain fetch, not a renderer.** `read_page` is stdlib `urllib` plus `HTMLParser`, with
no new dependency. Firecrawl or a headless browser is the upgrade path and is
deliberately not taken yet.

**A long page is paginated, not cut off.** `read_page(url, page)` splits a document
into parts of `page_max_characters` and every part that has a successor ends by naming
the exact call that fetches it. Reading on is another tool round the agent can choose to
spend, rather than a truncation it cannot do anything about — a primer or a decklist
longer than one part is still readable end to end.

Nothing is stored between calls: part 2 refetches the URL and re-splits it, which keeps
this boundary as stateless as the rest of the backend, at the cost of one more request.
The split is therefore required to be deterministic on the text, or consecutive parts
would overlap or skip. Breaks land on a line ending when one falls in the back half of
the window, so a decklist is never cut through a card name.

Asking past the last part fails and names the real count, rather than silently returning
the last one — a caller that cannot tell "you overshot" from "this is the end" will
either loop or stop early.

## Consequences

A URL chosen by a model is untrusted input, so `read_page` restricts the scheme to
http(s), resolves the host and refuses any private, loopback or link-local address,
caps the response in bytes before reading it, and accepts only HTML and plain text.
This app has its own API on loopback; a chat message must not be able to reach it.

Two measured accommodations sit in the fetcher, both from watching what Sonar actually
cites. Reddit is the most-cited domain and `www.reddit.com` returns no readable text at
all, so it is rewritten to `old.reddit.com`, which serves the same thread as HTML.
Hosts that build their pages in the browser — YouTube, Facebook, X, Instagram, TikTok —
are refused by name with the reason, because YouTube is the worst case: it answers
`200` with its cookie footer, so a plain fetch appears to succeed and returns nothing.
Refusing costs one clear sentence instead of one wasted tool round. YouTube is around
17% of all citations, so this is common, not hypothetical.

A turn that searches costs about half a cent more and several seconds more. The search
fee dominates the token cost, so `max_tokens` bounds the prose rather than the spend.

## Known gaps

- No rendering fetch, so a JavaScript-only source can only ever be read through
  Sonar's summary of it.
- Card names in web results are not resolved against the catalog in code; the rule
  lives in the tool result and the system prompt. Extraction from free prose is
  unreliable enough that a bad implementation would be worse than the rule — the
  benchmark's own name extractor scored headings and curly apostrophes as
  hallucinations before it was fixed twice.
- `read_page` keeps whatever site chrome is not inside a `<nav>`, so a page's first few
  hundred characters are often menus, and part 1 of a long article is the worst affected.
- Pagination is stateless, so the parts are only stable while the page is. A document
  that changes between two calls can shift its own boundaries underneath the reader.
- `page` is bounded at 100, which at the configured part size is far more text than a
  turn can use. A document longer than that cannot be read to its end this way.
- One search per question; no follow-up querying, and no reranking of sources.
