# ADR 0012: Commander And Tagger Filters Are Immutable Interface Constraints

- Status: Accepted
- Date: 2026-07-29

ADR 0014 supersedes this record's prohibition on Tagger concepts in semantic
documents. Explicit selected tags remain immutable hard filters, while bounded
Tagger concept names now separately enrich semantic document v2.

## Context

Card discovery should be safe for the deck being edited without forcing the
search agent to infer format legality or the commander's color identity.
Users also need a direct way to browse Scryfall Tagger concepts without first
changing semantic documents or deciding that community tags should influence
relevance ranking.

The existing Tagger sidecar already stores stable tag IDs, normalized names,
Oracle-card memberships, and relationships. ADR 0011 intentionally kept this
data out of search until a specific product behavior was chosen.

## Decision

- Search excludes cards that are not Commander legal by default.
- When the deck has one or more known command-zone cards, search excludes cards
  outside their combined color identity by default. A known empty identity is
  preserved as colorless rather than treated as no commander.
- Two independent, unchecked interface switches may include non-Commander-legal
  cards or cards outside the commander identity.
- The UI may fuzzy-search local Tagger names and select multiple tag IDs. A card
  must carry every selected tag.
- The backend resolves selected IDs to canonical tag names and applies their
  Oracle-ID intersection before fuzzy paging or semantic sorting.
- Commander restrictions and selected tags are passed to every agentic and
  continuation request as immutable interface constraints. They are described
  in the agent user prompt but are absent from the model-editable local-tool
  schema.
- Clicking a tag in either card-detail surface starts a tag-only search.
- Clicking a related card resolves the canonical local printing and opens the
  normal card dialog. An underlying search remains mounted and unchanged.
- At this decision's adoption, tag text, descriptions, and relationships did
  not enter embedding documents or ranking, so its semantic sidecar remained
  valid. ADR 0014 later supersedes that boundary for bounded tag names only.
- Runtime search never calls the Scryfall Tagger network. Explicit tag filters
  read only the sidecar installed by `npm run tagger:sync`.

## Consequences

Positive:

- Normal discovery defaults to cards that can be played in the current deck.
- Users can deliberately widen either legality boundary without coupling the
  two exceptions.
- Tag filtering is deterministic, inspectable, and stable across agent rounds.
- Related-card exploration does not destroy typed queries or ranked results.
- The feature uses the acquired Tagger data without prematurely making it a
  relevance or embedding signal.

Costs:

- Tag-filtered search and enrichment require the optional Tagger sidecar.
- Multiple selected tags use intersection semantics and can legitimately
  produce an empty result.
- The frontend and HTTP contract must distinguish no known commander from a
  known colorless commander.

## Deferred

- Tag-weighted ranking or candidate expansion.
- Tag descriptions or relationships in semantic embedding documents.
- Direct versus inherited membership controls.
- User-facing inclusion/exclusion modes beyond the current required-tag
  intersection.
