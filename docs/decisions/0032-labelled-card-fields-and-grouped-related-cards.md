# ADR 0032: One Card, Labelled Fields — And Related Cards Grouped By How They Relate

- Status: Accepted
- Date: 2026-07-31

## Context

[ADR 0029](0029-read-only-deck-agent-tools.md) made `see_cards` the agent's only route
to what a card actually does, and its output is prompt text: whatever it renders is
what the model reasons from. Three things about that text were working against it.

A card opened with one run-on heading — `Ancient Den — Artifact Land  {1}` — leaving the
model to infer from punctuation where a name ended and a type began. Card names contain
commas and dashes of their own (`Ghalta, Primal Hunger`), so the punctuation is not a
reliable boundary.

`similar` reported six bare EDHREC names and nothing else, while the interface's card
panel had eight more related-card lists sitting in the same local Tagger sidecar
([ADR 0025](0025-surface-every-tagger-relationship-classifier.md)) — the upgrades, the
cards this one outclasses, the variants. The user could see them; the agent could not.

Details were rendered in whatever order the model happened to list them, so `similar`
could land above the rules text of the card it was similar to.

## Decision

### Every field is labelled and every free-text value quoted

```
Name: "Ghalta, Primal Hunger"
  Types: "Legendary", "Creature"
  Subtypes: "Elder Dinosaur"
  Mana cost: "{12}{G}"
  Mana value: 13
  Power/toughness: 12/12
  Rules: "Trample"
```

Only the left-hand side of a type line is split into separate values: card types and
supertypes are always single words, while a subtype need not be (`Time Lord`). A
double-faced type line holds two type lines joined by `//` and is reported as printed,
because splitting it would produce fields belonging to one face and attribute them to
the card.

### `similar` reports every related-card list, grouped by how the cards relate

```
  Similar:
    Similar cards: "Avacyn's Pilgrim", "Elvish Mystic", "Fyndhorn Elves", "Llanowar Tribe", "Arbor Elf", "Boreal Druid", "Birds of Paradise", "Elves of Deep Shadow"
    Outclasses: "Woodland Mystic"
```

The headings and their order mirror `relationshipGroups` in
`frontend/src/components/CardEnrichmentPanel.tsx`: what to play instead first, then the
shape variations, then the wording cross-references. The agent and the user must call the
same relationship by the same name, so that list is mirrored deliberately — change one
and change the other. `referenced_by` is reported by neither.

An upgrade is not a variant, so the grouping is the information; a flat list of names
would throw away the part worth reading. Empty groups print nothing, because Tagger
populates nine lists and most are empty for any one card.

### Each card is named once, under the group that says the most

The interface's separate **Similar on EDHREC** group is folded into `Similar cards` here.
The two lists overlap heavily — on Llanowar Elves, four Tagger names and six EDHREC names
are eight distinct cards — and a second mention of a card the agent has already read
teaches it nothing while costing tokens. Tagger's names keep their order and EDHREC's
additions follow; the catalog's spelling wins, since an EDHREC name the catalog could not
resolve is passed through as EDHREC spelled it.

A card named under a **more specific** relationship is then dropped from the merged list
entirely. `Outclasses`, `Upgrades`, `Variants`, `Creature versions` and `Spell versions`
all make a sharper claim about the same thing similarity claims — that you might play this
card instead — so reading `Woodland Mystic` under both `Outclasses` and `Similar cards`
would restate the weaker half.

`Related cards` and `References` are deliberately **not** in that set: a cross-reference is
a different axis, and a card can honestly be both similar to this one and named by its
rules text. Both fixtures pin that distinction, because it is a judgment rather than a
consequence of the data.

The two sources are independent, so one being unavailable must not cost the other: a
source that cannot answer contributes a note and the rest of the block still arrives.
Tags are deliberately *not* attached to these names — the question `similar` answers is
which cards are related, and `tags` already answers what a card does.

### The render order is fixed, and fixed in one place

`rules`, `legality`, `prices`, `tags`, `inclusion`, `similar` — the card's own printed
facts first, the related-card list last. The order is applied once, in `_see_cards`, so
the tool line the user sees and the body the model reads cannot disagree about it, and a
detail asked for twice is reported once.

A detail missing from that order would silently never be reported, so the order is
checked against `CardDetail` at import and raises rather than being left to review.

## Consequences

- `similar` now answers with up to eight groups instead of one list, from one extra local
  SQLite read per card. Measured on the real sidecars, Llanowar Elves and Command Tower
  with `rules` and `similar` came to 631 characters — the merge and the more-specific rule
  removed three of the ten names the two sources returned between them.
- Provenance is lost inside `Similar cards`: the agent can no longer tell Tagger's
  editorial claim from EDHREC's popularity signal. That is the cost of naming each card
  once, and the groups that carry a *specific* claim keep their own headings.
- An earlier draft of this decision attached each similar card's Tagger tags to its name.
  It was rejected on sight of the real data: tags average 15 per card and reach 106, so
  six suggestions turned one card's block into 2,500 characters of mostly non-signal
  (`naming scheme`, `virtual legendary`, `alliteration`, and near-duplicate families like
  `manarock` / `manarock cc` / `manarock ccc`). `tags` on a named card is the right way to
  ask that question.
- The unfiltered `tags` detail keeps that same noise for the one card asked about.
  `semantic.document.tags.excluded` already curates exactly these labels for the semantic
  index; whether `see_cards` should share that list is open, and deliberately not decided
  here.
- The block shape is pinned by an exact-string test, because it is a contract with the
  model rather than an implementation detail. Nothing asserted it before this ADR: the
  whole card format could be rewritten with the suite staying green.

## Verification

Rendered against the real catalog, Tagger sidecar and EDHREC cache, with details named
out of order. Llanowar Elves came back with one merged `Similar cards` group of eight
names — Elvish Mystic and Fyndhorn Elves were in both sources and appear once — above
`Outclasses`, and Command Tower, which Tagger records no relationships for, came back with
the merged group alone and no empty headings. No network fetch: both had cached snapshots.

Twenty planted mutants died, each killed by the test meant to kill it: relationships
dropped, `referenced_by` surfaced, empty groups printed, an EDHREC failure aborting the
whole block, a missing sidecar taking EDHREC with it, notes dropped so a gap goes silent,
the empty-everything fallback removed, the group order changed, the sources concatenated
without deduping, dedup made case-sensitive, EDHREC ordered ahead of Tagger, the
more-specific rule disabled, cross-references treated as more specific, the merge skipped
altogether, the old run-on heading, subtypes split on spaces, the double-faced guard
removed, details left in the order asked for, and the signature diverging from the body.

Two mutants **survived** first time round, and the two causes were different:

- The detail order was being applied twice — in `_see_cards` and again in `_card_block` —
  so no test could distinguish the second one. It was dead work, and removing it rather
  than testing it is why the order now has one home.
- Reordering the relationship groups changed nothing, because the test fixture populated
  no `upgrades`. The code was right and the fixture could not reach it; populating
  `upgrades` made the mutant die. A mutation only bites if the fixture holds data the
  mutated branch would mishandle.
