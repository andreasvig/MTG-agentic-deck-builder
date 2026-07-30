# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added

- Built the local-first React, TypeScript, Vite, FastAPI, and Pydantic
  application on development ports `41737` and `43127`.
- Added a browser-local Commander deck library with deck creation, switching,
  inline renaming, commander-art thumbnails, card quantities, custom groups,
  sorting, and 30-step session undo.
- Added confirmed deck deletion with deterministic active-deck fallback,
  automatic replacement of a deleted final deck, and current-session restore.
- Added visual and dense-list layouts, Custom and derived Card types grouping,
  pointer/touch/keyboard card movement, drop-to-create groups, and responsive
  desktop/mobile workflows.
- Added singleton and commander color-identity warnings before and after card
  additions.
- Added one-copy command-zone enforcement across adds, moves, and quantity
  edits. A second commander is accepted only for legal Partner, reciprocal
  Partner with, Friends forever, Choose a Background, or Doctor's companion
  pairings; third commanders are rejected with visible feedback.
- Added selected-printing card art, rules, legality, finish availability, daily
  Scryfall EUR estimates, deck/group totals, and Cardmarket verification links.
- Added a streaming, timestamp-aware Scryfall `default_cards` importer that
  retains paper printings, creates canonical Oracle-card rows, validates a
  temporary SQLite database, and installs it atomically.
- Added an explicit resumable Tagger importer and atomic
  `card-tagger.sqlite3` sidecar containing normalized Oracle-card tags,
  complete tag memberships, relationship directions/statuses, descriptions,
  and raw source payloads.
- Added lazy Tagger enrichment to search previews and deck card details.
  Similar and referenced cards now open in the normal card dialog at quantity
  zero without replacing the current search.
- Added clickable tags that open tag-only search, fuzzy tag lookup, removable
  multi-tag chips, and AND-based Oracle-membership filtering.
- Added default Commander-legal and current commander-color-identity
  restrictions with independent opt-in exception switches. These and selected
  tags remain immutable across fuzzy, agentic, and continuation searches.
- Added semantic document v2: card titles are excluded by default,
  self-references and Magic symbols are normalized, multi-face data is rendered
  once, and capped/deduplicated Tagger gameplay concepts enrich the local
  vectors. Exact Tagger relationships remain outside dense-vector ranking.
- Made both catalog and Tagger syncs atomically refresh semantic vectors when
  their source snapshot or document configuration changes.
- Added complete-catalog RapidFuzz title ranking for exact names, partial
  segments, and typos, with no result threshold or candidate-pool cap.
- Added local color-identity, colorless, mana-value, and EUR filters plus
  six-card numbered pages.
- Added immutable required card-type toggles and fuzzy local subtype lookup.
  Multiple selected types and subtypes use AND semantics and remain active
  through fuzzy, agentic, and continuation searches.
- Added coverage-aware title confidence for the agentic routing decision and
  debug-only result labels while preserving WRatio as broad ranking evidence.
- Added progressive agentic card search through OpenRouter: confident fuzzy
  previews remain visible, the model calls exactly one structured
  `search_local_cards` tool, then returns a validated relevant subset of local
  numeric candidate IDs.
- Added an always-on local FastEmbed sidecar using
  `BAAI/bge-small-en-v1.5`. Structured conditions filter first; `semantic_sort`
  cosine-orders every survivor without a minimum score before the result limit.
- Made `catalog:sync` atomically maintain both the Scryfall-derived catalog and
  its model/field/catalog-versioned semantic vectors.
- Expanded the tool schema and system prompt with explicit filter-versus-sort
  semantics, conservative intent recovery, canonical Magic wording, and
  worked examples for imperfect natural-language and misspelled queries.
- Prevented broad requests such as late-game card draw from becoming impossible
  type intersections. The agent now omits unrequested type constraints, uses
  separate OR values for type alternatives, and defensively repairs
  comma-joined or abstract type conditions at the provider boundary. Nested
  tool objects accidentally serialized as JSON strings are decoded there too.
- Added local agent-tool conditions for name, mana symbols, types, colors,
  power/toughness, price, sets, and rarities.
- Added multiset exact matching so duplicate symbols such as `["{X}", "{X}"]`
  remain meaningful.
- Added natural model prompts with selectable fuzzy-preview IDs and
  URL-free card details including mana, type, power/toughness, EUR estimate, and
  Oracle text.
- Added in-memory agent-search sessions. **Load more** serves cached ranked
  batches first, then starts one explicit continuation round after exhaustion.
- Added continuation prompts containing all visible cards, local exclusion of
  displayed and previously examined Oracle cards, retryable empty rounds, and
  per-session serialization.
