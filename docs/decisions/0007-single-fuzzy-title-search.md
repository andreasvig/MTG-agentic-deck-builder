# ADR 0007: One Fuzzy Card-Title Search Path

- Status: Accepted
- Date: 2026-07-27

Implementation note: ADR 0008 supersedes this record's live Scryfall
title-fetch and continuation mechanism. The single threshold-free fuzzy scoring
decision remains active.
- Supersedes: ADR 0003

## Context

The layered search combined explicit Scryfall syntax, deterministic intent
compilation, exact/contained names, fuzzy names, local embeddings, and optional
LLM reranking. This made the first retrieval step difficult to understand and
tune before basic title matching had been established.

The desired initial behavior is narrower:

- Every input starts as a fuzzy card-title query.
- Exact titles appear first.
- Partial words, title segments, and typos follow in score order.
- Matching values remain visible for inspection.

## Decision

- Use one active search strategy: fuzzy card-title matching.
- Cache Scryfall's card-name catalog per backend process.
- Match normalized full titles, card faces, and before-comma aliases.
- Score with RapidFuzz `WRatio` on a normalized `0..1` scale.
- Rank the complete cached title catalog without a score threshold or
  candidate cap.
- Evaluate an initial 12-title batch, then consume only enough later ranks to
  replace titles rejected by paper/card filters.
- Return the next unconsumed candidate offset so **Load more** can continue
  without re-fetching or skipping ranks.
- Store the page size in root `config.yaml`.
- Fetch the current ranked page through exact Scryfall name expressions with
  `game:paper` and the existing structured filters.
- Return exact titles first and the remaining titles in score order.
- Expose `Fuzzy match N%` beneath each result when debug mode is enabled.
- Preserve the append-only one-stage debug trace.
- Remove active intent compilation, Scryfall-syntax routing, embeddings,
  OpenRouter reranking, and reranker benchmarking.

## Consequences

Positive:

- Search behavior has one explainable control flow.
- No title is silently discarded by a score threshold or candidate-pool cap.
- The display-page size remains a YAML-owned product value; it is now six cards
  per page.
- Exact, typo, word, and segment matches share one scale.
- Search no longer needs model downloads, API keys, prompts, or model-specific
  failure handling.
- Debug output directly explains the current page's score and filter outcome.

Costs:

- Natural-language deck-building intent is not supported.
- Direct Scryfall syntax is not supported by the main search box.
- The first query still downloads the Scryfall title catalog.
- RapidFuzz scores are heuristics, not intent probabilities.
- Filter-heavy searches may require several small Scryfall requests to fill a
  display page.

## Reintroduction Rule

Semantic retrieval, intent planning, or another search route requires a new
product decision. It must augment a measured weakness in this title matcher,
not silently recreate the superseded pipeline. A later fuzzy-to-semantic
routing score must be evaluated as a phase boundary, not added as a minimum
score that discards current fuzzy results.
