# Search System

This document is the technical contract for card discovery.

## Goals

- Resolve known card names and useful partial matches quickly.
- Recover plausible misspellings without invoking an LLM.
- Support explicit Scryfall power-user syntax.
- Handle common Commander intent deterministically.
- Apply the same structured filters to every route.
- Keep optional AI ranking observable and non-fatal.
- Expose enough score data to tune the boundary between name and intent search.

## Public Endpoint

```http
GET /api/v1/cards/search
```

Query parameters:

| Parameter | Type | Purpose |
| --- | --- | --- |
| `q` | string | Name, natural intent, or Scryfall expression |
| `page` | integer | Provider page, default `1` |
| `color` | repeatable W/U/B/R/G | Allowed or exact identities |
| `include_colorless` | boolean | Include exact colorless identity |
| `color_mode` | `subset` or `exact` | Identity comparison mode |
| `mana_min`, `mana_max` | number | Mana-value range |
| `price_min`, `price_max` | decimal | Scryfall EUR range |
| `debug` | boolean | Return and persist a full trace |

## Route Order

```text
query
  |
  +-- explicit Scryfall syntax? --> syntax search
  |
  +-- supported deterministic intent? --> intent candidates and ranking
  |
  +-- contained-name lookup
        |
        +-- at least one full exact name? --> all contained names, score sorted
        |
        +-- no full exact name --> fuzzy catalog candidates
                                      |
                                      +-- score >= cutoff --> fetch
                                      +-- score < cutoff --> trace only
```

The exact-name gate matters. `foret` happens to be contained in names such as
`As Foretold`, but it does not exactly name a card. It therefore continues to
fuzzy ranking and can recover `Forest`.

## Explicit Scryfall Syntax

`_is_scryfall_syntax` recognizes field operators, comparisons, boolean
operators, parentheses, and bang exact-name syntax.

Behavior:

- Preserve the supplied expression.
- Append structured UI filters.
- Do not add `game:paper` automatically to arbitrary user syntax.
- Do not run embeddings or OpenRouter.
- Return strategy `syntax`.

## Deterministic Intent

`compile_intent` handles currently supported language:

- Ramp and mana acceleration.
- Card draw and card advantage.
- Game enders and finishers.
- Untap effects.
- +1/+1 counter multiplication.
- Common card types.
- Cheap/low-cost qualifiers.
- White, blue, black, red, green, and colorless identity phrases.

Examples:

```text
blue/colorless ramp
red card draw
cheap dinosaurs
game enders
things which let me untap my elves
doubling +1 +1
```

The compiler creates a broad Scryfall query, adds `game:paper`, adds UI filters,
and requests EDHREC order.

Ranking:

1. Scryfall EDHREC candidate order.
2. Local FastEmbed cosine similarity when configured.
3. Optional bounded OpenRouter rerank when a key is configured.

Ranking failure is non-fatal. The response contains a warning and keeps the
best available prior ordering.

## Exact And Contained Names

The provider query uses an escaped Scryfall name regex:

```text
name:/forest/ game:paper
```

The regex avoids Scryfall phrase aliases that can match oracle text instead of
the printed name.

If any returned card or face equals the query case-insensitively:

- Strategy is `exact`.
- Every genuine name containing the text is returned.
- Results are sorted by normalized similarity, then name.
- A full exact card appears before weaker containing matches.
- `name_match_scores` maps each returned `scryfall_id` to its score.

Example `forest`:

```text
Forest                    1.000
Forestfolk                0.750
Forest Bear               0.706
Misty Rainforest          0.545
Snow-Covered Forest       0.480
```

The exact layer may return reversible or multi-face names separately when
Scryfall treats them as distinct gameplay cards.

## Fuzzy Names

When no full exact name exists:

1. Load `/catalog/card-names` once per backend process.
2. Build aliases for full names, faces, and the text before a comma.
3. Collapse repeated reversible names such as `Forest // Forest` to one
   canonical catalog candidate.
4. Normalize query and alias to lowercase ASCII alphanumeric words.
5. Score with Python `difflib.SequenceMatcher.ratio()`.
6. Sort by score, length distance, then case-insensitive card name.
7. Retain the configured candidate count for tracing.
8. Fetch candidates at or above the configured cutoff in one Scryfall query.
9. Add `game:paper` and structured filters.

Score properties:

- Range is `0..1`.
- `1.0` means the normalized strings are identical.
- The score is a name-routing diagnostic, not semantic relevance.
- Multiple cards may share a score through the same alias.

Default configuration:

```dotenv
MTG_FUZZY_NAME_CANDIDATE_LIMIT=12
MTG_FUZZY_NAME_MIN_SCORE=0.45
```

For `galta`, current examples include:

