# Current Architecture

This document describes the code that runs today. Target architecture is
recorded separately in `plan.md` and proposed ADRs.

## Runtime Topology

```text
Browser
  |
  | React application (127.0.0.1:41737)
  | - deck library, and a durable per-deck diff history that undo replays backwards
  | - localStorage persistence
  | - search, editor, dialogs, responsive shell
  | - applies the agent's resolved deck edits; the backend never mutates a deck
  |
  | HTTP JSON
  v
FastAPI (127.0.0.1:43127/api/v1)
  |
  | FuzzyTitleSearchProvider
  | - local SQLite cards and title aliases
  | - RapidFuzz WRatio scores
  | - threshold-free, numbered six-card pages
  | - local Commander, deck-identity, type, subtype, tag, color, mana, and price filters
  | - debug tracing
  |
  +--> local-data/cards.sqlite3
  +--> local-data/card-semantic.sqlite3
  |
  | blank-query browse with one commander and EDHREC enabled
  +--> EdhrecCommanderService
       |-- fresh 30-day cache read or one commander-page fetch
       |-- Scryfall printing ID -> local Oracle ID normalization
       `--> local-data/card-edhrec.sqlite3 (raw JSON + normalized rows)
  |
  | deck agent chat turn (POST /agent/chat/stream, or /agent/chat for plain JSON)
  +--> DeckAgentService
       |-- system prompt + the newest `agent.max_history_messages` transcript entries
       |-- up to `agent.tools.max_iterations` rounds of tool use
       |     `-- DeckAgentToolbox: read_deck (posted snapshot + catalog)
       |                           see_cards (catalog, Tagger sidecar, EDHREC)
       |                           search_cards (LocalCardSearchTool, all filters
       |                                         written by the model itself)
       |                           read_history (posted history log, newest first)
       |                           edit_deck (resolves a change against the posted
       |                                      snapshot; mutates nothing)
       |                           search_web (Perplexity sonar; summary + sources)
       |                           read_page (plain fetch of one cited URL)
       |-- one final completion advertising no tools, so a turn always answers
       |-- streamed: `tool` as each call runs, `text` as the answer is written,
       |             `deck_edit` the moment edit_deck succeeds
       `--> reply, the calls it made, and the cost summed over every completion
             `-- on a debug turn, each call's arguments and its exact result
  |
  | when fewer than six titles clear preview confidence
  v
AgenticCardSearchService
  |-- OpenRouter initial tool selection
  |-- exactly one structured local-catalog tool call
  |     `-- hard filters -> local semantic sort -> candidate limit
  |-- OpenRouter structured relevant-subset ranking
  `-- in-memory ranked batches and user-triggered Load more continuations
  |
  +--> local-data/search-debug.jsonl (debug only)

Explicit refresh:

Scryfall default_cards -> streaming importer -> atomic cards.sqlite3 swap
cards.sqlite3 + optional bounded Tagger concepts
  -> document v2 -> FastEmbed ONNX model -> atomic semantic sidecar swap

Explicit enrichment acquisition:

Scryfall Oracle-tag bulk + Tagger relationship edges
  -> resumable importer -> atomic card-tagger.sqlite3 swap
                           -> lazy card-detail enrichment
                           -> explicit immutable tag filters
                           -> bounded document-v2 gameplay concepts
                              -> atomic semantic sidecar refresh
```

The backend does not currently persist decks. The frontend does not call a
deck API. `edit_deck` does not change that: it computes a resolved change against
the snapshot posted with the turn and emits it as a `deck_edit` event, and the
browser is the only thing that applies one (ADR 0036).

## Process Lifecycle

`npm run dev` executes `scripts/dev.mjs`.

The runner:

1. Loads root `.env` through Node's `--env-file-if-exists`.
2. Validates the frontend origin and both port values.
3. Refuses to start if either configured port is occupied.
4. Starts Uvicorn with reload from the backend virtual environment.
5. Starts Vite from the frontend workspace.
6. Injects the resolved API base URL into Vite.
7. Forwards termination and stops both children.

Uvicorn's FastAPI lifespan creates one shared `SQLiteCardCatalog`, its
`SemanticCardIndex`, the fuzzy provider, one local agent search tool, an
optional secret-backed OpenRouter client, the agentic service/session store,
the read-only Tagger sidecar adapter, the on-demand EDHREC commander service,
and JSONL trace writers. Only the separate `catalog:sync` command performs
Scryfall card-catalog network access.

