# ADR 0017: Remove the Exact Oracle-Text Agent Filter

- Status: Accepted
- Date: 2026-07-30
- Amends: ADR 0010

## Context

The local agent tool exposed literal Oracle-text conditions alongside semantic
sorting. This allowed the model to convert a user's gameplay intent into
invented official wording. Because the field was a hard substring filter,
small templating differences could eliminate every useful candidate before
semantic ranking ran.

For example, an inferred sentence such as “whenever a creature enters the
battlefield, draw a card” excludes cards that satisfy the requested function
using different wording. The distinction between semantic intent and literal
rules text was also unnecessarily difficult to explain and debug.

## Decision

- Remove `oracle_text` from `LocalCardSearchRequest` and from the advertised
  `search_local_cards` tool schema.
- Reject provider tool calls that still send the removed field.
- Remove Oracle-text shorthand normalization and exact-filter execution.
- Keep card rules text in semantic-index documents. It remains important source
  material for semantic retrieval.
- Keep rules text in fuzzy-preview, commander, candidate, trace, and card-detail
  context where it helps the model and user understand a card.
- Express gameplay effects through `semantic_sort`; use deterministic fields
  only for explicit constraints such as type, color, mana, power, legality,
  price, set, rarity, and name.

## Consequences

Positive:

- Natural-language requests retain relevant cards despite Oracle templating
  differences.
- The agent can no longer invent a sentence that accidentally produces zero
  candidates.
- Filter-versus-ranking behavior is easier to explain.
- Rules text still contributes fully to semantic relevance.

Costs:

- The tool no longer guarantees that a literal phrase or symbol occurs in card
  rules text.
- The final ranking model must reject occasional semantic false positives.

## Rejected Alternatives

- Keep the field but improve the prompt: rejected because model compliance
  cannot make a brittle filter safe.
- Convert Oracle matching into another ranking boost: rejected because the
  semantic index already incorporates rules text.
- Keep the field for quoted user phrases only: rejected because it preserves a
  second, confusing rules-text retrieval path for a narrow use case.
