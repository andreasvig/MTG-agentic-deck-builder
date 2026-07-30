# ADR 0014: Title-Resistant, Tagger-Enriched Semantic Documents

- Status: Accepted
- Date: 2026-07-29
- Amends: ADR 0010
- Supersedes: ADR 0011 and ADR 0012 only where they excluded Tagger concepts
  from semantic documents

## Context

The first semantic template embedded card names, mana cost, type line, Oracle
text, power/toughness, and card-face details. It provided a useful local
baseline, but arbitrary title words could bias gameplay searches. The
separately acquired Tagger sidecar now provides human concepts such as `mana
rock`, `painland`, `leaves body behind`, and `overrun` that bridge informal user
language to literal card rules.

The raw Tagger memberships cannot be concatenated without controls:

- cards average roughly 15 tags and some have more than 100;
- broad, duplicate, naming, cycle, errata, and flavor labels are present;
- the bulk membership source does not expose per-membership status or strength;
- only a minority of tag definitions have descriptions;
- exact card relationships have different semantics from descriptive tags.

## Decision

- Adopt deterministic semantic document template version 2.
- Exclude card and face names by default. Fuzzy title search and the structured
  name filter remain responsible for named-card retrieval.
- Normalize a card's self-references to `this card`.
- Explain `{T}`, `{Q}`, and `{X}` alongside their original symbols.
- Render multi-face gameplay data once rather than repeating combined and
  face-specific fields.
- Embed configured mana cost/value, type, Oracle text, power/toughness, and
  face-specific data.
- When a Tagger sidecar exists, add a `Gameplay concepts` section selected from
  Oracle-card memberships.
- Make Tagger concept selection deterministic and configurable:
  - enforce minimum and maximum membership frequency;
  - exclude configured metadata/flavor phrases;
  - collapse tags with identical Oracle-card membership sets;
  - normalize configured Tagger jargon;
  - remove a generic concept when a longer selected concept contains it;
  - prefer more specific memberships and cap concepts per card;
  - omit descriptions by default.
- Keep exact Tagger card relationships outside embedding documents and semantic
  scoring. They remain available as a separate inspectable graph.
- Couple semantic-index metadata to the complete document configuration, exact
  card catalog, Tagger snapshot, model, and template version.
- Permit a rules-only v2 index when the optional Tagger sidecar is absent.
  Installing or refreshing Tagger data makes that index stale.
- Make both `catalog:sync` and `tagger:sync` check and atomically rebuild the
  semantic sidecar when their dependencies change.

## Consequences

Positive:

- Natural-language gameplay roles can match community vocabulary even when the
  words are absent from Oracle text.
- Card-title words no longer distort semantic gameplay ranking.
- Documents are bounded, reproducible, locally inspectable, and free of
  provider-generated summaries.
- Exact relationships retain their direction and provenance instead of being
  blurred into dense text.
- Search cannot silently use vectors from an older Tagger snapshot or document
  configuration.

Costs and risks:

- A Tagger refresh now requires a local embedding rebuild.
- Tagger concepts remain community-maintained and can contain imperfect
  classifications despite deterministic pruning.
- The configuration includes an explicit exclusion and alias vocabulary that
  should be evaluated as Tagger evolves.
- Similar-card queries do not yet expand through the exact relationship graph.

## Rejected Alternatives

- Embed every tag and description: rejected because document length and noisy
  metadata would dominate literal gameplay text.
- Embed similar/reference card names: rejected because graph relationships are
  more precise and explainable outside dense text.
- Generate one LLM summary per card: rejected because it adds cost,
  nondeterminism, hallucination risk, and opaque invalidation.
- Store multiple weighted vectors immediately: deferred until a benchmark shows
  that one bounded document cannot balance literal rules and gameplay concepts.
