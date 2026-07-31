# ADR 0023: Name Similarity Ordering Instead of a Name Filter

- Status: Accepted
- Date: 2026-07-30
- Amends: [ADR 0021](0021-weighted-default-agent-ordering.md)

## Context

The agent tool exposed `name.query` as a hard filter: the normalized query had
to occur as a substring of a card title alias, and every other card was removed.
The prompt covered the obvious weakness by telling the model to correct spelling
before filtering, which only works for cards whose exact spelling the model
already knows.

Measured against the 33,264-card catalog, five of ten realistic attempts to name
a card returned **zero** candidates: `thassas oracle`, `kodamas reach`,
`atraxa praetor voice`, `sol ing`, and `galta`. The apostrophe cases are the
sharpest, because `normalize_card_title` renders "Thassa's Oracle" as
`thassa s oracle`, so a user typing `thassas` has no substring match at all.
Scoring the same queries with the existing `name_similarity_score` (RapidFuzz
`WRatio`) ranked the intended card first in nine of ten.

The score was already being computed for every candidate and then spent only as
the last tie-breaker, so it could never rescue a card the substring filter had
already deleted. This is the failure mode
[ADR 0019](0019-prompt-taught-agent-filters.md) named: a hard filter that
silently discards the wanted card.

Isolating a name is genuinely the agent's job rather than the earlier fuzzy
phase's. That phase scores the **whole** typed query against titles; only the
agent can pull `sol ing` out of "cheep mana rock called sol ing" and search on
just that. But isolating a fragment is worthless if matching it is exact.

## Decision

- Remove `name` and the `NameSearch` model from `LocalCardSearchRequest`.
- Add `name_sort`, a top-level string that mirrors `semantic_sort`, and
  `name_similarity` as a `sort_by` value.
- `name_sort` filters nothing. It orders candidates by fuzzy title similarity,
  with no threshold and no cap, so a misspelling can no longer empty a page.
- Require the pair: `name_similarity` without `name_sort` and `name_sort` under
  any other ordering are both schema errors. This prevents a silent no-op in one
  direction and a sort with nothing to sort by in the other.
- Keep name similarity out of the `weighted` blend. Naming a card is a different
  intent from describing one, and the agent chooses it deliberately.
- `name_similarity` orders by name score alone. Semantic closeness remains
  visible as candidate evidence for the final ranking call.
- Normalize the old shapes at the provider boundary: a bare `name` string or a
  `{"query": ...}` object becomes `name_sort` plus the matching ordering, and a
  `name_sort` sent without `sort_by` gets the ordering filled in.

## Boundaries

- Name similarity is not blended with any other signal, and there is no
  per-query weighting between a name and a description.
- The fuzzy phase that routes into the agent is unchanged.
- A short fragment with a wrong consonant can still rank poorly: `galta` puts
  Ghalta at rank 61, while `galta primal hunger` puts it first at 0.974. The
  prompt therefore still asks the model to correct a misspelling it recognizes,
  now as an improvement rather than a precondition.

## Consequences

An agent round that names a card can no longer return an empty page, and the
model no longer has to know a card's exact spelling for the field to work.

`name_sort` also stops being reachable as an accidental filter: the schema makes
it an ordering, so the "could a card the user wants fail this?" question in the
prompt's guidelines no longer applies to names at all.

The cost is that a deliberate partial-title browse is no longer exact. Asking
for `Urza` ranks the Urza cards first but keeps near-misses below them, where
before it returned only titles containing that string. Since the final ranking
model omits irrelevant candidates, a ranked list is the safer default than an
empty one.
