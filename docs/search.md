# Progressive Card Search

The application starts every query with local fuzzy card-title matching. There
is no fuzzy minimum score or candidate-pool cap. When fewer than six titles
clear the stricter 75% preview-confidence boundary, the drawer keeps those
confident cards visible and starts one bounded agentic search.

The agent makes exactly one structured local-catalog tool call, sees the result
in the same conversation, and makes one final structured call that ranks the
relevant candidate IDs. The agent has no live Scryfall-query tool. Mana,
explicit result type/color, power/toughness, and price conditions filter
locally. Card names are an ordering rather than a filter (see
[`ADR 0023`](decisions/0023-name-similarity-ordering-instead-of-a-name-filter.md)). Printing-level set and rarity conditions are deliberately not offered
(see [`ADR 0022`](decisions/0022-remove-set-and-rarity-agent-filters.md)). Rules-text meaning belongs to semantic retrieval. Commander
legality and every interface selection are applied outside the agent tool.
`semantic_sort` then cosine-sorts every survivor without a similarity threshold.
See
[`ADR 0009`](decisions/0009-progressive-one-tool-agentic-search.md) and
[`ADR 0010`](decisions/0010-always-on-semantic-sort.md).

## Data Source

`npm run catalog:sync` reads Scryfall's `default_cards` bulk export as a stream,
builds `local-data/cards.sqlite3`, and ensures the local semantic sidecar at
`local-data/card-semantic.sqlite3` matches it.

The importer:

1. Discovers the current `default_cards` download, accepting either the JSON
   array or the line-delimited export Scryfall now ships.
2. Skips rebuilding when that bulk timestamp is already installed.
3. Streams the compressed body without loading the complete export into memory.
4. Keeps eligible English paper printings.
5. Stores every printing and selects one representative printing per
   `oracle_id` for search results: the cheapest printing that is not a special
   version, preferring one with an image and a price over both. `printing_selection`
   in `config.yaml` defines what counts as special, and a card with no priced
   ordinary printing falls back to its cheapest special one rather than being
   dropped. See [`ADR 0024`](decisions/0024-cheapest-ordinary-printing-selection.md).
6. Retains Oracle text, EUR price, and power/toughness in the local card record.
7. Validates a temporary SQLite database.
8. Atomically replaces the installed database only after a successful import.
9. Renders title-resistant semantic document v2 from mana value/cost, type,
   rules, power/toughness, and card faces. Self-references and `{T}`, `{Q}`, and
   `{X}` are normalized for natural-language retrieval.
10. Embeds them locally with `BAAI/bge-small-en-v1.5` and atomically installs
    normalized 384-dimensional vectors in the semantic sidecar.

Images remain remote Scryfall URLs. The SQLite file and temporary files are
ignored by Git.

Run the command again to refresh:

```bash
npm run catalog:sync
```

Use `npm run catalog:sync -- --force` to rebuild an already-current catalog.
The first run downloads approximately 67 MB of ONNX model files into
`local-data/embedding-models`. Later runs reuse the model and skip a current
semantic index.

### Stored Tagger Enrichment

`npm run tagger:sync` separately acquires Scryfall Tagger's Oracle-card tags
and relationships into `local-data/card-tagger.sqlite3`. It stores:

- Tag definitions, descriptions, and complete Oracle-ID membership lists.
- Normalized Oracle-card tagging rows keyed by tag ID and `oracle_id`.
- Directed Oracle-card relationships with classifier and inverse classifier.
- Relationship status and annotation, plus raw source records.
- Import metadata and completed-page checkpoints.

The bulk membership source does not expose Tagger's per-membership moderation
status or vote strength, so those normalized columns remain nullable. It also
includes broader/inherited memberships without identifying which assignments
were direct. Both distinctions remain deferred until this data is evaluated
for an actual search use.

