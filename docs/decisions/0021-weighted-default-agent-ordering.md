# ADR 0021: Weighted Default Agent Ordering

Status: Accepted

Date: 2026-07-30

Refines: [ADR 0016](0016-commander-theme-evidence-in-agentic-search.md)

## Context

[ADR 0016](0016-commander-theme-evidence-in-agentic-search.md) gave the agent
three primary orderings and made `semantic` the default when `sort_by` is
omitted. Each of the three uses exactly one signal as its primary key, so the
other signal only ever breaks ties. In practice inclusion and synergy are
distinct floats, so an EDHREC ordering makes `semantic_sort` decorative, and
`semantic` ignores commander fit entirely. The agent had no way to ask for
"a good card for this deck that also matches what the user described" without
picking one signal and discarding the other.

Semantic closeness is also weaker than it looks. The document embedding is a
`bge-small-en-v1.5` bi-encoder over rules text, type line, mana cost, and
Tagger concepts, so it captures what a card *does* but reasons poorly about
comparatives such as cheap, big, or best. Blending a second, independent signal
into the order is worth more here than tuning the description.

## Decision

- Add a fourth primary ordering, `weighted`, and make it the default the agent
  gets when it omits `sort_by`. `DEFAULT_AGENT_SORT` is the single source of
  that default.
- `weighted` orders by a weighted average of two natively `0-1` scores: semantic
  closeness and EDHREC commander inclusion. Weights live in
  `search.agentic.ranking.weighted` in `config.yaml`; only their ratio matters.
- Renormalize the weights over the signals **the run** has, not the signals a
  card has. With no `semantic_sort`, `weighted` orders by inclusion alone; with
  no commander or failed EDHREC, it orders exactly like `semantic`. Per-card
  renormalization is wrong because it would reward a card the commander's page
  omits over one it lists with a low score.
- Within the blend, a card the commander's EDHREC page does not list contributes
  zero inclusion. It is demoted relative to a listed card, never removed.
- `weighted` never requires commander evidence. Only `edhrec_inclusion` and
  `edhrec_synergy` still raise `AgentSearchContractError` without a ranking.
- Record the configured and applied weights in the tool's `compiled_query`, and
  add the resulting score to each candidate's match evidence.

## Boundaries

- Synergy stays out of the blend. It is a signed delta against a general
  baseline rather than a `0-1` rate, so mixing it in needs a normalization
  choice this ADR does not make. `edhrec_synergy` remains available as an
  explicit ordering.
- The weights are global, not per query. There is no learned or query-dependent
  weighting.
- Nothing here changes what is filtered. `weighted` reorders survivors only.

## Consequences

The agent's default ordering now reflects both what the user described and how
the commander's decks actually play, and it degrades to the previous `semantic`
behaviour whenever EDHREC evidence is missing, which is every commanderless
search.

This refines one line of ADR 0016. "Absence means 'not listed,' not zero" still
holds for **evidence**: `edhrec_inclusion` stays `None` on the candidate and the
tool message still reports `not listed for the selected commander/theme`. It no
longer holds inside the `weighted` **ordering**, where absence has to score as
something and scoring it zero is what makes commander fit influence the order at
all. Because EDHREC coverage of the catalog is partial, this means an unlisted
card competes on its semantic half alone — deliberate, and the reason the
weights are exposed in `config.yaml` rather than hard-coded.
