# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added

- Built the local-first React, TypeScript, Vite, FastAPI, and Pydantic
  application on development ports `41737` and `43127`.
- Added a browser-local Commander deck library with deck creation, switching,
  inline renaming, commander-art thumbnails, card quantities, custom groups,
  sorting, and 30-step session undo.
- Added visual and dense-list layouts, Custom and derived Card types grouping,
  pointer/touch/keyboard card movement, drop-to-create groups, and responsive
  desktop/mobile workflows.
- Added singleton and commander color-identity warnings before and after card
  additions.
- Added selected-printing card art, rules, legality, finish availability, daily
  Scryfall EUR estimates, deck/group totals, and Cardmarket verification links.
- Added a streaming, timestamp-aware Scryfall `default_cards` importer that
  retains paper printings, creates canonical Oracle-card rows, validates a
  temporary SQLite database, and installs it atomically.
- Added complete-catalog RapidFuzz title ranking for exact names, partial
  segments, and typos, with no result threshold or candidate-pool cap.
- Added local color-identity, colorless, mana-value, and EUR filters plus
  six-card numbered pages.
- Added coverage-aware title confidence for the agentic routing decision and
  debug-only result labels while preserving WRatio as broad ranking evidence.
- Added progressive agentic card search through OpenRouter: confident fuzzy
  previews remain visible, the model calls exactly one structured
  `search_local_cards` tool, then returns a validated relevant subset of local
  numeric candidate IDs.
- Added local agent-tool conditions for name, Oracle text, mana symbols, types,
  colors, power/toughness, price, format legality, sets, and rarities.
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
- Added an animated agentic-search loading state and larger search-result cards.
- Added debug-only fuzzy traces and a focused seven-step agent trace: system
  prompt, user input prompt, thinking, tool call, tool response, final thinking,
  and output response.
- Added append-only, untruncated, secret-redacted JSONL search diagnostics with
  raw model and tool payloads.
- Added backend, frontend, smoke, production-build, and Playwright coverage.
- Added architecture, search, development, implementation-status, decision, and
  contributor documentation.

### Changed

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

- Preserved alias-aware title confidence when fuzzy previews are replaced by
  agent-ranked results.
- Prevented extra unmatched query words from inheriting an inflated token-match
  confidence, while keeping useful partial-title behavior such as `green`
  matching titles that contain `green`.
- Repaired simple model shorthand such as
  `{"types":"Elf","oracle_text":"untap"}` into exact local conditions instead
  of treating it as disabled semantic search.
- Retained sanitized seven-step traces when an agentic search fails, with the
  broken step marked as an error and later steps marked skipped.
- Kept **Load more** available after fuzzy and agentic exhaustion and prevented
  duplicate displayed or previously considered cards in continuation rounds.

### Repository

- Initialized the project as a private personal GitHub repository.