The importer resumes an interrupted partial build and atomically installs a
complete sidecar. A successful database less than 24 hours old is considered
current; use `npm run tagger:sync -- --force` for a clean snapshot.

Selecting a search result or opening a deck card lazily reads this sidecar through
`GET /api/v1/cards/{oracle_id}/enrichment`. The preview groups the response
into clickable tag chips, similar cards, and cards the selection references.
Inverse `referenced_by` data remains in the backend contract and sidecar but is
not rendered. Related cards resolve through
`GET /api/v1/cards/{oracle_id}` and open in the regular card dialog; the
underlying search remains mounted.

An explicit tag selection is a hard filter: the backend intersects the local
Oracle-ID memberships for every selected tag before fuzzy ranking or the local
agent tool continues. The UI fuzzy-matches tag names but sends stable tag IDs,
and the backend resolves canonical names. Selected tags are shown to the agent
as immutable interface constraints and are deliberately absent from its tool
schema.

Semantic document v2 separately consumes a bounded gameplay-concept view of
these memberships. It removes configured metadata/flavor phrases, drops tags
that are too rare or too broad, collapses identical membership sets, normalizes
configured jargon, removes generic concepts contained by more specific ones,
and keeps at most 12 concepts per card. Membership strength/status is not used
because the bulk source does not supply it. Descriptions are disabled by
default.

Exact card relationships (`SIMILAR_TO`, `BETTER_THAN`, references, and the
others) do **not** enter embedding text, candidate expansion, or reranking.
They remain an inspectable graph for card details and a possible later exact
retrieval feature. `npm run tagger:sync` automatically checks and rebuilds the
semantic sidecar after installing a new Tagger snapshot. See
[`ADR 0014`](decisions/0014-title-resistant-tagger-enriched-semantic-documents.md).

### On-Demand EDHREC Ranking

With exactly one commander in the command zone, **Enhance with EDHREC** is on
by default. With no commander or a legal two-commander command zone, the
control is disabled because there is no combined-page policy. The drawer loads
the commander's advertised EDHREC deck themes and offers **All commander
decks** plus one optional theme such as Tokens or Stompy. Commander and theme
are immutable interface context, not hard filters or agent-editable fields.

The first enhanced cache miss for a commander fetches
`/pages/commanders/{slug}.json` from EDHREC's public JSON host. Selecting a
theme loads `/pages/commanders/{slug}/{theme}.json` on its first cache miss.
The backend stores every complete source payload and normalized association rows in
`local-data/card-edhrec.sqlite3`. EDHREC cardview printing IDs are resolved
through the local Scryfall catalog and persisted by Oracle ID. A snapshot is
reused for 30 days.

For blank-query/filter-only browsing, normal local filters run first and known
EDHREC cards sort by:

1. Raw inclusion (`num_decks / potential_decks`), descending.
2. Included deck count, descending.
3. Existing local order.

Cards absent from the commander page follow known cards without being labelled
as zero-inclusion. A failed fetch, provider-format change, mapping failure, or
cache error does not fail card search: the response carries
`edhrec.status = "unavailable"`, the normal local order is returned, and the
drawer displays **EDHREC enhancement failed**.

For agentic search, the user prompt includes the selected commander, all
advertised theme names and deck counts, and the selected theme. Every local
tool candidate carries semantic closeness plus any available commander/theme
inclusion, included-deck count, potential-deck count, and raw synergy. The
agent selects one primary sort:

- `weighted`: the default. A weighted average of semantic closeness and EDHREC
  inclusion, using `search.agentic.ranking.weighted`.
- `semantic`: intent closeness first.
- `name_similarity`: fuzzy `WRatio` closeness to `name_sort`, for a request that
  names one card. Paired with `name_sort` by schema validation and deliberately
  excluded from the `weighted` blend.
- `edhrec_inclusion`: cards most commonly included with this commander/theme.
- `edhrec_synergy`: cards that most overperform their general baseline for this
  commander/theme.