The separate `tagger:sync` command acquires community-maintained Oracle-tag
memberships from Scryfall's bulk tag payload and card relationships from
Tagger. FastAPI never runs that importer and normal search does not contact
either source. Card details and explicitly selected tag filters read only the
installed local sidecar.

## Backend Modules

### `config.py`

`Settings` is the single runtime configuration model. Non-secret title-match
values load from root `config.yaml`; environment variables and `.env` can
override them. Origins and URLs are validated before startup.

### `domain/cards.py`

Strict provider-neutral Pydantic models for:

- Card faces, images, prices, and selected printings.
- Structured search filters and queries.
- Search pages, strategies, scores, and debug summaries.

`extra="forbid"` is deliberate. A public contract addition must be intentional
and reflected in the frontend runtime validator.

### `domain/agentic_search.py`

Strict contracts for the active progressive agentic-search phase:
all-optional local tool fields, merged mana filters, top-level non-filtering
`semantic_sort`, candidate evidence, final ranked IDs, and the versioned
internal audit trace. Rules text informs the semantic index and final ranking
context but is deliberately not an exact tool filter. Commander format and
legality are runtime-owned and absent from this model-editable contract. The
public debug summary projects the audit trace into the seven valuable agent steps.
`AgenticCardSearchRequest` and the additional page metadata form the public
progressive HTTP contract.

### `domain/agent_chat.py`

The reply also carries `card_links`: the card names the answer braced, resolved against
the local catalog so the chat can open them (ADR 0033).

Also the streamed turn's events — `text`, `tool`, `deck_edit`, `done`, `error` — where
`done` carries the same reply the JSON route returns, so nothing stored depends on which
route produced it (ADR 0031).

`deck_edit` carries the resolved edit `edit_deck` computed: the changes it kept, the
model's `reason`, and a full `CardSearchResult` for every card being **added**, because
the browser cannot construct one and the deck's own validators read fields only the
payload has (ADR 0036). `EditDeckArguments` and `DeckEditChange` state the copy count
wanted *afterwards* rather than an operation, which is what makes the call idempotent and
therefore safe to retry. `DeckAgentDeckHistory` is the browser's log, posted with the turn
exactly as the deck snapshot is and bounded by `MAX_HISTORY_SESSIONS`,
`MAX_HISTORY_EDITS` and `MAX_HISTORY_EDIT_CARDS` — exceeding any of them is a 422 that
fails the whole turn, so the client prunes newest-first before sending.

Strict contracts for the deck agent's chat turn: an alternating transcript whose
newest message must be the user's, and a reply carrying the assistant message, the
model that answered, how much of the transcript was replayed, and the turn's cost.
The transcript is the request because the agent keeps no session (ADR 0027). A turn
may set `debug`, which asks for each tool call's arguments and its exact result
alongside the answer, bounded by `MAX_TOOL_PAYLOAD_CHARS` (ADR 0030).

### `domain/deck.py`

Early backend deck models for stable identities, sections, quantities, and
categories. These are not yet exposed through routes or a repository.

### `api/router.py`

Owns `/api/v1`, health response, and router composition.

### `api/errors.py`

The one public error envelope, `PublicError` and `PublicErrorResponse`, shared by
every route so clients read failures the same way whatever answered.

### `api/agent.py`

Owns `POST /agent/chat` and `POST /agent/chat/stream`. Separates an unusable reply
(`502`) from an unreachable or unconfigured agent (`503`). The streaming route checks
availability *before* returning a response, because a status code cannot be revised
once the first byte is out; a failure after that point becomes an `error` event
carrying the same code and wording, from the one shared definition (ADR 0031).

### `api/cards.py`

Translates query parameters into `CardSearchQuery`, resolves the provider from
application state, and maps provider errors into stable public HTTP errors.

Current product routes:

```text
GET /api/v1/health
POST /api/v1/agent/chat
POST /api/v1/agent/chat/stream
GET /api/v1/cards/search
POST /api/v1/cards/search/agentic
GET /api/v1/cards/tags/search
GET /api/v1/cards/subtypes/search
GET /api/v1/cards/{oracle_id}
GET /api/v1/cards/{oracle_id}/enrichment
GET /api/v1/cards/{oracle_id}/edhrec
GET /api/v1/cards/{oracle_id}/edhrec/similar
GET /api/v1/openapi.json
```

### `providers/cards.py`

