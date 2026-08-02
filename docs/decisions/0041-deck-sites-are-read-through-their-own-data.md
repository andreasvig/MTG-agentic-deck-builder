# ADR 0041: Deck Sites Are Read Through Their Own Data

- Status: Accepted
- Date: 2026-08-02

Extends [ADR 0040](0040-web-research-through-sonar.md), which added `search_web` and a
generic `read_page`.

## Context

ADR 0040 shipped `read_page` as one HTML-to-text reader for the whole web. Running it
against the sites a Magic search actually returns showed that the generic path is not
merely noisy on the ones that matter most — it is wrong, in three distinct ways.

The 314 citations collected during the Sonar bake-off resolve to 56 hosts, dominated
by `reddit.com` (69), `youtube.com` (56) and `edhrec.com` (55), with a deck-site tail
of `mtggoldfish.com` (9), `tappedout.net` (6), `archidekt.com` (3), `deckstats.net` (3)
and `cedhstat.com` (3). Every one of those was fetched and read.

**Silent.** MTGGoldfish answers `403` to `/deck/<id>`, `/deck/download/<id>` and
`/deck/arena_download/<id>`, but serves `/deck/visual/<id>`, where every card name
lives in an `img alt` — which is exactly what an HTML-to-text extractor discards. The
generic reader returned 2,699 characters of type counts, price, footer and newsletter
signup, and **not one card name**. It looked like a successful read of a deck page.

**Drowned.** TappedOut's first 6,000 characters are chat widgets, inventory panels and
price comparisons; the decklist begins on part two. Its own `?fmt=txt` export is the
entire list in 1.4 KB.

**Expensive.** Archidekt renders across five parts — fifteen or more tool rounds — what
its API returns in a single call, and EDHREC's commander pages interleave real
inclusion figures with filter UI across four.

That last one is the sharpest. EDHREC is the second-most-cited domain of all and its
numbers are precisely the ones ADR 0040 caught Sonar fabricating worst — Esika's 25,116
decks reported as 854. The correct figures are one unauthenticated request away.

## Decision

**A dispatch table in front of `read_page`, not a second tool.** The agent keeps calling
`read_page` with whatever URL it has. Behind it, a host match may swap in a structured
endpoint and render the result as text. Seven adapters, all verified live against
unauthenticated endpoints:

| Site | Read instead from |
| --- | --- |
| EDHREC | `json.edhrec.com/pages/<section>/<slug>.json` |
| Archidekt | `archidekt.com/api/decks/<id>/` |
| MTGGoldfish | `/deck/visual/<id>`, card names taken from the image tiles |
| TappedOut | `<deck-url>?fmt=txt` |
| Aetherhub | `/Deck/MtgoDeckExport/<id>` |
| Commander Spellbook | `backend.commanderspellbook.com/variants/` |
| cEDHstat | `cedhstat.com/api/decklists/<id>` |

A tool the model must learn to choose between is a tool it will sometimes choose wrong.
A URL it already has, read better, is free.

**A miss always falls back.** An unmatched path, a payload that will not parse, a
download the byte cap cut, an endpoint that errors — every one of them returns the page
to the generic reader rather than reporting a failure. An adapter is an optimisation on
a known shape, never the only way a page can be read. EDHREC's `/articles/` paths, its
`/themes/`, its section indexes and its 743 KB `/decks/` payload are all left generic
for exactly this reason, and each was checked one at a time rather than assumed.

**Adapters share the reader's guards.** Each is handed a getter bound to the fetcher, so
an endpoint goes through the same scheme check, address resolution and byte cap as any
other URL. An adapter cannot reach somewhere `read_page` could not.

**The rendering states its own provenance.** Every adapter result's second line begins
"Read from …". This is a real distinction and the system prompt now turns on it: a
summary's numbers may never be repeated as fact, while a `read_page` result carrying
that line holds the site's own figures and may be used as such. Card names are the
exception in both directions — a database's spelling is still not the local catalog's,
so `see_cards` still runs before the agent says one out loud.

**Nothing volatile is rendered.** Pagination refetches and re-splits rather than
remembering, so a field that changes between two reads would move every boundary after
it. Archidekt's view count ticked from 4,878 to 4,881 during development and is
deliberately left out. Archidekt reports its format as a bare integer with no name
attached, so that is left out too rather than guessed at.

## Consequences

Four sites were measured and deliberately have no adapter. **Moxfield** answers 403 to
every endpoint including its own front page — the largest deckbuilding site on the web
is entirely closed, which its total absence from all 314 citations corroborates.
**Deckstats** 403s on both HTML and `api.php`, **mtgdecks.net** 403s on everything, and
**MTGTop8** times out after 20–25 seconds. None of them is hardcoded as blocked: a
refusal written into the code would outlive the block, whereas letting the fetch report
its own 403 will not.

Reading cEDHstat surfaced a defect worth recording. Its `cards` array contains three
rows in a `metadata` section whose `card_name` values are `format`, `game` and
`importedFrom`, marked apart only by a null `card_uuid`. The first implementation
rendered them as cards — three non-cards in a decklist, inside the feature whose whole
purpose is keeping non-cards out of the agent's mouth. Rows without a card behind them
are now skipped.

Each adapter is a new coupling to a private endpoint that carries no compatibility
promise. The fallback is what makes that acceptable: a shape change degrades a site to
the generic reader rather than breaking `read_page`. The live checks are not part of the
suite, so a silent regression to the generic path is possible, and re-running them is a
manual step.

MTGGoldfish's `/deck/visual/` page carries only names, so unlike the API-backed
adapters it recovers no categories or sideboard.
