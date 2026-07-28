# Progressive Card Search

The application starts every query with local fuzzy card-title matching. There
is no fuzzy minimum score or candidate-pool cap. When fewer than six titles
clear the stricter 75% preview-confidence boundary, the drawer keeps those
confident cards visible and starts one bounded agentic search.

The agent makes exactly one structured local-catalog tool call, sees the result
in the same conversation, and makes one final structured call that ranks the
relevant candidate IDs. The agent has no live Scryfall-query tool. Semantic
embeddings remain disabled; name, exact Oracle text, mana, type, color,
power/toughness, price, format, set, and rarity filters execute locally.
See
[`ADR 0009`](decisions/0009-progressive-one-tool-agentic-search.md).

## Data Source

`npm run catalog:sync` reads Scryfall's `default_cards` bulk export as a stream
and builds `local-data/cards.sqlite3`.

The importer:

1. Discovers the current `default_cards` download.
2. Skips rebuilding when that bulk timestamp is already installed.
3. Streams the compressed JSON without loading the complete export into memory.
4. Keeps eligible English paper printings.
5. Stores every printing and selects one representative printing per
   `oracle_id` for search results.
6. Retains Oracle text, EUR price, and power/toughness in the local card record.
7. Validates a temporary SQLite database.
8. Atomically replaces the installed database only after a successful import.

Images remain remote Scryfall URLs. The SQLite file and temporary files are
ignored by Git.

Run the command again to refresh:

```bash
npm run catalog:sync
```

Use `npm run catalog:sync -- --force` to rebuild an already-current catalog.

## Query Flow

```text
user query
  -> load canonical cards and aliases from local SQLite
  -> normalize case and punctuation
  -> score every card title with RapidFuzz WRatio
  -> sort the complete catalog (no cutoff)
  -> apply local color, mana-value, and EUR filters
  -> compute stricter preview confidence for the first six
  -> if all six clear 75%: return the normal fuzzy page
  -> otherwise: return only confident previews immediately
       -> model selects exactly one tool
       -> execute search_local_cards against the local catalog
       -> keep preview IDs selectable even if the tool does not return them
       -> assign later non-overlapping IDs to new tool cards
       -> reuse the preview ID for an exact duplicate Oracle card
       -> send a concise URL-free card list back to the same model context
       -> model ranks the relevant subset and may omit weak candidates
       -> return six agent-ranked cards and store the selected ranking
       -> Load more reads the stored ranking without another model call
```

Every query follows this flow, including exact names, partial words, title
segments, and typos.

## Matching

Each card contributes these normalized aliases:

- Complete card title.
- Each face title of a multi-faced card.
- Text before a comma, such as `Ghalta`.

Normalization lowercases the text, replaces punctuation with spaces, and
collapses surrounding whitespace. RapidFuzz `WRatio` returns a value from
`0.0` to `1.0`.

Typical behavior:

```text
forest -> Forest             100%
forest -> Forest Bear         90%
forest -> Forestfolk          90%
forest -> Misty Rainforest    90%
galta  -> Ghalta              91%
```

An exact normalized title scores `1.0`. Equal scores prefer the alias whose
length is closest to the query, then title order for determinism. The score is
a string-similarity heuristic, not a probability.

### Title Confidence

WRatio remains the broad internal ranking signal because it recalls partial
words and title segments well. It is not displayed as a percentage because its
token shortcuts can overstate a partial match: `big green creatures` can score
highly against Green Dragon based on `green` alone.

Every returned card also has a stricter title-confidence score:

- If the complete normalized query occurs inside a title alias, keep the
  existing WRatio behavior. `green` therefore still matches Green Dragon.
- Otherwise, compare the complete query and title alias with whole-string edit
  similarity. Every added descriptor then affects the score.

This preserves `forest` → Misty Rainforest and `galta` → Ghalta while making
`big green creatures` → Green Dragon fall below the 75% preview boundary.
Debug mode displays this score as `Title confidence N%`. Agentic results
recompute both title scores across the same complete-title, face-title, and
pre-comma aliases, so reranking cannot make a confident `galtha` → `Ghalta`
preview fall from 83% to a whole-title score near 38%.

## Configuration

Search behavior lives in root [`config.yaml`](../config.yaml):

```yaml
search:
  title_match:
    page_size: 6
    preview_min_confidence: 0.75

  semantic:
    enabled: false
    model: null

  agentic:
    enabled: true
    provider: openrouter
    model: google/gemini-3.5-flash-lite
    max_tool_calls: 1
    local_tool:
      default_max_results: 24
      hard_max_results: 60
```

`page_size` accepts `1..30` and controls the number of cards returned per API
page. It does not limit how many cards are scored. An environment override can
use:

```dotenv
MTG_SEARCH__TITLE_MATCH__PAGE_SIZE=6
```

`preview_min_confidence` does not truncate or cap the complete fuzzy ranking.
It controls which first-page cards may be shown before the agent finishes. A
complete normalized query contained in a title alias keeps its WRatio score;
other candidates use whole-string edit similarity so natural-language token
overlap does not masquerade as title confidence.

The agentic system prompt, semantic indexed fields, one-tool limit, candidate
bounds, and full debug-capture switches also live in `config.yaml`. Agentic
search is enabled; semantic embeddings remain disabled.