Provider protocol plus application-level provider exceptions. Routes and
search orchestration depend on this boundary.

### `providers/scryfall.py`

Owns Scryfall card-object wire models, validation, domain mapping, and the
provider-neutral title-similarity function.

Scryfall-specific response objects must not cross this module boundary.

### `providers/openrouter.py`

Secret-safe async boundary for direct OpenRouter chat completions, whole or streamed.
Streaming opens the connection and reads it line by line in worker threads, so the
boundary keeps its dependency-free transport and its injectable `open_url`; keep-alive
comments are ordinary traffic and an error chunk is raised rather than yielded
(ADR 0031). Transport
errors retain debug evidence without exposing credentials through public
errors. In debug mode, an agentic `503` carries the sanitized partial trace so
the drawer can show completed, failed, and skipped steps instead of discarding
the evidence.

The module also owns `completion_cost_usd`, which reads `usage.cost` out of a
completion. Cost is taken from the provider's own accounting rather than computed
from token counts, and an unreported figure returns `None` rather than `0.0` so it
can never be summed as though it were free (ADR 0028).

### `providers/web_page.py`

Reads one page as text for `read_page`: stdlib `urllib` and `HTMLParser`, no new
dependency and no JavaScript. The URL comes from a model, so the scheme is restricted to
http(s), the resolved address must be public — this app's own API is on loopback — the
body is capped in bytes before it is read, and only HTML and plain text are accepted.

A document longer than one part is paginated rather than truncated. Nothing is kept
between calls — part 2 refetches the URL and splits it again — so the split has to be
deterministic on the text or consecutive parts would overlap or skip, and breaks land on
a line ending where one falls in the back half of the window so a decklist is never cut
through a card name. A part number past the end fails and names the real count. That is
a separate report from `truncated`, which means the download hit its byte cap and there
is text no part will ever reach.

Two accommodations come from measuring what Sonar actually cites. `www.reddit.com` is
rewritten to `old.reddit.com`, which serves the same thread as server-rendered HTML;
Reddit is the most-cited domain and the modern front end returns no readable text at
all. Hosts that build their pages in the browser are refused by name, YouTube above all:
it answers `200` with its cookie footer, so a plain fetch looks like it worked and
returns nothing.

A known site is read through its own data first, via `providers/web_sites.py`, and the
generic extraction above is what everything else gets. The renderer refusal runs after
that dispatch, so an adapter can claim a host a plain fetch cannot read.

An identical fetch is reused for `page_cache_seconds`. Pagination refetches by design, so
without it a five-part page is five identical downloads; with it, the parts of one read
come from one download and cannot disagree about where the boundaries are.

### `providers/web_sites.py`

Eight adapters behind `read_page`, one per site, from ADR 0041. Each matches a host and
path, fetches the structured thing behind it and renders readable text: EDHREC's
`json.edhrec.com` pages, Archidekt's deck API, MTGGoldfish's visual view — whose card
names live in `img alt` attributes, which is exactly what an HTML-to-text extractor
throws away — TappedOut's and Aetherhub's text exports, Commander Spellbook's variants
API, cEDHstat's decklists, and YouTube through oEmbed plus its watch page — where the
description is routinely where a deck tech keeps its decklist link.

Each adapter declares the card names it read from a card field, rather than those being
parsed back out of its own rendering, and `read_page` names any the local catalog does
not have. Names are normalised to the catalog's spelling first, because a site writes
`Ashnod’s Altar` with a curly apostrophe and the catalog stores a straight one.

This is deliberately not a tool of its own. The agent calls `read_page` with the URL it
already has, and the same pagination applies to a rendered decklist as to prose.

Every miss falls back. An unmatched path, an unparseable payload, a download the byte
cap cut, an endpoint that errors — each returns the page to the generic reader instead
of failing, so a site changing shape degrades rather than breaks. Adapters are handed a
getter bound to the fetcher, so an endpoint passes the same scheme, address and byte
checks as any other URL.

Each result's second line begins "Read from …", and the system prompt turns on it: a
summary's numbers may not be repeated as fact, while these are the site's own figures.
Card names are the exception either way and still go through `see_cards`. Nothing that
changes between two reads is rendered — Archidekt's view count is left out, because
pagination refetches and a moving number would shift every boundary after it.

### `providers/tagger.py`

