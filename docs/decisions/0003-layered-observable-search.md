# ADR 0003: Layered And Observable Card Search

- Status: Accepted
- Date: 2026-07-23

## Context

One search box must serve several user modes:

- Known card names.
- Misspellings.
- Broad Commander needs such as red card draw.
- Explicit Scryfall power-user syntax.

Sending every query to an LLM would add latency, cost, nondeterminism, and
unnecessary data transmission. Pure lexical search cannot explain broad intent.
The routing boundary needs real trace data before confidence thresholds can be
tuned.

## Decision

Use ordered layers:

1. Explicit Scryfall syntax.
2. Deterministic supported intent compilation.
3. Exact full-name gate plus genuine contained-name results.
4. Multi-result fuzzy catalog ranking.
5. Local embedding reranking for intent candidates.
6. Optional bounded OpenRouter reranking for intent candidates.

Additional rules:

- Exact, fuzzy, and syntax routes never invoke OpenRouter.
- Every route receives structured filters.
- Fuzzy candidates expose normalized scores.
- Low-confidence fuzzy routing records an intent-candidate signal.
- Optional ranker failure is non-fatal.
- Debug mode records full layer decisions, timing, ordering, and complete LLM
  bodies without credentials.
- The append-only JSONL trace and inline trace explorer are both supported.

## Consequences

Positive:

- Common deterministic searches are fast and cheap.
- Misspellings recover without an LLM.
- Intent ranking can improve independently from provider recall.
- Threshold decisions can use actual trace values.
- Provider and reranker failures remain diagnosable.

Costs:

- Routing behavior is more complex than one provider query.
- Supported intent phrases are currently hand-compiled.
- String similarity is not semantic confidence.
- Public debug traces are larger and require careful secret hygiene.
- The first fuzzy lookup is slower while the catalog loads.

## Guardrails

- A substring result does not count as exact unless a returned card or face
  fully equals the input. This prevents `foret` from stopping at `As Foretold`.
- Name regexes must be escaped.
- Contract changes must update backend, frontend validator, fixtures, and E2E.
- Search layers must include trace details and deterministic tests.

## Future Work

- Build a formal query and ranking evaluation corpus.
- Add general LLM query planning for unsupported intent.
- Add local indexed lexical and vector recall.
- Route low fuzzy confidence to the general intent planner.
- Expose a safe tuning surface after trace data suggests useful thresholds.