These are ranking signals only. There is no minimum score and the final model
may reorder or omit candidates. As evidence, an unlisted card stays `None` and
reports `not listed`; inside the `weighted` average it contributes zero
inclusion, which demotes it without removing it. `weighted` renormalizes over
the signals present in the run, so it needs no commander evidence, while the two
EDHREC orderings are rejected without it. See
[`ADR 0021`](decisions/0021-weighted-default-agent-ordering.md).
An EDHREC failure does not fail the agent round: semantic ranking continues and
the page reports the unavailable enhancement. See
[`ADR 0016`](decisions/0016-commander-theme-evidence-in-agentic-search.md).

The sidecar has two ownership layers:

- `commander_snapshots` stores commander identity, name, slug, fetch timestamp,
  and the complete untouched JSON document.
- `commander_associations` stores commander Oracle ID, related Oracle ID,
  `num_decks`, `potential_decks`, and raw `synergy`.
- `commander_themes` stores EDHREC's theme slug, display name, and deck count.
- `commander_theme_snapshots` stores one complete raw themed page per
  commander/theme.
- `commander_theme_associations` stores normalized theme-specific card metrics.

Inclusion is derived at read time rather than stored. The sidecar migrates the
original schema in place by adding theme tables. A stale snapshot is not
used when its refresh fails; the request deliberately falls back to normal
local or semantic ordering and reports the failure. Brackets, partner pages,
multiple selected themes, and background refresh remain outside this version.

## Query Flow

```text
user query
  -> load canonical cards and aliases from local SQLite
  -> normalize case and punctuation
  -> score every card title with RapidFuzz WRatio
  -> sort the complete catalog (no cutoff)
  -> apply Commander legality, deck identity, selected tags, color,
     mana-value, and EUR filters
  -> compute stricter preview confidence for the first six
  -> if all six clear 75%: return the normal fuzzy page
  -> otherwise: return only confident previews immediately
       -> model selects exactly one tool
       -> execute search_local_cards against the local catalog
          -> apply every structured hard filter
          -> exclude displayed and previously examined Oracle cards
          -> embed semantic_sort locally
          -> attach selected commander/theme EDHREC evidence when available
          -> primary-sort by semantic, inclusion, or synergy (no score cutoff)
          -> return the configured top candidate count
       -> keep preview IDs selectable even if the tool does not return them
       -> assign later non-overlapping IDs to new tool cards
       -> reuse the preview ID for an exact duplicate Oracle card
       -> send a concise URL-free card list back to the same model context
       -> model ranks the relevant subset and may omit weak candidates
       -> return six agent-ranked cards and store the selected ranking
       -> Load more reads every cached ranked batch without another model call
       -> when the cache is exhausted, the next click starts one continuation
          -> include every displayed card under "Already showing"
          -> exclude displayed and previously examined Oracle cards locally
          -> append only newly ranked cards and retain the next six-card batch
```

Typed queries follow this flow, including exact names, partial words, title
segments, and typos. Blank-query browsing has this optional branch after local
filters:

```text
selected filters + one commander + EDHREC enabled
  -> load a fresh commander snapshot (maximum age 30 days)
  -> otherwise fetch one commander JSON page
  -> map printing IDs to local Oracle IDs and cache raw + normalized data
  -> sort the complete filtered set by inclusion before six-card pagination
  -> on any EDHREC failure: return local order plus a visible unavailable status
```

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
Debug mode displays this score as `Title confidence N%` only on a completed
straight fuzzy search. Progressive previews awaiting agentic search and final
agent-ranked pages do not show the badge. Agentic results still recompute both
title scores across the same complete-title, face-title, and pre-comma aliases,
so API and trace evidence remain stable.

## Configuration

Search behavior lives in root [`config.yaml`](../config.yaml):