Owns Scryfall's read-only Oracle-tag bulk request plus Tagger's website GraphQL
relationship request, session/CSRF handling, wire models, request pacing, and
bounded retry behavior. Both interfaces are undocumented, so their response
models do not cross the provider boundary.

### `providers/edhrec.py`

Owns the undocumented EDHREC commander-page JSON wire shape, response limits,
validation, deduplication, and commander-name slug normalization. Provider
objects do not cross this boundary.

### `card_catalog.py`

Discovers and streams Scryfall `default_cards` in either the JSON-array or the
line-delimited shape, builds temporary SQLite tables for all paper printings and
canonical Oracle cards, validates the result, and atomically installs it. The one
printing kept per Oracle card is the cheapest that is not a special version, per
`printing_selection` and ADR 0024. `SQLiteCardCatalog` reloads after a swapped
file's modification time changes.

### `tagger_catalog.py`

Builds the optional Tagger enrichment sidecar. It imports all Oracle-tag
memberships and Oracle-card relationships, preserves normalized columns plus
raw JSON, checkpoints completed source phases/pages, validates SQLite
integrity, and atomically installs only a complete database. Its read-only
runtime adapter groups one Oracle card's tags and every relationship class
Tagger publishes — similar cards, strictness, body, variants, related cards,
references and inverse references — for the lazy card-enrichment endpoint,
normalizing each edge's direction through a local inverse table. It also fuzzy-ranks
tag names, resolves stable tag IDs, and intersects Oracle memberships for
explicit UI-selected tag filters. During explicit sync, it also exposes a
bounded, deduplicated gameplay-concept snapshot and source metadata for
semantic document v2. It does not supply semantic scores, relationship
expansion, or an agent-editable filter.

### `edhrec_catalog.py`

Owns the 30-day on-demand cache, complete raw commander/theme payloads,
advertised theme metadata, normalized Oracle-ID associations, and
inclusion/synergy evidence. It also caches per-card similar-card lists, resolving
EDHREC's identifier-free names against the local catalog and retaining
unresolvable ones. It serializes fetches per commander/page and per card, and
converts every failure into an optional enhancement-unavailable outcome at the
search boundary.

### `search.py`

Owns:

- The one fuzzy-title search operation.
- Complete-catalog fuzzy ranking without a score threshold.
- The stricter preview-confidence score and active agentic handoff decision.
- Local Commander-legality, commander-identity, required card-type/subtype,
  tag, color, mana-value, and EUR filtering.
- Optional filter-only EDHREC inclusion ordering before pagination, with typed
  fallback status and unchanged local ordering on failure. Agentic
  inclusion/synergy ranking remains owned by `agentic_card_search.py`.
- Simple numbered pagination after filters.
- Score-ordered card results and trace evidence.

### `search_debug.py`

Builds one structured trace per search and appends complete JSON objects as
JSONL lines.

### `agentic_search.py`

Non-network guards for local-tool result limits and final candidate-subset
ranking. These prevent empty unconstrained tool requests, invented IDs, and
configured-bound violations while allowing irrelevant candidates to be
omitted.

### `agentic_card_search.py`

Executes local structured search, the two-call OpenRouter conversation with one
intervening tool, temporary numeric candidate IDs, relevant-subset validation,
debug adaptation, cached ranked batches, canonical continuation exclusions,
and user-triggered session expansion. Its narrow provider-boundary
compatibility layer preserves strict domain contracts while repairing known
serialization mistakes: nested JSON object strings, comma-joined alternative
types, and abstract type concepts that do not literally occur on printed type
lines. Type intersections remain `must_contain_all`; alternatives become
`must_contain_any`. It also discards stale runtime-owned `format` and
`legality` keys, which the interface owns exclusively.

That normalization layer is the only place a tool call is altered, and it
repairs schema shape rather than judging intent. Validated agent `types` and
`colors` reach local filtering unmodified; the system prompt, not runtime code,
teaches when a printed type belongs in a filter (ADR 0019). The validated
arguments and every repair remain visible in the debug trace.

### `deck_agent.py`

The conversational deck agent. Trims the posted transcript to the configured memory
window, keeping the newest end so the current question always survives, then runs a
bounded tool loop: up to `agent.tools.max_iterations` rounds of asking, running
whatever tools were requested, and asking again, followed by one completion that
advertises no tools so the turn always ends in prose. It validates that content came
back — a reasoning model can answer HTTP 200 with empty content beside a populated
`reasoning` field, which is a contract error rather than an answer — and sums what
every completion in the turn cost, counting any that reported no figure. On a turn
that asked for `debug`, each reported call also carries the arguments the model sent
and the exact text the tool returned, taken from the call that ran rather than
re-rendered, and truncated with a visible marker rather than silently cut (ADR 0030). It
emits a `deck_edit` event the moment `edit_deck` succeeds, and threads the posted history
log from the request into the toolbox so `read_history` can answer from it (ADR 0036).