- Added the normalized `0-1` semantic closeness beneath every semantically
  sorted candidate in the clean tool message sent to the final ranking model.
- Added prior local-tool request history to every later continuation prompt.
  Load-more rounds now explicitly ask the agent to change or broaden its earlier
  strategy while preserving the request and immutable interface filters.
- Added an animated agentic-search loading state and larger search-result cards.
- Added debug-only fuzzy traces and a focused seven-step agent trace: system
  prompt, user input prompt, thinking, tool call, tool response, final thinking,
  and output response.
- Added append-only, untruncated, secret-redacted JSONL search diagnostics with
  raw model and tool payloads.
- Added backend, frontend, smoke, production-build, and Playwright coverage.
- Added architecture, search, development, implementation-status, decision, and
  contributor documentation.
- Added default-on EDHREC enhancement for blank-query/filter-only browsing with
  one selected commander. Commander pages are fetched on demand, cached for 30
  days as raw and Oracle-normalized data, and sorted by raw inclusion before
  six-card pagination.
- Added a typed EDHREC enhancement result and clear drawer error when fetching
  or normalization fails; local card results remain usable in their normal
  order.
- Added cached EDHREC commander deck themes with an optional **All commander
  decks** / theme selector in Find Cards.
- Added selected commander, advertised themes, and selected theme to the
  agent's immutable user-prompt context.
- Added candidate-level EDHREC inclusion, deck counts, and raw synergy to the
  local tool response, plus semantic, inclusion, and synergy primary sorts
  without score cutoffs.
- Added a semantic-only agentic fallback and visible unavailable status when
  commander/theme evidence cannot be fetched.

### Changed

- Made Commander legality and format exclusively runtime-owned and removed them
  from the agent tool schema. The trace now discards stale model-supplied copies.
- Rewrote the agent system prompt as Markdown with a `# Task` / `# Inputs` /
  `# Output` / `# Tools` / `# Guidelines` skeleton and moved every rule into it.
  The user message and tool-result message are now labelled data sections with
  no instructions, the tool description is one line, and schema field
  descriptions state shape only, so no surface can contradict the prompt
  (ADR 0020).
- Made the agent own its own `types` and `colors`. Validated filters now reach
  the local tool unmodified, and the system prompt teaches when a printed type
  is the right filter: cross-type functional categories such as removal, ramp,
  sweepers, and tutors stay semantic, while definitional and typal terms such as
  mana rock or elves justify a hard filter. This replaces the pre-execution
  guard that required the type word to appear in the query, which deleted
  correct filters for ordinary Commander vernacular (ADR 0019).
- Removed the exact Oracle-text field from the agent search tool. Rules text
  remains embedded for semantic retrieval and visible to the ranking model,
  without allowing invented wording to eliminate valid cards.
- Reduced agent prompt theme context to the ten most-played EDHREC theme names;
  the interface still exposes the complete theme list.
- Limited frontend **Title confidence** badges to completed straight fuzzy
  searches; progressive previews and agent-ranked results keep the score only
  in API/debug evidence.
- Removed the inverse **Referenced by** relationship list from card details
  while retaining the underlying enrichment data for future use.
- Made derived Card types the default editor grouping while keeping Custom as
  the explicit mode for functional groups and drag/drop.
- Replaced live per-query Scryfall search with local SQLite reads. Scryfall now
  supplies explicit catalog refreshes and remote card images only.
- Replaced the former layered exact/fuzzy/intent/embedding/reranker pipeline
  with one local fuzzy-title phase followed, when needed, by the one-tool
  agentic phase.
- Reduced search pages from 12 cards to six.
- Made **Add cards** the single entry point and removed the persistent main
  search field.
- Replaced fixed editable categories and the standalone maybeboard with
  permanent Command zone/Not assigned groups plus user-created custom groups.
- Replaced the persistent right-side inspector with a centered desktop card
  dialog and contained mobile dialog, reserving the workspace edge for a future
  deck assistant.

### Fixed

- Normalized compact agent color identities such as `WUBG` and empty provider
  placeholders into the local tool's strict schema, and report remaining model
  contract failures as truthful HTTP 502 errors instead of
  provider-unavailable HTTP 503 errors.
- Preserved alias-aware title confidence when fuzzy previews are replaced by
  agent-ranked results.
- Prevented extra unmatched query words from inheriting an inflated token-match
  confidence, while keeping useful partial-title behavior such as `green`
  matching titles that contain `green`.
- Retained sanitized seven-step traces when an agentic search fails, with the
  broken step marked as an error and later steps marked skipped.
- Kept **Load more** available after fuzzy and agentic exhaustion and prevented
  duplicate displayed or previously considered cards in continuation rounds.

### Repository

- Initialized the project as a private personal GitHub repository.