```yaml
search:
  title_match:
    page_size: 6
    preview_min_confidence: 0.75

  semantic_sort:
    model: BAAI/bge-small-en-v1.5
    index_path: local-data/card-semantic.sqlite3
    cache_dir: local-data/embedding-models
    batch_size: 256
    threads: 4
    document:
      version: 2
      fields:
        - mana_cost
        - mana_value
        - type_line
        # Semantic source data, not an agent-editable exact filter.
        - oracle_text
        - power_toughness
        - card_faces
      include_name: false
      normalize_self_references: true
      explain_symbols: true
      tags:
        enabled: true
        maximum_per_card: 12
        minimum_card_count: 3
        maximum_card_fraction: 0.20
        collapse_equivalent_memberships: true
        include_descriptions: false
        prefer_specific_tags: true
      relationships:
        include_in_document: false

  agentic:
    enabled: true
    provider: openrouter
    model: openai/gpt-5.6-luna
    reasoning_effort: low
    temperature:
    max_tool_calls: 1
    local_tool:
      default_max_results: 24
      hard_max_results: 60
    continuation:
      enabled: true
      exclude_already_shown: true
      exclude_previously_considered: true
      include_full_card_details_in_prompt: true
      max_rounds: null

edhrec:
  enabled: true
  base_url: https://json.edhrec.com
  database_path: local-data/card-edhrec.sqlite3
  timeout_seconds: 20
  refresh_after_days: 30
  user_agent: MTG-Agentic-Deck-Builder/0.1.0 (...)
```

`page_size` accepts `1..30` and controls the number of cards returned per API
page. It does not limit how many cards are scored. An environment override can
use:

```dotenv
MTG_SEARCH__TITLE_MATCH__PAGE_SIZE=6
```

Card names are deliberately absent from semantic document v2 because fuzzy
title search and the structured local name filter already resolve them. This
prevents arbitrary title words such as “Green” or “Big” from biasing gameplay
meaning. A card's own name inside its Oracle text is rendered as `this card`.

For example, Mana Confluence renders approximately as:

```text
Mana value: 0
Type: Land
Mana cost: none
Abilities:
- {T} (tap), Pay 1 life: Add one mana of any color.
Gameplay concepts: painland; rainbow land; life payment; drawback
```

If the optional Tagger sidecar is absent, the index builds valid rules-only v2
documents and records an `absent` Tagger snapshot. Installing Tagger data later
makes that semantic sidecar stale and triggers an atomic rebuild. The semantic
metadata records the complete document configuration, exact card catalog
identity, Tagger snapshot identity, model, and template version.

`preview_min_confidence` does not truncate or cap the complete fuzzy ranking.
It controls which first-page cards may be shown before the agent finishes. A
complete normalized query contained in a title alias keeps its WRatio score;
other candidates use whole-string edit similarity so natural-language token
overlap does not masquerade as title confidence.

The agentic system prompt, semantic indexed fields, one-tool limit, candidate
bounds, and full debug-capture switches also live in `config.yaml`. Semantic
sorting has no enabled flag: a current index is part of the catalog contract.

`edhrec.enabled` controls optional filter-only and agentic commander evidence.
The base URL, sidecar path, request timeout, 30-day freshness window, and
identifying user agent are independently validated. Environment overrides use
the normal nested settings form, for example
`MTG_EDHREC__DATABASE_PATH=local-data/card-edhrec.sqlite3`.

## Prompt Structure

Every rule the agent follows lives in one place: the `system_prompt` in
`config.yaml`. It is static Markdown with no runtime injection, using this
skeleton (ADR 0020):

```text
# Task        what the agent is and what a run must produce
# Inputs      every section the user message can contain
# Output      the interpretation and ranked_ids contract
# Tools       search_local_cards, filter-versus-sort, how to read the result
# Guidelines  the rules, plus hand-written worked examples
```

Everything else the model receives is data, not instruction:

