# ADR 0022: Remove the Set and Rarity Agent Filters

- Status: Accepted
- Date: 2026-07-30
- Amends: [ADR 0017](0017-remove-exact-oracle-text-filter.md)

## Context

The local agent tool exposed `sets` and `rarities` as hard filters over exact
set codes and rarity names. Both describe a *printing*, not gameplay identity,
and Commander deck-building questions are almost never about either. Neither
field had a test, and neither appeared in a prompt example.

They carried the same failure mode ADR 0017 removed for Oracle text: a filter
the model can invent from a word in the query. A set code has to be recalled
from memory, so "modern cards" or a set name the model half-remembers becomes a
code that silently empties the page. Rarity invites the reverse error — reading
"best" or "powerful" as `mythic`, which deletes the many commons and uncommons
that are Commander staples. Every field the prompt has to *warn* against is a
field the tool should not offer.

The catalog also stores one selected printing per Oracle card, so a set filter
searches only that printing rather than the card's real availability, which
makes an apparently precise filter quietly wrong.

## Decision

- Remove `sets` and `rarities` from `LocalCardSearchRequest` and from the
  advertised `search_local_cards` tool schema.
- Reject provider tool calls that still send either field, as with `oracle_text`.
- Remove their filter execution and their string-to-list boundary normalization.
- Remove both from the system prompt's `## Filter fields`.
- Keep `set_code`, `set_name`, `collector_number`, and `rarity` on cards. They
  stay in card details, the inspector, and search results, where they help the
  user identify a printing.
- Pin the model-facing schema: a test asserts the exact set of tool properties,
  so no field is re-added or removed without the contract changing on purpose.

## Consequences

Positive:

- One less way for the model to invent a constraint that returns nothing.
- The tool now offers only gameplay-identity conditions plus price, matching how
  the prompt teaches Commander search.
- The prompt loses two bullets that existed mainly to caution against use.

Costs:

- The agent cannot restrict a search to a set or rarity. A user who genuinely
  wants that must use interface filters, which are the authoritative place for
  printing-level choices.
- Reprint-era questions such as "cards from the newest set" now depend on
  semantic evidence, which does not encode release date.

## Rejected Alternatives

- Keep the fields and warn harder in the prompt: rejected for the same reason as
  ADR 0017 — model compliance cannot make an invented hard filter safe.
- Convert them into ranking signals: rejected because neither predicts whether a
  card answers a gameplay request.
- Expose set filtering over all printings instead of the selected one: rejected
  as catalog work with no demonstrated Commander use case.