### `deck_agent_tools.py`

The agent's seven tools (ADRs 0029, 0035, 0036, 0039 and 0040), six of them read-only
and five of them local. `search_web` and `read_page` are the only two that leave this
machine and the only two whose results are not authoritative; both are described at the
end of this section. `read_deck` is answered entirely from the
deck snapshot the browser posted with the turn, resolved against the local catalog so
names and types come from the catalog rather than the client; it returns the deck
grouped by primary type with short ids and no card text. Its one argument, `extra_info`,
adds a figure to every card line and a summary underneath — `mana` for printed costs and
the curve as a markdown table, `price` for EUR estimates and a total per section — and
neither is sent unless asked for (ADR 0039). `see_cards` resolves names,
ids or those short ids and reports only the requested details — rules, prices, Tagger
tags, every related-card list grouped by how the cards relate with each card named
once, EDHREC inclusion for this commander,
Commander legality. Every card renders as labelled, quoted fields in one fixed order
whatever order the details were asked for (ADR 0032). A tool that cannot answer returns
text the model can adapt to rather than raising, and an unreported price or inclusion is
stated as absent rather than rendered as zero.

`search_cards` is the search agent's own `LocalCardSearchTool` with the immutable half
of its input moved: for a panel search the interface owns colours, tags, a commander and
price bounds, and here the model writes all of them. `SearchCardsArguments` subclasses
`LocalCardSearchRequest` so the shared fields cannot drift, and adds only what the filter
panel used to decide — a `commander` object, `commander_legal_only` and
`exclude_cards_in_deck` — projecting them back into a plain request plus a
`CardSearchFilters` before calling the engine. The commander object separates its colour
identity, which is a hard filter, from its EDHREC evidence, which only sorts; omitting it
means there is no commander rather than falling back to the open deck's command zone, and
naming any other card in the catalog is how a question about a different commander is
answered. Results render through the same card block `see_cards` uses — rules text and a single
EUR estimate — under a header carrying only what the model could not have known: how many
cards matched against how many are shown, a colour identity that removed cards, and a
*missing* EDHREC lookup. The filters, the sort and the commander's name are not echoed
back, since they are still in the model's own tool call. A commander's EDHREC deck themes
are a `see_cards` detail rather than a header line, because a popular commander advertises
seventy of them (ADR 0035). Nothing in `agentic_card_search.py`
changed for it.

`edit_deck` and `read_history` are the two tools from ADR 0036. `edit_deck` resolves each
`DeckEditChange` against the posted snapshot and reports what the deck held **before**,
which changes were therefore no-ops, the resulting card count, and any warning the edit
introduced — accurate rather than proposed, because the snapshot is in the request, and
carrying none of the caller's own arguments. It drops a change the deck already satisfies
before emitting the edit, so a retried call cannot double-add. Only an unresolvable card
and an out-of-range quantity fail the call, and either fails all of it: colour identity,
the singleton rule and the hundred-card bound are **warnings**, because the board treats
them that way and an agent held to a stricter rule than the drag target is inconsistent
invisibly. Command-zone legality and group existence stay in the frontend's
`domain/deck.ts`, unduplicated, so the browser can and does refuse an emitted edit.
`read_history` renders the posted log newest session first with the actor as `You` and
`Me`, and a client that posted no history reads differently from a deck with no recorded
edits, because the two lead somewhere different. `read_deck`'s footer points at it only
when history is present.

`search_web` and `read_page` are the two tools from ADR 0040, and the only two that
leave this machine. `search_web` asks Perplexity `sonar` through `web_search.py` and
renders the answer as prose, its citations numbered beneath it in the order Sonar
returned them — its markers cite positionally, so the order is load-bearing — and an
offer to read any of them. `read_page` fetches one URL through `providers/web_page.py`, one part at a time: a long
document is split rather than cut off, and each part with a successor ends by naming the
call that fetches it. Seven deck sites are read through their own endpoints rather than
their markup (ADR 0041, `providers/web_sites.py`) — on MTGGoldfish the generic reader
returns a deck page containing no cards at all.
Both are advertised only when both can run, because a search that produces links is half
a tool without a way to follow them.

