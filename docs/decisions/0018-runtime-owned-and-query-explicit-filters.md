# ADR 0018: Runtime-Owned And Query-Explicit Agent Filters

- Status: Partly superseded by ADR 0019
- Date: 2026-07-30
- Amends: ADR 0012 and ADR 0017

> The runtime-owned `format`/`legality` removal below remains in force.
> The query-explicit type and color guard was removed by
> [ADR 0019](0019-prompt-taught-agent-filters.md): its lexical predicate
> deleted correct filters for ordinary Commander vernacular such as "mana
> rocks" and "elf tribal". Type and color intent is now taught in the system
> prompt instead.

## Context

The agent user prompt lists Commander legality, deck identity, and selected
interface filters so the model understands the eligible card pool. The model
frequently copied those values into its local-tool call even though the runtime
had already applied them. This made traces noisy and could incorrectly restore
a restriction after the user enabled an exception.

The model also inferred `types: Creature` from gameplay intent. A request such
as “late-game card draw” or “draw whenever creatures enter” should consider
enchantments, artifacts, planeswalkers, and other engines, but an inferred hard
type filter removed them before semantic ranking.

## Decision

- Remove `format` and `legality` from `LocalCardSearchRequest`. Commander
  legality and the non-legal exception switch belong exclusively to
  `CardSearchFilters`.
- Discard stale provider-supplied `format` and `legality` values before strict
  validation and record those removals in the trace.
- Keep agent `types` and `colors` for genuinely query-specific restrictions.
- Before execution, remove agent colors unless the user's typed query itself
  names a color. Commander identity and interface color context do not qualify.
- Before execution, keep an agent type or subtype only when the original typed
  query names it as a property of the desired result cards.
- Remove agent type/subtype values already present in immutable interface
  filters.
- Treat types mentioned as effect subjects or context—such as creatures
  entering, dying, being controlled, or receiving an effect—as semantic intent,
  not automatically as result-type restrictions.
- Show only the guarded, validated arguments in the readable trace. Preserve
  the untouched provider response in the secret-redacted raw audit record.

## Consequences

Positive:

- Interface state has one authority and cannot be silently overridden by the
  agent.
- Broad functional searches retain noncreature candidates.
- Tool traces contain only constraints that affect execution.
- Explicit requests such as “green creatures” and “instant or sorcery card
  draw” can still use deterministic hard filters.

Costs:

- The conservative type-language guard can discard an intended hard type in an
  ambiguous sentence. Semantic ranking and final candidate omission still
  preserve useful type intent in that case.
- Query-explicit detection has a small deterministic vocabulary and requires
  tests when new phrasing is supported.

## Rejected Alternatives

- Prompt guidance only: rejected because the existing prompt was already clear
  and the model still copied or inferred constraints.
- Remove `types` and `colors` entirely: rejected because explicit result
  restrictions are useful and testable.
- Trust duplicated constraints because they often produce the same result:
  rejected because exception switches make duplication behaviorally unsafe.
