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
endpoint and render the result as text. Eight adapters, all verified live against
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
| YouTube | oEmbed for the title and channel, the watch page for the description |

**YouTube is an adapter, not a refusal.** It is around 17% of everything a Magic search
cites and a plain fetch of a watch page returns its cookie footer with a `200`. There is
no transcript to be had — `api/timedtext` now answers `200` with an empty body — but the
title, the channel and the description are public, and on a deck tech the description is
routinely where the decklist link is. The renderer refusal therefore runs *after* the
adapters, so a watch URL is read while a channel or search URL still gets the honest
refusal instead of a cookie footer.

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

**A fetch is reused for the span of one read.** Pagination refetches by design, which
made walking EDHREC's five-part Sol Ring page five identical 137 KB downloads. A short
window keyed on the URL removes four of them, and closes the one honest gap in the
stateless design: within the window the parts of one document come from one download, so
their boundaries cannot disagree. `page_cache_seconds` defaults to 120 and zero disables
it.

**A fetched decklist is checked against the catalog.** ADR 0040 listed resolving web
card names in code as a known gap and gave the reason: pulling names out of prose is
unreliable, which the bake-off's own extractor proved twice. That reason does not survive
an adapter, whose output is a `12 Island` line built from a database row. So each adapter
now *declares* the names it knows are cards — declared, not parsed back out of its own
rendering, because a total line reading `100 cards · by Vader94` parses as a card called
"cards · by Vader94" — and `read_page` names the ones the catalog does not have, with the
instruction to resolve rather than to conclude the card is fictional.

Names are normalised to the catalog's spelling first: NFKC, then the quote and dash
families to ASCII. Measured against the real catalog, *Ashnod's Altar*, *Thassa's Oracle*,
*Lim-Dûl's Vault* and *Long-Term Plans* resolve only with that step, and all four were
scored as fabrications during the bake-off without it.

**Search results say which sources can be read in full.** A ten-source list is otherwise
a blind choice, and the difference is large: an Archidekt link comes back as an exact
decklist and a forum thread as whatever survives HTML-to-text.

**Nothing volatile is rendered.** Pagination refetches and re-splits rather than
remembering, so a field that changes between two reads would move every boundary after
it. Archidekt's view count ticked from 4,878 to 4,881 during development and is
deliberately left out. Archidekt reports its format as a bare integer with no name
attached, so that is left out too rather than guessed at.

## Consequences

Three sites were measured and deliberately have no adapter. **Deckstats** 403s on both
HTML and `api.php`, **mtgdecks.net** 403s on every page worth reading, and **MTGTop8**
times out after 20–25 seconds. None of those is hardcoded as blocked: a refusal written
into the code would outlive the block, whereas letting the fetch report its own 403 will
not.

**Moxfield is the exception, and it is named.** The largest deckbuilding site on the web
cannot be read at all — its API 403s everything, which its total absence from all 314
citations corroborates — but it does not fail cleanly, and that is what earns it a place
on the script-built list rather than being left to the network. See the consequence
below.

Reading cEDHstat surfaced a defect worth recording. Its `cards` array contains three
rows in a `metadata` section whose `card_name` values are `format`, `game` and
`importedFrom`, marked apart only by a null `card_uuid`. The first implementation
rendered them as cards — three non-cards in a decklist, inside the feature whose whole
purpose is keeping non-cards out of the agent's mouth. Rows without a card behind them
are now skipped.

Each adapter is a new coupling to a private endpoint that carries no compatibility
promise. The fallback is what makes that acceptable: a shape change degrades a site to
the generic reader rather than breaking `read_page` — but it degrades *silently*, and
every other test in the suite stubs the transport and so cannot see it happen. Hence
`tests/test_web_sites_live.py`, marked `live` and excluded from the default run: it
asserts the shape each adapter depends on against the real endpoints, and `pytest -m live`
is the thing to run after touching one.

Writing those checks immediately found two things the earlier measurement had wrong.
**Moxfield** does not simply 403: `/decks/public` answers `200` with forty-three
characters reading "Loading Moxfield. This may take a minute…", a placeholder that reads
exactly like a very short deck — so it is named as script-built rather than left to look
like a successful read. And **mtgdecks.net** serves its front page happily while 403ing
every page worth reading, so the closed-site check had to name a real path instead of a
homepage.

MTGGoldfish's `/deck/visual/` page carries only names, so unlike the API-backed
adapters it recovers no categories or sideboard.