| Surface | Contains |
| --- | --- |
| User message | `## Request`, `## Interface filters`, `## Commander`, `## Fuzzy matches already shown`, `## Already showing`, `## Previous tool searches`, `## Round` |
| Tool result message | `## Search`, `## Candidates (n)` |
| Tool description | one line naming what the tool does |
| Schema field descriptions | shape and units only |

A section is omitted entirely when it carries no data. No sentence in the user
or tool message may tell the model what to do, because a rule stated in two
places can disagree with itself — that is how the tool description came to
contradict the prompt about type filters.

Prompt content is tested rather than trusted. `test_health` asserts the skeleton
headings and parses every worked example in `# Guidelines` as a
`LocalCardSearchRequest`, so an example cannot drift out of schema.

The initial user prompt gives every already-visible fuzzy card a selectable ID
and includes its mana, type, power/toughness, EUR estimate, and Oracle text.
Those preview IDs are reserved at the front of the candidate union. The local
tool cannot overwrite them: a new card receives the next available ID, while
the same `oracle_id` reuses the existing preview ID.

When one commander is selected, the prompt also includes its name, mana, type,
color identity, Oracle text, the top ten EDHREC theme names, and the selected
theme. The full advertised theme list remains available to the interface. The
runtime supplies the commander and theme separately from the tool arguments,
so the model cannot silently replace either. When EDHREC is unavailable or
disabled, the prompt explicitly removes the EDHREC-sort capability while
retaining the commander context.

The tool schema requires nested exact conditions. A narrow provider-boundary
compatibility layer repairs obvious string shorthand before strict validation:
for example, `types: "Elf"` becomes a required Elf type. Type filters compare
literal printed type-line fragments. AND combinations such as Artifact
Creature use separate `must_contain_all` values; OR alternatives such as
Instant or Sorcery use separate `must_contain_any` values. Broad gameplay
requests do not receive invented type filters. As a final guard, malformed
comma-joined alternatives are split and abstract rules terms such as
`Permanent` are expanded to their printed card-type alternatives.

The local tool has no Oracle-text filter. Card rules remain part of the
semantic documents and are returned as candidate context, but the model cannot
turn an inferred sentence into a brittle hard filter. Requests such as
“creatures that draw cards when other creatures enter” therefore stay in
`semantic_sort`.

The agent owns its `types` and `colors`. Validated filters reach local
execution unmodified; no runtime pass deletes or relaxes them based on the
wording of the query. That responsibility sits in the system prompt, which
teaches the Magic distinction the runtime could not:

- Functional categories span several printed types and stay in `semantic_sort`:
  removal, ramp and fixing, board wipes, card draw, tutors, protection,
  recursion, graveyard value, stax, and payoffs.
- Definitional and typal terms name a printed type and justify a filter: a mana
  rock is an Artifact, elves are Elf, sagas are Saga.
- Filter a printed type only when every acceptable answer must print it.
- A type naming an effect's subject is not a result filter. “Creatures that draw
  cards” may filter Creature; “card draw whenever creatures enter” may not.
- The prompt states the stakes: nothing downstream relaxes an agent filter and
  there is one tool call, so an unjustified filter costs more than an absent one.

An earlier runtime guard enforced this by requiring the type word to appear in
the query. It deleted correct filters for ordinary vernacular such as “cheap
mana rocks” and “elf tribal payoffs” and was removed in
[ADR 0019](decisions/0019-prompt-taught-agent-filters.md).

`format` and `legality` are not tool fields. Commander legality and its
exception switch belong entirely to the immutable interface filters, and stale
provider-supplied copies are discarded before validation.

The debug tool-call step shows the final validated arguments and lists every
provider-boundary repair. The untouched provider message remains available only
in the raw JSONL audit trace.