Every result from either ends with the same sentence: nothing in it has been checked
against the catalog. That is not decoration. The tier bake-off found Sonar reliably
right about mechanics and reliably wrong about identifiers — deck counts off by up to
128x, and a real card returned under a name that does not exist — and neither failure is
visible to a reader. The catalog remains the authority on every fact a card carries.

### `web_search.py`

One Sonar call per `search_web`, over its own `OpenRouterClient` so a five-second search
does not inherit the chat agent's three-minute deadline. Returns the summary, the
citations read off `message.annotations`, and what OpenRouter charged. An empty body
with `finish_reason: stop` is raised rather than returned — observed live, and a blank
tool result is indistinguishable from "nothing found".

### `agentic_search_debug.py`

Builds and validates complete agent traces, recursively redacts secrets, and
writes untruncated schema-version-2 records as JSONL.

### `semantic_index.py`

Renders title-resistant, face-aware gameplay document v2 with normalized
self-references, Magic-symbol explanations, and bounded deduplicated Tagger
concepts. It lazily loads the local FastEmbed ONNX model, atomically builds the
catalog-and-Tagger-coupled vector sidecar, embeds each intent, and cosine-scores
every hard-filtered candidate without a minimum threshold. Exact Tagger card
relationships remain a separate graph.

## Frontend Modules

### `domain/card.ts`

Provider-neutral card and search response types plus presentation-safe helpers.

### `domain/deck.ts`

Browser persistence schema, migration, group placement, primary card type, and
commander color-identity helpers. It also owns the current command-zone
composition policy: one copy of one commander by default, or two cards when
their Oracle text/type lines form a recognized legal Commander pairing.

Stable IDs:

```text
command_zone
unassigned
```

Persistence keys:

```text
manabase.deck-library.v2
manabase.active-deck.v1   # legacy migration only
```

### `domain/history.ts`

The deck edit log, as pure functions with no React and no storage (ADR 0036):
`deriveDeckDiff` takes a before/after pair of `Deck`s and returns the diff plus the card
payloads it needs, `invertDeckDiff` swaps every change's `before` and `after`,
`applyDeckDiff` replays a diff in either direction against a deck and a payload pool,
`appendToHistory` places an edit in a session, `pruneHistory` enforces both caps, and
`parseDeckHistory` validates what came back out of storage.

The design exists so that no mutation site declares its own diff. `useDeck`'s reducer
already holds the deck before and after every mutation, so the record is complete by
construction and inversion is free. It only holds if the diff models every field a `Deck`
can differ by, which is what the round-trip property table over the real mutators keeps
honest.

`DeckCardPlacement` carries an `index` so undoing a removal puts the card back where it
was, and that index is deliberately excluded from change detection: cutting one card from
a hundred shifts fifty-nine positions, and counting those would make every summary wrong.
Position is a restoration hint, not an edit axis.

`cards` is the payload pool — one `CardSearchResult` per printing rather than one per
change, populated only for a card entering or leaving the deck, with orphans collected on
write. That gives two different depths: undo reaches as far as pooled payloads
(`DECK_HISTORY_PAYLOAD_CAP`), reading reaches every retained session
(`DECK_HISTORY_SESSION_CAP`). Replaying an entry whose payload is gone returns a typed
refusal rather than a detail-less entry, so the reducer can announce it instead of being
stranded by a throw.

Persistence key:

```text
manabase.deck-history.v1
```

### `domain/cardSymbols.ts`

Splits card text into words and symbols, against Scryfall's symbol table rather than
against a regex's idea of what a symbol looks like — the distinction that tells `{T}`
from `{Sol Ring}` in agent prose (ADR 0034). `cardSymbols.generated.ts` beside it is
written by `npm run symbols:sync` along with the SVGs in `public/card-symbols/`; both
are committed and neither is edited by hand. `components/CardText.tsx` is the only
place that renders the result, and every card panel goes through it.

### `lib/api.ts`

Builds fuzzy GET and agentic POST requests, performs fetch calls, maps public
API errors, and validates the complete response at runtime. TypeScript types
alone are not treated as a network boundary.

### `hooks/useDeck.ts`

The current deck application service. It owns:

