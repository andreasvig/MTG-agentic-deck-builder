# ADR 0019: Prompt-Taught Agent Filters

- Status: Accepted
- Date: 2026-07-30
- Supersedes: the query-explicit type/color guard in ADR 0018

## Context

ADR 0018 added a pre-execution guard that deleted the agent's `types` and
`colors` filters unless the user's typed query named them. The predicate
required the type word to appear literally in the query, then vetoed it when an
adjacent word came from one of two hand-written lists (13 preceding words such
as `control` and `target`, 13 following words such as `enters` and `tribal`).

Measured against the shipped predicate, that proxy failed in both directions.
Ordinary Commander vernacular became un-filterable, because players do not say
the printed type:

| Query | Agent filter | Guard verdict |
| --- | --- | --- |
| `efficient removal spells` | Instant | deleted |
| `cheap mana rocks` | Artifact | deleted |
| `best ramp for my deck` | Land | deleted |
| `board wipes` | Sorcery | deleted |
| `elf tribal payoffs` | Elf | deleted |
| `creatures that draw cards` | Creature | kept |

The `elf tribal payoffs` row deleted a filter that the agent's own prompt
teaches by worked example, and `creatures that draw cards` survived only
because `that` is absent from the veto list. Behavior depended on which of 26
hand-picked English words sat next to the type word, so every new phrasing
needed another list entry and another test.

The deeper error was the choice of invariant. The property worth protecting is
that a hard filter must not silently discard cards the user wants. The guard
instead enforced lexical presence in the query, which is neither necessary nor
sufficient for that property.

ADR 0018 rejected prompt guidance because the prompt was "already clear and the
model still inferred constraints." That prompt taught the same lexical rule the
code enforced — add a type "only when the user's typed request names it" — so
it never gave the model the domain distinction it needed.

## Decision

- Delete `_apply_agent_filter_guardrails` and its `_query_requests_type_filter`,
  `_query_requests_color_filter`, and `_type_phrase_variants` helpers. Validated
  agent `types` and `colors` reach the local tool unmodified.
- Teach the distinction in the system prompt instead, as Magic domain knowledge
  rather than a lexical test:
  - Functional categories (removal, ramp, sweepers, draw, tutors, protection,
    recursion, stax, payoffs) span several printed types and stay in
    `semantic_sort`.
  - Definitional and typal terms (mana rock is an Artifact, elves are Elf,
    sagas are Saga) name a printed type and justify a filter.
  - Filter on a printed type only when every acceptable answer must print it.
  - A type naming an effect's subject is not a result filter: "creatures that
    draw cards" may filter Creature, "draw when creatures enter" may not.
- State the stakes in the prompt: nothing downstream relaxes the agent's
  filters, and there is one tool call, so an unjustified filter costs more than
  an absent one.
- Keep the separate provider-boundary normalizations in
  `_normalize_tool_arguments`. Those repair schema shape rather than second-guess
  intent: decoding JSON-encoded nested objects, expanding comma-joined type
  strings, normalizing compact color identities, dropping `"..."` placeholders,
  and discarding stale runtime-owned `format`/`legality` keys.

Legality stripping stays in code because the non-legal exception switch makes a
re-added legality filter override an explicit user choice. That is a genuine
invariant with no ambiguous cases, unlike type intent.

## Consequences

Positive:

- Vernacular queries keep correct type filters, and no keyword list needs
  maintenance as phrasing changes.
- The agent surface is simpler: one prompt, one tool call, no post-validation
  rewriting of the model's arguments.
- Traces show the agent's real request, so a bad filter is visible as the
  agent's decision instead of being masked by a silent repair.

Costs:

- A wrong hard filter now reaches execution and can under-fill or empty a page.
  Nothing corrects it within the round; the user's next **Load more** starts a
  continuation round that is told to broaden.
- Filter quality becomes prompt-quality, which is model-dependent and not
  pinned by unit tests. There is no query evaluation corpus yet, so this change
  is verified by contract tests and trace reads, not by a measured score.

## Rejected Alternatives

- Consequence-based enforcement: drop the type filter and re-run locally when it
  yields too few results. Keeps a deterministic backstop and needs no keyword
  lists, but adds a second execution path and re-introduces runtime rewriting of
  the agent's request.
- A required per-type justification field. Rejected as agent complexity that
  makes the model argue for filters rather than judge them.
- Asymmetric enforcement: soft `must_contain_any`, hard `must_contain_all`.
  Rejected because it keeps the lexical predicate for the common case.