```text
Ghalta, Primal Hunger     0.909  via "ghalta"
Ghalta, Stampede Tyrant  0.909  via "ghalta"
Galea, Kindler of Hope   0.800  via "galea"
```

Candidate status in the trace:

- `accepted_by_score=true`: at or above the configured cutoff.
- `returned_after_filters=true`: present after paper/provider/UI filters.
- Accepted but not returned may be digital-only, unavailable under provider
  uniqueness rules, or removed by active filters.

When no candidate reaches the cutoff, the decision records
`fuzzy_routing_signal="intent_candidate"`. A general intent-planner fallback is
planned but not implemented.

## Structured Filters

### Color Identity

Subset mode:

- Selected colors compile to `id<=...`.
- Colorless is optionally included.
- When colors are selected and colorless is off, `-id=c` is added.

Exact mode:

- Selected colors compile to `id=...`.
- Colorless may be added as an OR branch.

### Mana Value

```text
mv>=MIN
mv<=MAX
```

### EUR Price

```text
eur>=MIN
eur<=MAX
```

Fuzzy candidate fetches include the same compiled clauses. Intent and exact
queries also include them at the provider boundary.

## Response Contract

Important `CardSearchPage` fields:

| Field | Meaning |
| --- | --- |
| `query` | Original user query |
| `page` | Returned page |
| `total_results` | Route/provider result count |
| `has_more` | Provider pagination signal |
| `cards` | Provider-neutral selected printings |
| `name_match_scores` | Per-printing exact/fuzzy scores |
| `warnings` | Non-fatal provider/ranker warnings |
| `strategy` | `exact`, `fuzzy`, `intent`, or `syntax` |
| `interpretation` | Human-readable route meaning |
| `reranked` | Whether intent order changed through rankers |
| `debug` | Trace summary and full structured trace, or `null` |

`name_match_scores` is empty for intent and explicit syntax routes.

## Debug Trace

Enable per browser in Search settings or globally:

```dotenv
MTG_SEARCH_DEBUG_ENABLED=true
```

Trace sections:

- Original query, page, filters, and request debug flag.
- Ranker and fuzzy configuration.
- Input classification and final decision.
- Per-layer duration, inputs, outputs, and details.
- Rank changes.
- Exact/contained name scores.
- Fuzzy aliases, scores, cutoff decisions, and return outcome.
- Complete parsed and raw OpenRouter request/response bodies.
- Final returned cards and scores.

Credentials and request headers are deliberately absent.

The append-only log is:

```text
local-data/search-debug.jsonl
```

Useful command:

```bash
tail -1 local-data/search-debug.jsonl |
  jq '{request, decision, stages, result}'
```

## Frontend Behavior

- Search runs after debounce and can be submitted explicitly.
- A new request aborts the previous browser request.
- Pagination merges cards and `name_match_scores`.
- Exact results show `Name 0.xxx`.
- Fuzzy results show `Fuzzy 0.xxx`.
- The debug panel remains available for zero-card results.
- Filters are encoded in the API client, not translated in components.

## Tests

Backend:

- `test_card_search.py`: provider mapping, catalogs, errors, HTTP behavior.
- `test_hybrid_search.py`: routing, filters, exact/fuzzy scores, ranking, trace.
- `test_health.py`: settings and application boundary.

Frontend:

- `lib/api.test.ts`: URL construction, runtime validation, public errors.
- `SearchDrawer.test.tsx`: filters, debug preference, scores, trace candidates.
- `domain/deck.test.ts`: identity, migration, warnings, placement.

Browser:

- `e2e/deck-builder.spec.ts`: fuzzy score visibility, recovery, filters, traces,
  desktop, and mobile containment.

## Known Limitations

- Fuzzy scoring is string similarity, not phonetic or keyboard-distance logic.
- Candidate generation uses the Scryfall name catalog and may include digital
  names that disappear under `game:paper`.
- The catalog is fetched lazily; the first fuzzy search is slower.
- The default cutoff is intentionally permissive while traces are evaluated.
- There is no formal offline evaluation corpus.
- Semantic ranking only reorders one live Scryfall candidate page.
- Unsupported natural language can still end as low-confidence fuzzy search.
- Full local lexical/vector recall waits for the SQLite catalog.

## Extension Checklist

Before adding a search layer:

1. Define its routing precedence.
2. Define its confidence or deterministic selection rule.
3. Apply every structured filter.
4. Specify whether it may call remote AI.
5. Add complete debug details.
6. Preserve non-fatal degradation where possible.
7. Update backend and frontend contracts atomically.
8. Add deterministic unit tests and live sanity examples.
9. Measure warmed and cold latency separately.
10. Update this document and the search ADR.
