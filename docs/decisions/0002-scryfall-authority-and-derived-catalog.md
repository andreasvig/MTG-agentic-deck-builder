# ADR 0002: Scryfall Authority With A Derived Local Catalog

- Status: Accepted, partially implemented
- Date: 2026-07-23

## Context

The editor needs current card metadata, images, legality, selected-printing
identity, and useful EUR estimates. Always using live Scryfall is simple but
limits offline behavior, complete-corpus semantic search, and predictable bulk
queries. Owning an independent canonical card dataset would create substantial
refresh and correctness work.

Cardmarket credentials are not available. Scryfall exposes daily EUR estimates
and Cardmarket verification links without separate authentication.

## Decision

- Treat Scryfall as the authoritative card-data source.
- Keep Scryfall HTTP and wire models behind a provider boundary.
- Use `oracle_id` for gameplay identity and `scryfall_id` for printing identity.
- Use remote Scryfall images rather than mirroring the image library.
- Use Scryfall daily EUR values as estimates, not guaranteed offers.
- Link to Cardmarket for manual verification.
- Build a derived local SQLite read model from Scryfall `default_cards`.
- Refresh gameplay data atomically and use live Scryfall for misses, advanced
  syntax, and newly released cards.
- Consider MTGJSON later for exact Cardmarket trend history, not as the primary
  gameplay authority.

## Current Implementation

Shipped:

- Live Scryfall provider.
- Provider-neutral public domain models.
- Rate-conscious request spacing.
- Process-cached card-name catalog for fuzzy search.
- Daily EUR display and Cardmarket links.

Not shipped:

- SQLite schema and importer.
- Atomic bulk refresh.
- Indexed local lexical or vector search.
- Persisted price history.

## Consequences

Positive:

- Correctness and new-card coverage remain delegated to Scryfall.
- The later local index can be rebuilt rather than treated as irreplaceable
  primary data.
- UI, rules, and agent code remain provider-neutral.

Costs:

- Live workflows require network access until the catalog exists.
- First fuzzy lookup must download the name catalog.
- Scryfall rate and query semantics affect latency and recall.
- Price values are daily estimates and may not equal a live Cardmarket listing.

## Rejected Alternatives

- Always-live Scryfall forever: rejected because complete-corpus semantic search
  and repeatable local analysis need a derived dataset.
- Fully self-owned canonical dataset: rejected because it duplicates Scryfall's
  update and normalization work.
- Direct Cardmarket API for MVP: rejected because credentials are unavailable.
- Downloading all card images: rejected because remote URLs are sufficient for
  personal local use.
