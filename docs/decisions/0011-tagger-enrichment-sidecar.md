# ADR 0011: Tagger Data Lives In An Optional Enrichment Sidecar

- Status: Accepted (transitional)
- Date: 2026-07-29

ADR 0012 supersedes only this record's original prohibition on runtime search
reads: explicit user-selected tag filters may now read local Oracle
memberships. The acquisition, sidecar, and no-ranking boundaries remain.

ADR 0014 later supersedes the no-ranking boundary for bounded Oracle-card tag
concepts only. Exact Tagger relationships remain outside embeddings and
ranking.

## Context

Scryfall Tagger contains community-maintained Oracle-card tags and explicit
card relationships such as `SIMILAR_TO`, `REFERENCES_TO`, and
`REFERENCED_BY`. These values may later improve semantic documents, candidate
expansion, or explanations, but that product behavior has not been selected.

Scryfall's documented card API and normal bulk exports do not expose Tagger
data. An undocumented Scryfall Oracle-tag bulk endpoint exposes tag
definitions and complete Oracle-ID membership lists. The Tagger website's
paginated GraphQL endpoint separately exposes card relationships. Both
interfaces may change.

The main `cards.sqlite3` catalog is atomically replaced during a normal
Scryfall refresh. Adding independently refreshed Tagger tables to that file
would either erase them during refresh or couple two sources with different
availability and update behavior.

## Decision

- Acquire Tagger data only through the explicit `npm run tagger:sync` command.
- Keep both undocumented transports and their wire models behind
  `providers/tagger.py`.
- Store the result in the independently replaceable
  `local-data/card-tagger.sqlite3` sidecar.
- Key Oracle taggings and relationships by Scryfall `oracle_id`.
- Import every Oracle tag and Oracle-ID membership from Scryfall's bulk tag
  payload, then every Tagger relationship whose foreign key is `oracleId`.
- Preserve tag descriptions and raw bulk records. Preserve relationship status,
  annotations, direction, inverse classifiers, source names, and raw records.
- Keep tagging-edge status and strength columns nullable because the bulk
  membership source does not expose those moderation fields.
- Preserve the bulk memberships as delivered. They include broader/inherited
  tags but do not label whether an individual membership was direct or
  inherited.
- Build in a resumable partial database, checkpoint completed pages, validate
  integrity, and atomically install only a complete result.
- Use an identifying user agent, bounded concurrency, a minimum request
  interval, bounded retries, and an age-based refresh window.
- Expose one read-only, Oracle-ID-keyed enrichment endpoint for highlighted-card
  presentation. Group the response into tags, similar cards, references, and
  inverse references.
- Load enrichment only after a card is selected. Do not enlarge the six-card
  search-page contract or read Tagger data during fuzzy or agentic ranking.

## Consequences

Positive:

- The complete enrichment dataset is available locally before ranking behavior
  is decided.
- Existing card search and catalog refreshes remain independent and unchanged;
  the detail panel pays the sidecar lookup cost only for the selected card.
- Raw source evidence is retained if normalization needs to change later.
- Failed or interrupted downloads neither corrupt the installed sidecar nor
  require every completed page to be downloaded again.

Costs and risks:

- The initial import still requires hundreds of paginated relationship reads.
- Neither the bulk tag endpoint nor GraphQL contract is documented as a public
  stable API. A Scryfall or Tagger change may require updating the provider.
- Tagger is community-maintained. Status and strength must be considered before
  using records for search or deck advice.
- Direct versus inherited tag membership cannot be reconstructed from the bulk
  payload alone.
- A resumed import assumes page ordering has not materially changed since the
  interrupted run. `npm run tagger:sync -- --force` starts a clean snapshot.

## Deferred Decisions

ADR 0012 now permits explicit immutable tag filtering and local related-card
navigation while retaining this ADR's acquisition and storage boundaries.

- Whether a future source for per-membership status and strength is valuable.
- Whether tag descriptions should enter embedding documents.
- Whether `SIMILAR_TO` should expand candidates or rerank them.
- Whether reference, comparison, and body relationships belong in gameplay
  discovery.
