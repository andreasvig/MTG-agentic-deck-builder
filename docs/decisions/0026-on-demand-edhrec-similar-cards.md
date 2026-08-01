# ADR 0026: Cache EDHREC Similar Cards Per Card On Demand

- Status: Accepted
- Date: 2026-07-31
- Amends: [ADR 0015](0015-on-demand-edhrec-commander-ranking.md),
  [ADR 0016](0016-commander-theme-evidence-in-agentic-search.md)

## Context

Tagger's `SIMILAR_TO` data ([ADR 0025](0025-surface-every-tagger-relationship-classifier.md))
covers 7,119 of 33,323 catalog cards — about 21% — so most cards have no
similar-card suggestions at all.

EDHREC publishes its own similar-card list on every card page at
`/pages/cards/<slug>.json`, and it is complementary rather than redundant: where
Tagger's `SIMILAR_TO` is curated by hand, EDHREC's list is generated, so it covers
cards nobody has tagged.

EDHREC does not document how the list is computed, but the observed results are
clearly **functional** rather than co-occurrence based: Squirrelanoids returns six
budget deathtouch one-drops, which are alternatives to each other and would
essentially never appear in one deck together. Deck co-occurrence lives elsewhere
on the same page, in the separate `cardlists` block. Probed across staples,
obscure commons and basic lands, the key is always present and always holds
exactly six names:

| Card | EDHREC `similar` |
| --- | --- |
| Sol Ring | Mana Vault, Grim Monolith, Worn Powerstone, Thran Dynamo, Basalt Monolith, Mind Stone |
| Lightning Bolt | Chain Lightning, Shock, Play with Fire, Lightning Strike, Incinerate, Lava Spike |
| Command Tower | Exotic Orchard, Path of Ancestry, Arcane Signet, Mana Confluence, City of Brass, Reflecting Pool |
| Forest | Snow-Covered Forest, Dryad Arbor, Tree of Tales, Tranquil Thicket, Slippery Karst, Khalni Garden |

The payload is **names only** — no Scryfall id, no synergy score, no deck counts.
List order is the only ranking signal on offer.

## Decision

Fetch a card's EDHREC page on demand and cache the names in the existing EDHREC
sidecar (schema 3, additive tables `card_similar_snapshots` and
`card_similar_cards`).

**The names and their resolution have different lifetimes, and are cached
accordingly.**

- **The names age slowly.** They are functional, so they only move when new cards
  are printed. They get their own `edhrec.similar_refresh_after_days`, defaulting
  to **180 days**, rather than the 30-day window commander pages use — a commander
  page carries deck counts and synergy percentages that genuinely drift weekly, and
  reusing that rule would refetch an unchanged list a dozen times a year against a
  free community host.
- **The resolution to Oracle identities is not cached at all.** It is a join
  against the local catalog, which changes on every `catalog:sync`, so it is
  re-derived on every read. A name stored as unresolvable becomes openable as soon
  as the catalog contains it, with no refetch and no wait for the 180-day window.
  The resolved id is still written to `card_similar_cards`, as a record of what
  resolved at fetch time, but reads never trust it.
- **On demand per card, never in bulk.** EDHREC offers no bulk export, so
  covering the catalog would mean 33,323 requests against a free community host.
  That is not a defensible thing to do for a personal tool, so similar cards are
  fetched only for a card the interface actually shows.
- **Names are resolved locally, by exact name, ignoring case**, with a fallback to
  the front face for double-faced cards catalogued as `front // back`. Six indexed
  lookups per read is cheaper than the staleness a cached join would introduce.
- **An unresolved name is stored and returned, not dropped.** It is a real
  suggestion the interface simply cannot open, and keeping it makes resolution
  failures visible instead of silently shortening the list. The interface omits
  unresolved entries from its links rather than rendering a dead control.
- **A card listing itself is stored unresolved.** Pointing a card at itself is
  never a useful suggestion.
- **An empty list is a legitimate answer and is cached.** Only an absent `similar`
  key is treated as a bad page, so a card EDHREC has nothing to say about is not
  re-fetched on every view.
- **The interface stays silent on failure.** The similar-card section renders
  nothing while loading and nothing on error, because the Tagger groups beside it
  are local and must never be delayed or replaced by an EDHREC outage.

### Prerequisite bug fix: apostrophes in EDHREC slugs

`edhrec_slug` treated the apostrophe as ordinary punctuation and mapped it to a
separator, producing `thassa-s-oracle`. EDHREC closes the gap instead:
`thassas-oracle` answers HTTP 200 and the separated form answers **403**.

This was not a new problem introduced here — it had been breaking commander
enrichment for every card whose name contains an apostrophe, which is **2,344 of
33,323 catalog cards and 189 legal commanders**, including Yuriko, the Tiger's
Shadow. Verified live after the fix: 11 of 12 sampled apostrophe commanders became
reachable and a no-apostrophe control stayed reachable. The twelfth,
`Ano'thr, Equipment Commander`, is `commander: not_legal` and has no EDHREC page,
which is expected absence rather than a slug failure.

An existing test had pinned the broken output, so it asserted the behaviour rather
than the contract; it now pins the reachable slug.

## Consequences

- Similar cards cost one HTTP request per card per 180 days, and the first view of
  a card is slower than the local Tagger groups beside it. Every later view is local
  apart from the catalog lookup that re-resolves the names.
- The sidecar is still disposable and still additive across versions: schema 3
  adds tables and accepts a schema 1 or 2 database in place. Verified against the
  installed sidecar — its 3 commander snapshots and 785 associations survived the
  upgrade untouched.
- The EDHREC list is not a search signal and does not affect ranking. Making it
  one would require the bulk coverage this ADR declines to fetch.
- List order is preserved as `rank` because it is the only ranking EDHREC gives;
  no score is invented to sit beside it.
