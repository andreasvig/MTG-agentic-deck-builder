# Search Reranker Benchmark

Date: 2026-07-23

This is a dated benchmark record, not a guarantee of current model or provider
availability. For the active routing contract and runtime configuration, read
[`search.md`](search.md) and
[`ADR 0003`](decisions/0003-layered-observable-search.md).

## Method

The benchmark ran the complete natural-language search pipeline for:

> things which let me untap my elves

The local embedding model was warmed once. Each target then received the same
Scryfall candidate search and local semantic pass in round-robin order. The
table reports the median of three calls from the corrected run. Full local
results are written by `npm run benchmark:rerankers` to
`local-data/search-reranker-benchmark.json`; raw request and response traces go
to the adjacent JSONL file.

| Target | Reasoning | Successful | LLM median | Pipeline median |
| --- | --- | ---: | ---: | ---: |
| GPT-OSS-120B on Cerebras | low, 2,200-token cap | 3/3 | 0.875s | 3.710s |
| Mercury 2 | none | 3/3 | 1.139s | 3.402s |
| Gemma 4 31B on Cerebras | none | 1/3 | 1.338s | 3.727s |
| Gemini 3.5 Flash Lite | minimal | 3/3 | 1.774s | 4.393s |

## Findings

- GPT-OSS-120B was the fastest completed reranker once its completion cap was
  raised. At 900 tokens, low reasoning consumed the available output budget
  and truncated the answer.
- Mercury was fast, but one call in the initial round returned malformed JSON
  despite the structured-output request. Its top cards also varied more.
- Gemma produced a strong, stable ordering when it answered, but two calls in
  the corrected round received upstream Cerebras 429 responses. It completed
  all three calls in the initial round.
- Gemini Flash Lite was slower but completed all six calls across both rounds.
  Its top-five ordering was consistently focused on direct elf untap effects.

Gemini 3.5 Flash Lite remains the default because reliability and ranking
consistency matter more than saving roughly one second on an optional final
rerank. GPT-OSS and Gemma remain useful speed candidates after retry/fallback
handling and a broader quality evaluation are in place.

The tested model capabilities and provider availability came from
[OpenRouter model metadata](https://openrouter.ai/api/v1/models) and each
model's live endpoint list. Reasoning controls use OpenRouter's
[normalized reasoning API](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).
