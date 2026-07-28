# ADR 0009: Progressive One-Tool Agentic Card Search

- Status: Accepted
- Date: 2026-07-27
- Augments: ADR 0008

## Context

The local threshold-free title matcher has excellent recall for exact names,
partial title segments, and misspellings. It does not understand requests such
as “cheap blue card draw” or “creatures that untap elves.” RapidFuzz `WRatio`
cannot itself route those cases because token shortcuts can give unrelated card
titles scores above 75%.

The next search phase must preserve immediate useful title matches without
recreating the former multi-router, multi-reranker pipeline. It must also be
fully observable in debug mode.

## Decision

- Keep the complete local WRatio ranking threshold-free and uncapped.
- Add a separate `preview_confidence` used only at the phase boundary:
  - if the complete normalized query occurs in a title alias, retain its WRatio;
  - otherwise use whole-string RapidFuzz edit similarity without token
    shortcuts.
- On the first 12-card page, show only candidates whose preview confidence is
  at least `0.75`. If fewer than 12 qualify, keep those cards visible while one
  agentic search runs.
- Run one bounded agent with memory only inside that search request.
- The agent must call exactly one tool: `search_local_cards` or
  `search_scryfall`. Prefer the local tool; use live Scryfall only for a
  requirement that the local schema cannot represent or when fresh provider
  data is explicitly required.
- After the tool result, the same agent run must return an interpretation and a
  ranking containing every ID in the deduplicated preview/tool candidate union.
  Runtime code validates tool-call count, candidate membership, completeness,
  uniqueness, limits, and immutable UI filters.
- Put semantic retrieval inside `search_local_cards`, under
  `oracle_text.semantic_query`. Hard filters narrow candidates before semantic
  similarity sorts them.
- Make every local-tool category and field optional. A request with no agent
  criteria is valid only when immutable UI filters provide meaningful
  constraints.
- Merge mana value and mana-cost symbols under `mana`.
- Give `must_contain_all` multiset semantics. Duplicate values are meaningful:
  `["{X}", "{X}"]` requires two `{X}` symbols.
- Default the local tool to 24 candidates and cap it at 60. The 24-card default
  gives the final ranker useful alternatives beyond the 12-card display page.
- Preserve canonical symbols such as `{T}`, `{Q}`, and `{X}`. Classify X spells
  from mana cost rather than an X appearing in Oracle text.
- When debug mode is enabled, return and persist a versioned, complete
  observable trace with these stages in order:
  `request_context`, `initial_model_request`, `initial_model_response`,
  `tool_call`, `tool_result`, `final_model_request`, `final_model_response`,
  and `validation`.
- Preserve full raw provider and tool JSON without truncation. Redact secrets.
  “Provider reasoning” means fields actually returned by the provider; hidden
  internal chain-of-thought is not available and must not be represented as
  captured.
- Enable agentic execution only after model calls, progressive API behavior,
  tool execution, session pagination, and tests land. Keep semantic embeddings
  independently disabled until a real index is implemented.

## Consequences

Positive:

- Exact, partial, and typo title searches can remain fast and deterministic.
- Natural-language intent gets a single understandable fallback rather than a
  layered routing graph.
- Semantic retrieval and structured filters can work together in one local
  tool.
- The final model can rank concrete card payloads and may not invent IDs.
- Debugging has one stable trace schema from request through validation.
- Contract work can ship without adding a model dependency, API key, or network
  behavior.

Costs:

- A semantic model and index still need to be selected and built.
- The progressive UI has two observable response phases.
- Complete debug traces can be large and require a retention policy.
- Live Scryfall fallback adds network latency and requires provider pacing.
- The stricter confidence formula still needs a larger evaluation corpus.

## Implementation Status

The YAML settings, preview confidence, strict contracts, local and live
Scryfall tools, OpenRouter orchestration, progressive endpoints, session
pagination, complete trace UI/persistence, and tests are implemented. Semantic
embedding indexing remains intentionally disabled.