The initial user prompt gives every already-visible fuzzy card a selectable ID
and includes its mana, type, power/toughness, EUR estimate, and Oracle text.
Those preview IDs are reserved at the front of the candidate union. The local
tool cannot overwrite them: a new card receives the next available ID, while
the same `oracle_id` reuses the existing preview ID.

The tool schema requires nested exact conditions. A narrow provider-boundary
compatibility layer repairs obvious string shorthand before strict validation:
for example, `types: "Elf"` becomes a required Elf type and
`oracle_text: "untap"` becomes an exact Oracle-text alternative. It never
promotes shorthand into semantic search while embeddings are disabled.

The local catalog path is configured separately:

```dotenv
MTG_CARD_CATALOG_PATH=local-data/cards.sqlite3
```

## Filters

After fuzzy ranking, the backend applies these values directly to local card
data:

- Subset or exact color identity.
- Optional colorless identity.
- Minimum and maximum mana value.
- Minimum and maximum EUR estimate.

Cards without an EUR estimate do not pass an active price filter. The filtered
rank order is then divided into normal numbered pages, so filters cannot create
partially filled pages before the final page.

## Debug Mode

Enable **Search debug log** in Search settings.

Debug mode:

- Shows `Title confidence N%` beneath every returned result.
- Keeps that alias-aware confidence stable when fuzzy previews are replaced by
  agent-ranked results.
- Reports the local catalog count, filtered count, removed count, page range,
  matched aliases, original ranks, WRatio scores, and title confidence.
- Renders exactly seven agentic steps: system prompt, user input prompt,
  thinking, tool call, tool response, final thinking, and output response.
- Keeps the same seven-step trace on agentic failure: completed steps stay
  visible, the broken step opens automatically with sanitized provider
  evidence, and later steps are marked skipped.
- Shows the exact simplified tool-role message sent to the model, using local
  numeric IDs, beside the expandable untouched raw tool result.
- Records `minimum_score: null` to make the absence of a threshold explicit.
- Appends the complete trace to `local-data/search-debug.jsonl`.

Fuzzy traces include preview confidence, the qualifying preview count, and the
agentic handoff decision. The inline agent trace deliberately hides duplicated
request envelopes, request context, validation plumbing, log metadata, and the
full raw trace. The internal schema-version-2 JSONL audit record remains
complete and preserves model/tool payloads and provider-returned reasoning
fields while redacting authentication headers, API keys, cookies, passwords,
and secrets. It does not claim access to hidden model chain-of-thought.
When the agentic endpoint returns `503` in debug mode, its typed public error
detail includes this sanitized failed trace; non-debug errors keep the small
stable error envelope.

## Public Endpoint

```http
GET /api/v1/cards/search
POST /api/v1/cards/search/agentic
```

| Parameter | Type | Purpose |
| --- | --- | --- |
| `q` | string | Complete or partial card title |
| `page` | positive integer | Numbered result page |
| `color` | repeatable W/U/B/R/G | Allowed or exact identities |
| `include_colorless` | boolean | Include exact colorless identity |
| `color_mode` | `subset` or `exact` | Identity comparison mode |
| `mana_min`, `mana_max` | number | Mana-value range |
| `price_min`, `price_max` | decimal | EUR-estimate range |
| `debug` | boolean | Return and persist the title-match trace |

The GET returns the fuzzy page or immediate confident preview plus
`agentic_required`. The POST starts the one-tool agent run, or accepts
`search_session_id` with a later page to reuse a completed ranking.

`total_results` is the number of results in the active fuzzy ranking or the
agent-selected relevant subset. `has_more` means a later numbered page exists.
`name_match_scores`
maps each returned
`scryfall_id` to its broad normalized WRatio score.
`title_confidence_scores` maps the same IDs to the coverage-aware score shown
in debug mode and used by the progressive preview phase.

## Failure Behavior

- A missing, incompatible, or unreadable catalog returns the safe HTTP 503
  card-search response.
- A missing OpenRouter key or unavailable model/provider returns a safe HTTP
  503 for the agentic phase; any confident fuzzy previews remain visible.
- An invalid or expired agentic session returns a safe HTTP 400.
- An empty filtered result or page beyond the end returns an empty successful
  page.
- A failed refresh leaves the previously installed SQLite database untouched.

## Tests

- `test_card_catalog.py`: streaming import, representative print selection, and
  atomic failure behavior.
- `test_card_search.py`: Scryfall card-object mapping and HTTP contract.
- `test_title_search.py`: exact-first threshold-free ordering, local filters,
  simple pagination, preview confidence, and trace evidence.
- `test_agentic_search_contracts.py`: all-optional local-tool fields, multiset
  symbols, result bounds, numeric relevant-subset validation, versioned trace
  completeness, full raw JSON persistence, and secret redaction.
- `test_agentic_card_search.py`: one-tool orchestration, duplicate mana-symbol
  execution, natural prompts, raw/simplified tool trace payloads, candidate
  omission, alias-aware confidence preservation, and session pagination.
- Frontend component and browser tests: progressive preview, animated agent
  handoff, readable seven-step traces, scores, filters, and Load more.
