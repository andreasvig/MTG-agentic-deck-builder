# ADR 0009: Progressive One-Tool Agentic Card Search

- Status: Accepted
- Date: 2026-07-27
- Augments: ADR 0008

Implementation note: ADR 0010 replaces this record's reserved
`oracle_text.semantic_query` and disabled-capability behavior with always-on
top-level `semantic_sort`. The one-tool and filter-before-sort boundaries remain
active.

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
- On the first six-card page, show only candidates whose preview confidence is
  at least `0.75`. If fewer than six qualify, keep those cards visible while one
  agentic search runs.
- Run one bounded agent with memory only inside that search request.
- The agent must call exactly one tool: `search_local_cards`. Do not expose a
  live Scryfall-query tool to the agent.
- Give fuzzy previews stable temporary numeric IDs (`1`, `2`, `3`, and so on)
  and explicitly tell the agent that those cards are already visible to the
  user and remain selectable even if the tool does not return them. New tool
  cards receive later non-overlapping IDs. Preserve the existing ID when the
  exact same `oracle_id` appears in both sources.
- Render the model-facing user request as concise natural text. Do not serialize
  printing IDs, image URLs, provider URLs, legalities, or other provider-only
  fields into the prompt. Include ranking-relevant mana, type, power/toughness,
  Oracle text, and EUR price for every fuzzy preview.
- After the tool result, send the same agent a concise plain-text candidate
  list using only temporary numeric IDs and ranking-relevant card text. The
  final response contains an interpretation and the relevant IDs in best-first
  order. The agent may omit irrelevant candidates.
- Runtime code validates tool-call count, candidate membership, uniqueness,
  limits, and immutable UI filters. It does not require complete candidate
  coverage.
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
  gives the final ranker useful alternatives beyond the six-card display page.
- Preserve canonical symbols such as `{T}`, `{Q}`, and `{X}`. Classify X spells
  from mana cost rather than an X appearing in Oracle text.
- Persist power/toughness from the bulk card record and execute numeric
  power/toughness ranges inside `search_local_cards`.
- When debug mode is enabled, present exactly seven user-facing steps in order:
  system prompt, user input prompt, thinking, tool call, tool response, final
  thinking, and output response. Keep request envelopes, request context, and
  validation plumbing out of the inline presentation.
- Preserve full raw provider and tool JSON without truncation alongside the
  exact simplified tool message sent to the model. Redact secrets. “Provider
  reasoning” means fields actually returned by the provider; hidden internal
  chain-of-thought is not available and must not be represented as captured.
- When an agentic request fails in debug mode, return its sanitized partial
  trace in the typed error response. Keep all seven visible steps, mark the
  broken step as an error, mark later steps skipped, and open the failed step
  automatically in the drawer.
- Keep **Load more** visible after every search response. If another ranked
  batch is cached, return it without a model call. Once cached results are
  exhausted, the next user click authorizes exactly one new agent round.
- Carry every displayed card into continuation prompts under an
  **Already showing** section with its full ranking-relevant details. Previously
  displayed cards are not eligible for the continuation's final ranking.
- Exclude displayed and previously examined canonical `oracle_id` values inside
  the local tool before applying its candidate limit. This guarantees fresh
  candidates and prevents different printings of the same card from repeating.
- Preserve explicit per-round page batches so partial pages do not create
  offset gaps. Empty continuation rounds are successful and retryable.
- Retain each continuation's seven-step debug trace and serialize concurrent
  continuation requests per search session so replaying a page is idempotent.
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
- The final model sees readable numbered cards, can discard weak results, and
  may not invent IDs.
- Debugging has one stable seven-step presentation while the internal audit log
  retains execution and validation evidence.
- Contract work can ship without adding a model dependency, API key, or network
  behavior.

Costs:

- A semantic model and index still need to be selected and built.
- The progressive UI has two observable response phases.
- Repeated **Load more** clicks may incur additional model cost, but each click
  is bounded to one agent round and no continuation starts automatically.
- Complete debug traces can be large and require a retention policy.
- New cards and metadata require a catalog refresh before the agent can find
  them.
- The stricter confidence formula still needs a larger evaluation corpus.

## Implementation Status

The YAML settings, preview confidence, strict contracts, local tool, OpenRouter
orchestration, progressive endpoints, session pagination, complete trace
UI/persistence, and tests are implemented. Semantic embedding indexing remains
intentionally disabled.