All structured search conditions are hard filters. `semantic_sort`, `name_sort`,
and `sort_by` are ranking controls: `semantic_sort` is a natural-language intent
string, `name_sort` is a card name scored by fuzzy title similarity, and
`sort_by` selects `weighted`, `semantic`, `edhrec_inclusion`, `edhrec_synergy`,
or `name_similarity` as the primary ordering and defaults to `weighted`. None
filters or has a minimum score.
The service supplies the original user request when the model omits
`semantic_sort`, so every agent round retains semantic evidence and uses it as
a tie-breaker for EDHREC sorts. The prompt teaches
the agent to clean up bad grammar, separate explicit constraints from broad
intent, and use examples such as `untapping elves`, `big green creatures`,
`grave yard things`, double-X artifacts, and `galta`.

The clean tool-role message includes `Semantic closeness: N (0-1)` and
`EDHREC commander fit` for every candidate. The latter reports normalized
inclusion, `num_decks / potential_decks`, and raw synergy when the selected
commander/theme page lists the card. Larger semantic values mean closer
embedding similarity; larger synergy values mean greater commander-specific
overperformance. All values are evidence, not relevance thresholds. A fuzzy
preview not returned by the local tool is labelled `not scored`, and a card
absent from EDHREC is labelled `not listed` rather than receiving invented
scores.

**Load more** is always available after a search response. `has_more: true`
means the next ranked batch is already cached. `has_more: false` means the
next click explicitly authorizes one additional two-call/one-tool agent round.
The existing cards remain visible while that round runs.

Every continuation prompt includes the complete displayed-card list with
temporary IDs, mana, type, power/toughness, EUR estimate, and Oracle text.
It also includes the exact structured local-tool request from every completed
agent round. The prompt treats those earlier searches as conclusive first
passes and tells the next agent not to repeat one unchanged. The next round
must preserve the user's intent and interface filters while deliberately
relaxing unnecessary agent-chosen filters, widening alternatives, or expanding
`semantic_sort` toward adjacent useful roles. Its recommendations may be less
ideal than the first set, but must still fit the request's spirit.
Displayed `oracle_id` values and every local candidate examined by an earlier
round are excluded before the local result limit is applied. This prevents
duplicates and forces later rounds to inspect fresh catalog candidates. A
round that finds nothing returns an empty successful batch and a warning; the
button remains available for another, potentially broader round.

The local catalog path is configured separately:

```dotenv
MTG_CARD_CATALOG_PATH=local-data/cards.sqlite3
```

## Filters

After fuzzy ranking, the backend applies these values directly to local card
data:

- Commander legality: legal-only unless the exception switch is selected.
- Current commander color identity: require a subset unless the exception
  switch is selected. An established colorless identity permits only colorless
  cards.
- Required card types: every selected literal type must appear across the
  card's printed faces.
- Required subtypes: every fuzzy-selected literal subtype must appear across
  the card's printed faces.
- Required Tagger labels: a card must carry every selected tag.
- Subset or exact color identity.
- Optional colorless identity.
- Minimum and maximum mana value.
- Minimum and maximum EUR estimate.

The two exception switches are independent checkboxes and start unchecked.
Without a known commander, the commander-identity exception is disabled and no
deck-identity filter is applied. Subtype and tag filters are fuzzy-found by
name and removable as chips. Card types, subtypes, and tags use AND semantics
within their categories.

All of these values are passed unchanged into agentic and continuation
requests. The agent sees them in its user prompt, but cannot add, remove, or
modify them through `search_local_cards`. Cards without an EUR estimate do not
pass an active price filter. The filtered rank order is then divided into
normal numbered pages, so filters cannot create partially filled pages before
the final page.

When EDHREC enhancement is active, these same hard filters still run first.
EDHREC changes only the ordering of the complete surviving set before the same
six-card pagination.

## Debug Mode

Enable **Search debug log** in Search settings.

Debug mode:

- Shows `Title confidence N%` beneath completed straight fuzzy results only.
- Keeps alias-aware confidence in API and trace data when fuzzy previews are
  replaced by agent-ranked results, without rendering it on agentic cards.
