# ADR 0025: Surface Every Tagger Relationship Classifier

- Status: Accepted
- Date: 2026-07-31
- Amends: [ADR 0011](0011-tagger-enrichment-sidecar.md)

## Context

`tagger:sync` stores every relationship edge Tagger publishes for an Oracle card,
and [ADR 0011](0011-tagger-enrichment-sidecar.md) anticipated that these values
"may later improve semantic documents, candidate selection, or the interface".

The reader never got that far. It grouped `SIMILAR_TO` and the two `REFERENCES`
directions and dropped everything else on the floor. Measured against the
installed sidecar, that silently discarded **10,214 of 18,421 stored edges — 55%**:

| Classifier | Edges | Was surfaced |
| --- | --- | --- |
| `SIMILAR_TO` | 5,581 | yes |
| `WORSE_THAN` | 4,784 | **no** |
| `BETTER_THAN` | 4,201 | **no** |
| `REFERENCES_TO` | 2,119 | yes |
| `REFERENCED_BY` | 507 | yes (stored, not rendered) |
| `MIRRORS` | 377 | **no** |
| `COLORSHIFTED` | 364 | **no** |
| `WITH_BODY` | 357 | **no** |
| `WITHOUT_BODY` | 111 | **no** |
| `RELATED_TO` | 20 | **no** |

The 8,985 strictness edges are the most directly useful of the set for deck
building: they answer "what should I play instead of this", which is the whole
question a card inspector exists to support. They were already synced, indexed by
classifier, and paid for.

The old code also read direction inconsistently. `SIMILAR_TO` was treated as
symmetric, `REFERENCES_TO` was inverted by a hard-coded branch, and anything else
fell through to a `continue`.

## Decision

Group every classifier through one table keyed by the relationship **as it reads
from the highlighted card towards the listed one**, after normalizing direction.
Tagger states each asymmetric relationship from its stronger or embodied side, so
the listed card's role is the inverse of the classifier when the highlighted card
is the edge's `related` rather than its `subject`.

| Direction | `CardEnrichment` field | Interface heading |
| --- | --- | --- |
| `WORSE_THAN` | `upgrades` | Upgrades |
| `BETTER_THAN` | `downgrades` | Outclasses |
| `SIMILAR_TO` | `similar_cards` | Similar cards |
| `WITHOUT_BODY` | `creature_versions` | Creature versions |
| `WITH_BODY` | `spell_versions` | Spell versions |
| `MIRRORS`, `COLORSHIFTED` | `variants` | Variants |
| `RELATED_TO` | `related_cards` | Related cards |
| `REFERENCES_TO` | `references` | References |
| `REFERENCED_BY` | `referenced_by` | not rendered |

`referenced_by` stays out of the interface, which is the existing deliberate
choice recorded in `docs/search.md` and the changelog; this ADR does not revisit
it.

**Inversion comes from a local table, not from the feed.** Tagger publishes a
`classifierInverse` on every edge and the installed sidecar agrees with the
pairings above for all ten classifiers, but a wrong value there would silently
show a card's upgrades as its downgrades — the one failure mode that looks
plausible and is completely wrong. The published inverse is consulted only for a
classifier the table does not know, which the grouping table then ignores anyway.

A classifier absent from the grouping table is skipped rather than guessed at.

## Consequences

- Nothing is re-synced or re-embedded. This is a read-path change over rows that
  were already stored; the sidecar and its schema are untouched.
- The enrichment response gains six lists, so a client that pins the response
  shape has to be updated. The frontend guard requires all of them.
- Relationships remain out of semantic documents, unchanged from
  [ADR 0014](0014-title-resistant-tagger-enriched-semantic-documents.md): the
  agent still cannot search by similarity, and nothing here changes ranking.
- Direction is verified in both directions by tests, because reading one of these
  lists backwards is invisible in any single-sided assertion. A worked pair:
  `Entomb → creature_versions: Vile Entomber` and
  `Vile Entomber → spell_versions: Entomb`.
