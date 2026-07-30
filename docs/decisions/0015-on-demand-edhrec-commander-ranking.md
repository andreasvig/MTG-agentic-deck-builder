# ADR 0015: On-Demand EDHREC Commander Ranking

Status: Superseded by [ADR 0016](0016-commander-theme-evidence-in-agentic-search.md)

Date: 2026-07-30

## Context

Filter-only card discovery is useful for browsing a commander deck, but the
local catalog has no commander-specific popularity evidence. EDHREC commander
pages expose community deck counts, potential-deck counts, and synergy through
a public but undocumented JSON representation.

A complete EDHREC mirror would be unnecessarily large and frequently stale for
this personal local application. Making EDHREC a hard runtime dependency would
also make ordinary local search less reliable.

## Decision

- Fetch only the selected single commander's normal EDHREC page, and only when
  a user requests filter-only search with **Enhance with EDHREC** enabled.
- Keep that switch on by default when exactly one commander is selected.
- Cache the untouched source JSON and normalized commander-to-card rows in the
  separate `local-data/card-edhrec.sqlite3` sidecar.
- Treat a snapshot as fresh for 30 days. Missing or older snapshots are fetched
  synchronously on demand. If that refresh fails, do not silently serve the
  stale snapshot; use normal local ordering and report the unavailable state.
- Map EDHREC's Scryfall printing IDs through the canonical catalog's
  `printings` table and persist associations by Oracle ID.
- Sort the complete filtered candidate set by known association, raw inclusion
  (`num_decks / potential_decks`), deck count, then the existing local order.
  Unknown cards remain after known cards; they are not interpreted as zero
  inclusion.
- Do not apply EDHREC ranking to typed fuzzy or agentic searches.
- If fetching, normalization, or cache access fails, return the normal local
  result page with a typed `unavailable` enhancement status. The drawer must
  display a clear error explaining that local sorting was used.

## Boundaries

- The JSON interface is undocumented and may change.
- V1 supports one commander and the normal commander page only. Partner-pair
  pages, themes, budgets, brackets, and display of raw EDHREC metrics are
  deferred.
- EDHREC does not replace Scryfall as the canonical card-data source.
- The feature is intended for low-volume personal testing, not bulk crawling.

## Consequences

Commander-aware browsing gains useful community evidence without expanding the
main card schema or blocking local search. The sidecar can be deleted and
rebuilt independently. The first enhanced browse after a cache miss may wait
for the network, and provider drift is surfaced explicitly rather than hidden.
