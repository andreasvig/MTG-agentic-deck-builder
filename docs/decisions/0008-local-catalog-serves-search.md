# ADR 0008: Local Catalog Serves Normal Card Search

- Status: Accepted
- Date: 2026-07-27
- Supersedes: ADR 0007's live title-fetch and continuation mechanism

## Context

The threshold-free fuzzy phase originally ranked a process-cached Scryfall
name list, then issued exact-name Scryfall queries for each result page.
Structured filters could reject those names, which required cursor state,
multiple backfill queries, and large generated OR expressions.

The repository already selected Scryfall `default_cards` plus SQLite as its
target derived read model. Normal title search does not need live provider
semantics once that model contains full card metadata.

## Decision

- Build `local-data/cards.sqlite3` from the compressed Scryfall
  `default_cards` bulk export.
- Stream the export into a temporary database and install it with an atomic
  file replacement after integrity validation.
- Store all eligible English paper printings and one selected representative
  printing per `oracle_id`.
- Serve every normal fuzzy-title query exclusively from the local catalog.
- Preserve ADR 0007's RapidFuzz scoring, aliases, lack of threshold, and lack
  of candidate cap.
- Apply structured filters locally before slicing simple numbered pages.
- Keep Scryfall network access in the explicit catalog-refresh command, not in
  API routes or the search request path.
- Keep card images remote.

## Consequences

Positive:

- Search latency and result count no longer depend on Scryfall query parsing,
  rate limits, or generated OR expressions.
- `Forest`, `Ghalta`, and misspellings all use the same complete local card
  corpus.
- Filters cannot cause under-filled intermediate pages.
- **Load more** needs only the next page number.
- A failed refresh preserves the installed database.

Costs:

- Initial setup downloads and imports a large bulk dataset.
- Newly published cards appear only after the next refresh.
- A missing catalog makes search unavailable until synchronization completes.
- The running process keeps parsed card objects in memory for fast repeated
  ranking and reloads them after an atomic database swap.

## Rejected Alternatives

- Continue exact-name Scryfall batches: rejected because the local metadata
  already contains the fields needed for filtering and display.
- Cache only card names: rejected because that still requires live card-detail
  queries.
- Add a fuzzy score cutoff: rejected for this phase; a later semantic fallback
  may use score evidence without hiding fuzzy candidates.
- Download all card images: rejected because remote image URLs remain adequate.
