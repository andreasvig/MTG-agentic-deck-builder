# ADR 0024: Select the Cheapest Ordinary Printing

- Status: Accepted
- Date: 2026-07-31
- Amends: [ADR 0002](0002-scryfall-authority-and-derived-catalog.md)

## Context

Scryfall's `default_cards` export contains every English paper printing — 94,790
of them for 33,323 Oracle cards. The importer keeps exactly one printing per
Oracle card, and that single choice decides the art, the image, the set shown in
the inspector, and the EUR estimate everywhere in the application.

The original rule ranked a printing by image, then price presence, then
non-promo, and broke every remaining tie on the **newest release date**. For any
reprinted card the newest printing is almost always a special product, so the
catalog systematically surfaced the collector version:

| Card | Selected under the old rule | Cheapest ordinary printing |
| --- | --- | --- |
| Forest | €0.19, full-art crossover land | €0.02 |
| Cultivate | €8.50, Secret Lair | €0.32 |
| Sol Ring | €1.16 | €0.61 |
| Bayou | €8015, Summer Magic | €294, Revised |

Measured over the installed catalog, 10,014 of 32,497 priced cards (30.8%) were
represented by a printing dearer than that card's cheapest one, median overpay
1.62x and p90 4.17x, totalling €152k against €109k. The most frequent selected
sets were The List, Jumpstart, Secret Lair and the Marvel Commander decks.

Two consequences beyond appearance. The agent's `price_eur` filter reads the
selected printing's price, so under a €1 cap **897 cards were excluded that have
an ordinary printing below €1** — "cheap ramp under €1" could not return
Cultivate. And a deck total built from these prices overstates the real cost of
assembling the deck by roughly 40%.

Two upstream changes had to be handled to rebuild at all. Scryfall replaced the
JSON-array bulk export with line-delimited JSON (`jsonl_download_uri`), dropped
`download_uri`, `content_type` and `size` from the listing, and serves the body
as `application/gzip` with no `Content-Encoding` header. The strict discovery
model rejected the new listing outright, so `catalog:sync` was already failing.

## Decision

Rank printings so the highest key wins, most significant tier first:

1. The printing must have an image.
2. It must have a EUR price.
3. It must not be a **special** version.
4. Cheapest wins.
5. Newest release date, then Scryfall id, break remaining ties.

Cheapness sits *below* ordinariness on purpose: a plain printing is preferred
even when a full-art or promo one costs a few cents less. Cheapness sits *below*
price presence for a different reason — a card with no price silently disappears
from every price filter, so a priced special printing beats an unpriced ordinary
one.

A printing is special when Scryfall marks it `promo`, `full_art` or `textless`,
when it has no `nonfoil` finish, or when its set type, set code, border colour,
security stamp, promo types or frame effects appear in the configured lists. The
rules live in `printing_selection` in `config.yaml`, each with a comment naming
what it excludes, because they are taste and will need tuning.

Nothing is ever dropped. A card whose every printing is special falls back to the
cheapest special one, which is what keeps Un-set cards, Secret Lair exclusives
and premium-collection cards in the catalog.

Supporting changes:

- Accept either bulk export shape. `download_uri` and `jsonl_download_uri` are
  both optional, at least one must be present, and the line-delimited export is
  preferred. Compression and format are decided from the URI suffix, since the
  headers no longer disclose either.
- Bump the catalog schema version to 3, so an installed v2 catalog rebuilds
  rather than serving stale selections against new code.

## Consequences

Positive:

- Search, card details and deck totals show the ordinary printing of a card at
  roughly the price of actually buying it.
- The agent's `price_eur` filter becomes meaningful: 897 cards return to a €1
  budget search.
- `catalog:sync` works again against Scryfall's current bulk API.
- The exclusion rules are configuration, so a printing that still looks wrong is
  a config edit rather than a code change.

Costs:

- 1,778 cards (5.7%) are now represented by a printing dearer than their absolute
  cheapest, because that cheapest one is a special version. Median premium 1.23x,
  p90 2.17x, €1.3k across a €106k catalog. The tail is worse than the median:
  Ravages of War shows €94.66 where a €25.20 special printing exists.
- 1,549 cards have no priced ordinary printing and fall back to a special one.
- Any change to `printing_selection` needs `catalog:sync --force` and a full
  semantic re-embed to take effect; the rules are not applied at query time.
- The selection is still one printing per card. Users who want a specific
  printing have no way to ask for it.

## Rejected Alternatives

- **Cheapest printing outright**, ignoring whether it is special: rejected by
  Andreas after both were measured. It saves €1.3k catalog-wide but reintroduces
  full-art and Secret Lair versions as the canonical face of a card.
- **Keep the selected printing and show a separate cheapest price**: fixes the
  price and the filter but leaves the full-art Forest in place, and gives each
  card two competing identities.
- **Exclude the whole `box` set type** to catch Secret Lair: rejected because
  `box` also holds Game Night, the Guild Kits and Battle Royale, which are
  ordinary cheap reprints. Secret Lair is named by set code instead.
- **Exclude `universesbeyond` printings**: rejected as too blunt. It would
  reclassify the only printing of every Universes Beyond card, and price ordering
  already prefers an ordinary reprint where one exists.
- **A price ceiling that reverts to a cheap special printing** when the ordinary
  one costs many times more: deferred, not rejected. It needs a threshold nobody
  has a value for, and the 5.7% tail above is the evidence it would act on.
- **Re-selecting from the stored `printings` table** instead of re-importing:
  rejected because it would mean a second selection code path, and the domain
  card model does not retain `promo`, `set_type` or `full_art`.