- Library creation and active selection.
- Confirmed deletion, safe last-deck replacement, and current-session restore.
- All deck mutations.
- Shared command-zone guards for adds, moves, and quantity changes.
- Deriving a diff for every mutation from the before/after pair the reducer holds, and
  appending it to the deck's durable history log with an actor (ADR 0036).
- `applyEdit(edit, actor)`, the one mutator that takes an actor and the one the agent's
  edits arrive through. The whole edit is one reducer action, one history entry and one
  undo step, and it is refused whole rather than applied in part. It answers with the
  outcome, because the reducer can refuse an edit and a caller that assumed otherwise
  would describe an intention.
- `undo`, which inverts the last recorded entry and applies it, so it survives a reload.
  It pops the entry rather than recording its inverse. `canUndo` is established by
  planning the undo through the real applier, not by counting entries.
- Archiving a deleted deck's history with the deck and restoring it with the deck.
- `localStorage` persistence, for the library and the history log.
- User-facing live-region announcements.

Components receive named operations rather than writing storage directly.

### `components/SearchDrawer.tsx`

Search query state, debounce, cancellation, filters, debug preference,
pagination, results, deck membership, pre-add legality warnings, fuzzy tag
selection, selected card preview, and the default-on single-commander EDHREC
enhancement control. An EDHREC-unavailable page renders an explicit fallback
alert while retaining its locally sorted cards. When a related card opens over
the drawer, the drawer remains mounted and inert so its query and results
survive.

### `components/DeckAgentPanel.tsx`

The deck agent in the reserved right column. Streams a turn: tool lines appear as
each call runs and the answer as it is written, with a caret while it does, then the
live copy is replaced by the committed turn (ADR 0031). Owns the composer (Enter sends,
Shift+Enter breaks a line), the pending and error states, **Reset chat**, and the
conversation's running cost while debug mode is on. A failed turn keeps its question
in the transcript so sending again retries with the context intact. The transcript
itself belongs to the deck rather than to the panel (ADR 0030). With debug mode on, a
tool call that carries payloads renders as a disclosure over its **Call** and
**Result** sub-boxes; one that does not stays a plain line, because an expander onto
an empty box would claim the payload was empty rather than absent.

A `deck_edit` event renders as its own applied-edit block — `Applied: +2 / −1` over the
names, in the past tense because it has been, with an **Undo** rather than a confirm
(ADR 0036). The block is stored as a summary rather than as the event, so a restored turn
reads without spending the chat's storage budget on card payloads. The panel writes it
from what `onDeckEdit` **answered**, never from the event: the reducer can refuse an edit
the backend was happy to emit, and a block built from the event would claim an edit that
never happened. A refusal renders the deck's own sentence and carries no Undo. The Undo
sits on the newest edited turn only, because `undo` reverses the deck's last recorded
change and an older block's Undo would promise that block's reversal and deliver a
different one.

### `hooks/useDeckAgentChats.ts`

One conversation per deck — turns, running spend, unpriced-call count and the unsent
composer draft — keyed by deck id and persisted under `manabase.deck-agent-chats.v1`
(ADR 0030). Holds the whole
store rather than one conversation, and takes the deck id on every mutator, so a reply
lands in the transcript it was asked in. `domain/agent.ts` owns the serializer, which
spends a fixed character budget newest-chat-first and newest-turn-first: tool payloads
are dropped before turns, and turns before the newest conversation, so the chat store
can never crowd the deck library out of browser storage.

### `hooks/useDebugMode.ts`

The interface-wide debug preference, persisted under `manabase.search-debug` and
passed from `App.tsx` to both the search drawer and the deck agent (ADR 0028).

### `components/SearchTracePanel.tsx`

Human-readable projection of the title matcher, ranked candidates, aliases,
scores, and filter outcomes. The summary line carries the round's duration and,
when the round called a model, its cost.

### `components/DeckBoard.tsx`

Visual/list rendering, grouping by derived card type under a permanent Command
zone heading, sorting, drag-and-drop, keyboard-accessible movement, and
deck-card actions. Every group is a drop target carrying a `DeckSection`, so a
drop is only ever a change of section (ADR 0037).

### `components/CardInspector.tsx`

Centered card-detail dialog content, Tagger enrichment, related-card
navigation, tag-to-search handoff, and the placement control. That control is
unconditional: it is the keyboard path to the command zone.

### `components/DeckHistoryPanel.tsx`

The recorded history as a list of diffs, newest first, marking where the deck
stands and jumping to any row (ADR 0038). Rendering only: `useDeck` plans the
replay, refuses a jump it cannot make in full, and announces why.

