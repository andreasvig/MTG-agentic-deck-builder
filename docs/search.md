# Card-Title Search

The application has one search phase: local fuzzy card-title matching. There is
no minimum score, candidate cap, intent compiler, semantic model, LLM reranker,
direct Scryfall-syntax mode, or per-query Scryfall request.

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
6. Validates a temporary SQLite database.
7. Atomically replaces the installed database only after a successful import.

Images remain remote Scryfall URLs. The SQLite file and temporary files are
ignored by Git.

Run the command again to refresh:

```bash
npm run catalog:sync
```

Use `npm run catalog:sync -- --force` to rebuild an already-current catalog.

## Query Flow

```text
user title
  -> load canonical cards and aliases from local SQLite
  -> normalize case and punctuation
  -> score every card title with RapidFuzz WRatio
  -> sort the complete catalog (no cutoff)
  -> apply local color, mana-value, and EUR filters
  -> return the requested 12-card page
  -> fetch the next page only when Load more is selected
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

## Configuration

Search behavior lives in root [`config.yaml`](../config.yaml):

```yaml
search:
  title_match:
    page_size: 12
```

`page_size` accepts `1..30` and controls the number of cards returned per API
page. It does not limit how many cards are scored. An environment override can
use:

```dotenv
MTG_SEARCH__TITLE_MATCH__PAGE_SIZE=12
```

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

- Shows `Fuzzy match N%` beneath every returned result.
- Reports the local catalog count, filtered count, removed count, page range,
  matched aliases, original ranks, and scores.
- Records `minimum_score: null` to make the absence of a threshold explicit.
- Appends the complete trace to `local-data/search-debug.jsonl`.

There are no provider queries in a search trace because normal search makes no
network request.

## Public Endpoint

```http
GET /api/v1/cards/search
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

`total_results` is the number of locally filtered cards. `has_more` means a
later numbered page exists. `name_match_scores` maps each returned
`scryfall_id` to its normalized fuzzy score.

## Failure Behavior

- A missing, incompatible, or unreadable catalog returns the safe HTTP 503
  card-search response.
- An empty filtered result or page beyond the end returns an empty successful
  page.
- A failed refresh leaves the previously installed SQLite database untouched.

## Tests

- `test_card_catalog.py`: streaming import, representative print selection, and
  atomic failure behavior.
- `test_card_search.py`: Scryfall card-object mapping and HTTP contract.
- `test_title_search.py`: exact-first threshold-free ordering, local filters,
  simple pagination, and trace evidence.
- Frontend component and Playwright tests: scores, filters, and Load more.