- Reports the local catalog count, filtered count, removed count, page range,
  matched aliases, original ranks, WRatio scores, and title confidence.
- Renders exactly seven agentic steps: system prompt, user input prompt,
  thinking, tool call, tool response, final thinking, and output response.
- Retains one separately labelled seven-step trace for every continuation
  round while the drawer remains open.
- Keeps the same seven-step trace on agentic failure: completed steps stay
  visible, the broken step opens automatically with sanitized provider
  evidence, and later steps are marked skipped.
- Shows the exact simplified tool-role message sent to the model, using local
  numeric IDs, beside the expandable untouched raw tool result.
- Shows each candidate's normalized semantic closeness in that readable
  message, and records the intent, model, vector dimensions, scored-candidate
  count, and raw per-candidate score while explicitly recording no cutoff.
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
GET /api/v1/cards/tags/search
GET /api/v1/cards/{oracle_id}
GET /api/v1/cards/{oracle_id}/enrichment
```

| Parameter | Type | Purpose |
| --- | --- | --- |
| `q` | string | Optional title; empty is valid for filter-only search |
| `page` | positive integer | Numbered result page |
| `color` | repeatable W/U/B/R/G | Allowed or exact identities |
| `include_colorless` | boolean | Include exact colorless identity |
| `color_mode` | `subset` or `exact` | Identity comparison mode |
| `include_non_commander_legal` | boolean | Permit non-legal Commander cards |
| `include_outside_commander_identity` | boolean | Permit cards outside the deck identity |
| `commander_color` | repeatable W/U/B/R/G | Current commander identity colors |
| `commander_identity_known` | boolean | Preserve an established colorless identity |
| `tag` | repeatable tag ID | Require every selected Tagger label |
| `card_type` | repeatable printed card type | Require every selected card type |
| `subtype` | repeatable printed subtype | Require every selected subtype |
| `mana_min`, `mana_max` | number | Mana-value range |
| `price_min`, `price_max` | decimal | EUR-estimate range |
| `commander_oracle_id` | UUID | Single commander used for optional EDHREC ranking |
| `enhance_with_edhrec` | boolean | Enable EDHREC commander evidence |
| `edhrec_theme` | theme slug | Optional theme advertised for that commander |
| `debug` | boolean | Return and persist the title-match trace |

For example:

```http
GET /api/v1/cards/search?q=&page=1&commander_oracle_id=<uuid>&enhance_with_edhrec=true&edhrec_theme=tokens
```

Commander ID and the enhancement flag are required for an enhanced page;
theme is optional. If the GET's `q` contains text, fuzzy title search ignores
the enhancement because the agentic POST owns typed commander-aware ranking.

Theme options load independently:

```http
GET /api/v1/cards/{commander_oracle_id}/edhrec
```

That response contains `status`, commander name, source, message, and sorted
`themes` with `slug`, `name`, and `deck_count`.

The agentic POST accepts the same `commander_oracle_id`,
`enhance_with_edhrec`, and `edhrec_theme` fields in its JSON body. The GET
returns the fuzzy page or immediate confident preview plus
`agentic_required`. The POST starts the one-tool agent run, or accepts
`search_session_id` with a later page to reuse a cached batch or start one
continuation. `already_shown_oracle_ids` contains the cards currently visible
in the drawer and is required when an exhausted search is expanded.

`total_results` is the number of results discovered so far in the active fuzzy
ranking or progressive agentic session. `has_more` means a later ranked batch
is already cached; it does not control whether **Load more** is rendered.
`name_match_scores`
maps each returned
`scryfall_id` to its broad normalized WRatio score.
`title_confidence_scores` maps the same IDs to the coverage-aware score used by
the progressive preview phase. The frontend renders it only for completed
straight fuzzy pages in debug mode.

Every `CardSearchPage` also contains:

```json
{
  "edhrec": {
    "status": "applied",
    "source": "cache",
    "message": null
  }
}
```

`not_requested` covers requests without enabled evidence. `applied` identifies
whether fresh evidence came from the cache or network, for either blank or
agentic search. `unavailable` contains a safe message for the visible local or
semantic fallback.

## Failure Behavior

- A missing, incompatible, or unreadable catalog returns the safe HTTP 503
  card-search response.
- A missing or stale semantic sidecar returns a safe agentic HTTP 503 and tells
  local diagnostics to run `npm run catalog:sync`.
- A missing OpenRouter key or unavailable model/provider returns a safe HTTP
  503 for the agentic phase; any confident fuzzy previews remain visible.
- Model parameters are configuration, not constants: `reasoning_effort` and
  `temperature` are sent on both the tool call and the final ranking. Leave
  `temperature` empty for a model that has no such endpoint — reasoning models
  including the GPT-5 series reject it, and because `provider.require_parameters`
  is on, an unsupported parameter makes OpenRouter find no endpoint at all and
  the search fails with HTTP 404 rather than ignoring the field.
- The advertised tool schema is rendered for provider consumption rather than
  passed through: it does not claim `strict`, because strict mode requires every
  property to be listed in `required` while every field of this tool is optional,
  and it omits the numeric-string alternative Pydantic renders for `Decimal`,
  whose regex uses a negative lookahead that OpenAI's schema validator rejects.
  Both would otherwise fail the call outright on OpenAI models while passing
  silently on Gemini.
- Common provider shorthands are normalized before validation, including
  compact color identities such as `WUBG`. Stale model-supplied `format` or
  `legality` fields are discarded because the interface owns those decisions.
  Empty provider placeholders such as `...` are omitted because every search
  field is optional. A remaining invalid model response returns a truthful HTTP
  502 contract error and retains its debug trace.
- An invalid or expired agentic session returns a safe HTTP 400.
- A selected tag with a missing Tagger sidecar returns a safe HTTP 503; normal
  non-tag search remains available.
- An EDHREC fetch, validation, ID-mapping, or sidecar failure remains HTTP 200:
  blank browsing uses normal local order, agentic search uses semantic order,
  and `edhrec.status` is `unavailable`.
- An agent round with no new relevant cards returns an empty successful batch,
  keeps prior cards visible, and leaves the continuation button available.
- A failed refresh leaves the previously installed SQLite database untouched.

## Tests

- `test_card_catalog.py`: streaming import, representative print selection, and
  atomic failure behavior.
- `test_card_search.py`: Scryfall card-object mapping and HTTP contract.
- `test_title_search.py`: exact-first threshold-free ordering, local filters,
  simple pagination, EDHREC ordering/fallback, preview confidence, and trace
  evidence.
- `test_edhrec_catalog.py`: commander-page validation and deduplication, theme
  parsing and themed-page caching, raw payload retention, Oracle normalization,
  and 30-day freshness.
- `test_agentic_search_contracts.py`: all-optional local-tool fields, multiset
  symbols, runtime-owned field exclusion, result bounds, numeric
  relevant-subset validation, versioned trace completeness, full raw JSON
  persistence, and secret redaction.
- `test_agentic_card_search.py`: one-tool orchestration, duplicate mana-symbol
  execution, filter-before-sort behavior, semantic/inclusion/synergy ranking,
  agent-owned type/color pass-through, prompt filter vocabulary,
  commander/theme prompts and score evidence,
  natural prompts, raw/simplified tool trace payloads, candidate omission,
  alias-aware confidence preservation, cached pagination, exclusions, empty
  continuation retries, and multi-round agent sessions.
- `test_semantic_index.py`: atomic index builds, stable gameplay documents,
  cosine scoring without a cutoff, and stale-catalog rejection.
- Frontend component and browser tests: progressive preview, animated agent
  handoff, readable seven-step traces, scores, filters, EDHREC request/fallback
  UI, and Load more.