### `App.tsx`

Page shell, navigation rail, mobile toolbar, dialogs, menus, and composition of
deck and search services.

It also owns the two things only the browser can resolve about an agent edit (ADR 0036):
translating the wire shape into `useDeck`'s `DeckEdit` — taking each cut or moved card's
payload from the deck, and treating an absent `section` as *leave placement alone* rather
than as the mainboard — and reading the history log out of `localStorage` at the moment a
turn is **sent**, because the log is written by an effect after the render that changed
the deck, so a value captured in that render would be missing exactly the edit the
question is about. A translation that cannot resolve a card refuses the whole edit and
reports that refusal itself, since it is the only place that knows the edit got no
further.

## Card Identity

Two identifiers are required:

- `oracle_id`: gameplay identity. Use for singleton warnings and same-card
  comparisons across printings.
- `scryfall_id`: selected-printing identity. Use for image, set, collector
  number, price, exact deck entry, and quantity operations.

Do not collapse these into one ID.

## Deck Placement Model

The current frontend stores:

```text
Deck
  cards[]
    section: command_zone | mainboard
```

Rules:

- Placement is the section and nothing else. Custom groups and the per-card
  `categories` array that held them were removed in ADR 0037.
- Command-zone entries have quantity one.
- A second command-zone entry is accepted only for Partner, reciprocal Partner
  with, Friends forever, Choose a Background plus a legendary Background, or
  Doctor's companion plus a legendary Time Lord Doctor.
- A third command-zone entry is never accepted.
- Card-type grouping is derived from `type_line` and is not an edit axis: a heading a
  card falls under cannot be changed by changing the deck, only by changing the card.
- A stored deck carrying `custom_groups` or `categories` loads with both dropped and
  every card kept. Legacy maybeboard placement becomes `mainboard`.
- The agent names placement as a `zone` — `commander` or `deck` — which
  `_section_for_zone` resolves to a section in one place. An absent zone means "leave
  placement alone" and must never be resolved to `mainboard`.

## API Contract Coupling

`CardSearchPage` is deliberately mirrored:

```text
backend domain model
  -> FastAPI response
  -> frontend TypeScript interface
  -> frontend runtime validator
  -> frontend unit fixture
  -> E2E fixture
```

Changing only one layer causes either server validation failures or frontend
"malformed response" errors. Treat this as one atomic contract change.

The optional EDHREC addition is represented on every page by `edhrec.status`,
`edhrec.source`, and `edhrec.message`. Request context uses
`commander_oracle_id`, `enhance_with_edhrec`, and optional `edhrec_theme`; it
does not enter the immutable hard-filter model or become agent-editable. The
separate commander-context endpoint exposes EDHREC's advertised theme slugs and
deck counts to the drawer.

## Error Boundaries

- Missing, incompatible, or unreadable local catalog becomes HTTP 503 with
  `card_search_unavailable`.
- Missing Tagger data becomes HTTP 503 only for enrichment or an explicit tag
  filter; untagged card search remains available.
- A missing, stale, or dimension-incompatible semantic sidecar becomes an
  agentic HTTP 503; fuzzy title search remains usable.
- A model response that still violates the normalized local-tool contract
  becomes HTTP 502 with `agentic_search_contract_error`, preserving the failed
  debug trace without claiming the provider is unavailable.
- EDHREC transport, payload, printing-to-Oracle mapping, or sidecar failures do
  not become search HTTP errors. Blank browsing returns local order and agentic
  search retains semantic order, with `edhrec.status="unavailable"` so the
  drawer can show the degraded state.
- Invalid min/max pairs become HTTP 422.
- An empty catalog or page beyond its end returns an empty successful page.
- Disabled/full `localStorage` does not make the active deck unusable; current
  memory state continues.

## Current Versus Target Architecture

Current:

```text
Browser localStorage owns decks and their edit history, and is the only thing that
  applies an edit
FastAPI owns card discovery
Local SQLite owns canonical search reads and cached enrichment
Scryfall owns authoritative bulk data and remote images
EDHREC optionally supplies cached commander/theme pages for browsing and agent ranking
```

Target:

```text
React UI and agent
  -> typed backend deck/search services
  -> SQLite deck store and derived Scryfall catalog
```

The migration must preserve browser-local libraries and must not allow the
future agent to bypass deck validation or mutation history.
