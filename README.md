# MTG Agentic Deck Builder

A private, local-first Commander deck builder with a React frontend and a
FastAPI card-discovery backend. The shipped product is a fast manual deck
editor with progressive agentic card search, beside a deck assistant that
inspects the deck, explains suggestions, searches the catalog, and edits the deck
through the same domain operations as the UI. Its edits apply themselves and are
undoable from a durable per-deck history.

## Project Status

The first manual editing slice is usable and tested.

| Area | Status |
| --- | --- |
| Card search and filters | Shipped |
| Fuzzy title scores and traces | Shipped |
| Browser-local deck library | Shipped |
| Durable per-deck edit history, with back, forward and a jump to any diff | Shipped |
| Custom groups and derived card types | Shipped |
| Color-identity and singleton warnings | Partial validation |
| Backend deck persistence | Not implemented |
| Local SQLite card catalog | Shipped |
| Local Scryfall Tagger sidecar | Shipped for details, filters, relationships, and embedding concepts |
| On-demand EDHREC commander/theme ranking | Shipped for browsing and agentic search |
| Import/export and analytics | Not implemented |
| Progressive one-tool agentic card search | Shipped |
| Deck agent chat | Shipped, desktop only, streamed, one saved conversation per deck |
| Deck agent read-only tools | Shipped: `read_deck` (with `extra_info` for costs, the curve and prices), `see_cards`, `search_cards`, `read_history` |
| Deck agent web research | Shipped: `search_web` on Perplexity `sonar` with its sources, `read_page` for a plain fetch of one, paginated so a long page is read on rather than cut off — leads only, never card data |
| Deck site parsers | Shipped: EDHREC, Archidekt, MTGGoldfish, TappedOut, Aetherhub, Commander Spellbook, cEDHstat and YouTube read through their own endpoints behind `read_page`, with any miss falling back to the generic reader. A fetched decklist's names are checked against the local catalog |
| Deck agent deck editing | Shipped: `edit_deck`, auto-applied, one undo step per edit |
| Backend-enforced deck mutation and confirmed patches | Not implemented, and not the direction — see ADR 0036 |

Read [`docs/implementation-status.md`](docs/implementation-status.md) before
starting feature work. It is the canonical boundary between shipped, partial,
and planned behavior.

## Experience

The application currently supports:

- Create, switch, inline-rename, confirm-delete, and session-restore local
  Commander decks.
- Use commander art as the deck thumbnail.
- Search exact, partial, segmented, and misspelled card titles through one
  fuzzy workflow.
- Continue weak-title and natural-language queries through one bounded agent
  tool call and a structured final ranking.
- Inspect coverage-aware title-confidence percentages beneath results in debug
  mode.
- Filter by color identity, colorless, mana value, Scryfall EUR estimate,
  required card types, fuzzy-found subtypes, and fuzzy-found Tagger labels.
- Keep Commander-legal and commander-color-identity restrictions active by
  default, with explicit opt-in switches for exceptions.
- Enhance browsing and agentic search with default-on EDHREC commander
  evidence, optional deck themes, inclusion, and synergy.
- Add cards into the command zone or the deck.
- Drag a card onto Command zone to make it the commander, and onto any card-type
  heading to put it back in the deck. The card inspector has the same control.
- Group the deck by derived card type, which is the only grouping there is.
- Switch between a stacked visual view and a dense list. In the stack each card shows
  only its own printed top — its name and mana cost, as the card prints them — and the
  one you point at or tab into opens, pushing the rest of the column down. Its copy count
  is a badge outside the corner, and its price sits under it once it is open.
- Drag a card by its art: onto a group to move it there, into the chat to put its name in
  the composer. Hover a card the agent named to see its picture and its EUR estimate.
- Sort by name, mana cost, or price. Mana cost is the default: value first, then how
  many coloured pips, then WUBRG, so a stacked column reads as the curve.
- Step back, forward, and straight to any recorded diff from the History panel between
  the two buttons — including after a reload, because the position is stored with the log.
- Edit quantities, remove cards, and undo — including after a reload, because undo
  replays a durable per-deck history rather than an in-memory stack.
- Ask the agent to make the change instead. It applies straight to the board, as one
  undo step, and the transcript keeps an **Undo** beside what it did.
- See singleton and commander color-identity warnings.
- Keep the command zone to one copy of one commander unless a second card forms
  a legal Partner, Partner with, Friends forever, Choose a Background, or
  Doctor's companion pair.
- Inspect rules, printing, finish availability, legality, and price in a modal.
- See local Scryfall Tagger labels and related cards in both search previews
  and deck card details.
- Open related cards in the normal card dialog without losing the current
  search, or click a tag to start a tag-filtered search.
- Export the deck as plain text, an MTG Arena list, or CSV — copy it, download it, or
  open a TCGplayer cart already holding every card. The plain-text list is what
  Cardmarket's wants import and TCGplayer's Mass Entry both take.
- Use a purpose-built desktop shell and mobile deck-action toolbar.

Deliberate UX choices:

- There is no persistent search field. **Add cards** opens the focused search
  popup and is the single add workflow.
- There is no standalone maybeboard in the active editor.
- Card-type grouping is derived and cannot be edited.
- The right side is not used for a permanent card inspector; it belongs to the
  deck agent, which now occupies it as a chat panel on desktop.

These decisions are recorded in
[`ADR 0005`](docs/decisions/0005-editor-grouping-and-inspection.md).

## Quick Start

### Prerequisites

- Node.js 22.12 or newer.
- npm.
- [`uv`](https://docs.astral.sh/uv/).
- Google Chrome for Playwright E2E tests.

Docker is not required.

### Install

```bash
git clone git@github.com:andreasvig/MTG-agentic-deck-builder.git
cd MTG-agentic-deck-builder
npm run setup
cp .env.example .env
npm run catalog:sync
```

Title search works without an API key. Natural-language agentic search requires
`OPENROUTER_API_KEY` in `.env`.

The first catalog sync also downloads the local embedding model and builds the
semantic sidecar for every card. Later syncs skip both artifacts when current.

Optionally acquire Scryfall Tagger's Oracle-card tags and relationships:

```bash
npm run tagger:sync
```

This explicit, resumable command writes
`local-data/card-tagger.sqlite3`. Card details read it lazily, and explicitly
selected tag filters intersect its Oracle-card memberships. The command also
rebuilds the semantic sidecar when needed so the v2 gameplay documents include
the current bounded, deduplicated Tagger concepts. Exact Tagger relationships
remain outside the embedding text.

The mana and ability symbol artwork is already in the repository, so nothing needs
running for card text to draw its symbols. Refresh it only when Wizards prints a new
one:

```bash
npm run symbols:sync
```

It rewrites `frontend/public/card-symbols/` and the generated manifest beside the
module that reads them, and is idempotent — the diff is empty until Scryfall's symbol
set actually changes.

### Run

```bash
npm run dev
```

- Frontend: <http://127.0.0.1:41737>
- Backend health: <http://127.0.0.1:43127/api/v1/health>
- OpenAPI: <http://127.0.0.1:43127/api/v1/openapi.json>

The root runner checks that both uncommon ports are free and shuts down both
reload-enabled development processes on `Ctrl+C`.

## Architecture Snapshot

```text
React browser application
  |- deck library, mutations, derived edit history and undo, localStorage
  |- applies the agent's resolved deck edits; the backend never mutates a deck
  |- editor, search drawer, trace viewer, responsive shell
  |
  | HTTP JSON
  v
FastAPI
  |- strict provider-neutral contracts
  |- local SQLite card catalog
  |- lazy card-detail Tagger enrichment and explicit tag filtering
  |- bounded Tagger concepts in semantic document v2
  |- 30-day on-demand EDHREC commander/theme cache and ranking evidence
  |- uncapped RapidFuzz title scoring and local filters
  |- local semantic vector sort with no relevance cutoff
  |- one-tool OpenRouter search continuation
  |- append-only search diagnostics
  |
  +--> Scryfall default_cards (refresh command only)

Explicit Tagger sync
  `--> local-data/card-tagger.sqlite3 (details, filters, embedding concepts)

On-demand EDHREC commander/theme pages
  `--> local-data/card-edhrec.sqlite3 (raw JSON, themes, normalized rows)
```

Current ownership is important:

- The frontend owns decks and their edit history in `localStorage`, and is the only
  thing that applies an edit — the agent's included.
- FastAPI owns card discovery only.
- Scryfall is the authoritative source for catalog refreshes and card images.
- The derived SQLite card catalog owns canonical search reads; optional EDHREC
  commander evidence remains in its own disposable sidecar.
- SQLite deck storage remains target architecture, not current implementation.

See [`docs/architecture.md`](docs/architecture.md) for module ownership,
contracts, data identities, failure behavior, and the migration target.

## Search

Every query uses one local fuzzy card-title matcher. It compares the normalized
input against the SQLite catalog with RapidFuzz `WRatio`, ranks every canonical
card without a score threshold or candidate cap, applies local filters, and
returns the requested six-card page. Filters enforce Commander legality and
the current deck commander's color identity by default; the interface can
explicitly include exceptions. Selected card types, subtypes, and Tagger labels
are ANDed as immutable filters. **Load more** requests the next numbered page. It remains
available at the end of fuzzy or agent-ranked results; the next explicit click
then runs one continuation agent round with all displayed cards excluded.
Typed search makes no Scryfall request. With one commander selected,
blank-query browsing and agentic search enable EDHREC evidence by default.
The user may select one advertised deck theme. Fresh snapshots are cached for
30 days; a failed fetch visibly falls back to local or semantic ordering.
There is no EDHREC bulk-sync step: the ignored sidecar retains only commander
and theme pages requested by this local deck workflow. The control is disabled for a
two-commander command zone.

For example, `forest` returns Forest first at 100%, followed by partial-title
matches such as Forest Bear and Misty Rainforest at about 90%. A typo such as
`galta` matches Ghalta titles at about 91%.

The values live in [`config.yaml`](config.yaml):

```yaml
search:
  title_match:
    page_size: 6
```

The full scoring contract is in [`docs/search.md`](docs/search.md) and
[`ADR 0007`](docs/decisions/0007-single-fuzzy-title-search.md).

The progressive agentic phase is active. It keeps confident title matches
visible, shows an animated ranking state, calls exactly one structured local
catalog tool when the first page is under-filled, and ranks only known
candidate IDs. Fuzzy previews are selectable before the tool call and include
mana, type, power/toughness, Oracle text, and EUR price. Tool candidates receive
later temporary IDs (`1`, `2`, `3`, and so on), exact Oracle-card duplicates
reuse the preview ID, and the model may omit irrelevant results. See
[`ADR 0009`](docs/decisions/0009-progressive-one-tool-agentic-search.md).

Inside that tool, structured card conditions are hard filters.
`semantic_sort` is non-filtering evidence; `sort_by` selects a weighted blend of
semantic closeness and EDHREC inclusion, semantic closeness alone, EDHREC
inclusion, or EDHREC synergy as the primary ordering, and defaults to the blend.
No ranking value has a threshold. The
agent prompt includes examples for recovering intent from imperfect queries.
Type filters compare literal printed type-line fragments: combinations such as
Artifact Creature use separate `must_contain_all` values, while alternatives
such as Instant or Sorcery use `must_contain_any`. Broad requests such as
late-game card draw do not receive an invented type restriction.

The agent owns its `types` and `colors`: validated filters reach the local tool
unmodified. Rather than stripping them afterwards, the system prompt teaches
when a printed type is the right filter. Functional categories that span
several types — removal, ramp, sweepers, draw, tutors, protection — stay in
`semantic_sort`, while definitional and typal terms such as mana rock
(Artifact) or elves (Elf) justify a hard filter. Commander legality, deck
identity, and all selected interface filters are applied separately and never
copied into the validated tool call. A narrow provider-boundary compatibility
layer repairs safe shorthands and records each repair in the debug trace.
See [`ADR 0010`](docs/decisions/0010-always-on-semantic-sort.md),
[`ADR 0012`](docs/decisions/0012-immutable-commander-and-tagger-filters.md),
and
[`ADR 0019`](docs/decisions/0019-prompt-taught-agent-filters.md).

## Debug Mode

Open **Settings** in the editor toolbar and enable **Debug mode**. The browser
stores the preference locally. It governs the search trace and the deck agent's
running cost together.

The inline trace viewer exposes:

- The title-confidence percentage beneath each returned card.
- The matching algorithm, catalog count, filtered count, and page range.
- Matched aliases, original ranks, WRatio scores, and title confidence for the
  current page.
- A chronological seven-step agent trace showing only system prompt, user input
  prompt, thinking, tool call, tool response, final thinking, and output
  response.
- Failed agent runs keep that trace visible, open the broken step with
  sanitized provider evidence, and mark later steps as skipped.
- The exact compact tool message sent to the model alongside the untouched raw
  tool JSON.
- What the round cost, beside its duration, taken from the provider's reported
  `usage.cost`. A local fuzzy search shows no figure because it called no model.

**Escape abandons a turn** from anywhere in the agent panel. Cancel within ten seconds
and the question comes back to the composer, out of the transcript, so it can be fixed
and asked once — unless the turn has already changed the deck, in which case it stays
where it is as the record of why.

The deck agent panel shows the running cost of the current conversation in its
header while debug mode is on. A turn that used tools paid for several model
calls, and the header totals all of them; a `+` means at least one call reported
no price, so the total is a floor rather than the whole bill. **Reset chat**
clears it with the transcript.

Every tool the agent runs is shown in the transcript as its own small line above
the answer — `read_deck()`, `see_cards(Sol Ring, Cultivate · inclusion, tags)`,
`search_cards(mana rock, ramp · weighted · Atraxa, Praetors' Voice)` —
regardless of debug mode, because what the agent read is part of the answer.
While debug mode is on, that line opens onto two sub-boxes: the arguments the
model sent, and the exact text the tool returned. Only a turn asked with debug
mode on carries them, so lines from earlier turns stay plain rather than opening
onto nothing.

An edit is reported the same way, in the past tense, because by the time it renders the
board already looks different: `Applied: +2 / −1` over the card names, with an **Undo**
rather than a confirm. The block says what the deck *did*, not what the agent asked for —
the editor can refuse an edit the agent was allowed to send, such as an illegal second
commander, and then the block carries the deck's own reason and no Undo.

The backend also appends one complete JSON object per line:

```text
local-data/search-debug.jsonl
```

Read the complete log:

```bash
jq -s '.' local-data/search-debug.jsonl
```

Read the latest route and fuzzy evidence:

```bash
tail -1 local-data/search-debug.jsonl |
  jq '{request, decision, fuzzy: .stages[-1].details.fuzzy_candidates}'
```

Credentials and authorization headers are never written.

Normal search behavior is configured in `config.yaml`; `.env` remains for
runtime and debug overrides.

## Development Commands

```bash
npm run setup
npm run catalog:sync
npm run tagger:sync
npm run symbols:sync
npm run dev
npm test
npm run build
npm run test:e2e
npm run test:smoke
```

Focused checks:

```bash
uv --directory backend run pytest
uv --directory backend run ruff check src tests
npm test --prefix frontend
npm run build --prefix frontend
```

`npm test` runs the backend and frontend suites plus the paired-process smoke
test.

`npm run test:e2e` starts the app on the default ports and requires them to be
free. Stop a running development session first.

See [`docs/development.md`](docs/development.md) for the environment table,
test matrix, common change workflows, troubleshooting, and pre-commit checks.

## Project Layout

```text
AGENTS.md              Repository-specific agent instructions
backend/
  src/mtg_deck_builder/
    api/               HTTP translation
    domain/            Strict public/domain contracts
    providers/         Scryfall and provider boundaries, plus web_page.py (one page
                       as text) and web_sites.py (deck sites via their own endpoints)
    config.py          Validated runtime settings
    main.py            FastAPI lifecycle and dependencies
    search.py          Fuzzy title matching
    search_debug.py    JSONL trace construction
    deck_agent.py      Conversational deck agent and its tool loop
    deck_agent_tools.py  read_deck, see_cards, search_cards, read_history, edit_deck,
                         search_web, read_page
    web_search.py      Perplexity Sonar search, with its citations
    semantic_index.py  Local embedding index and cosine sorting
  tests/               Backend contract and behavior tests
frontend/
  src/
    components/        Editor, search, dialogs, trace UI, the pixel icon set
    dev/               Dev-only surfaces; `#icons` opens the icon contact sheet
    domain/            Card/deck contracts and migrations
    hooks/             Deck, chats, health, and debug-mode application state
    lib/               HTTP client and response validation
  public/              Static assets
e2e/                   Playwright workflows and fixtures
scripts/               Root process runner and smoke test
docs/
  decisions/           Architecture decision records
  architecture.md      Current runtime and module boundaries
  development.md       Commands and contributor workflows
  implementation-status.md
  search.md            Search technical contract
plan.md                Product scope and roadmap
changelog.md           Notable delivered changes
```

## Data Identity And Persistence

- `oracle_id` is gameplay identity.
- `scryfall_id` is selected-printing identity.
- Deck libraries use `manabase.deck-library.v2`.
- The previous `manabase.active-deck.v1` key is migration input only.
- Debug mode uses `manabase.search-debug`, kept under its original name now that
  it covers the deck agent too.
- Deck agent conversations use `manabase.deck-agent-chats.v1`, one per deck id.
  The store keeps the twelve most recently used decks inside a fixed character
  budget, dropping tool payloads before turns, so it can never crowd the deck
  library out of browser storage.
- Deck edit history uses `manabase.deck-history.v1`, one log per deck id, sharing that
  same storage quota. Card payloads are pooled one per printing rather than one per
  change, which is why undo can restore a removed card's price and validation inputs
  without storing kilobytes per edit. Two caps mean two different things: undo reaches as
  far as the pooled payloads, and reading reaches every retained session.
- Placement is a section: command zone or deck. A deck saved before ADR 0037 opens
  with every card intact and its custom groups dropped, since the board now groups by
  derived card type and a stored group name has nowhere to appear.

The browser-local persistence decision and backend migration requirements are
recorded in
[`ADR 0004`](docs/decisions/0004-browser-local-deck-library.md).

## Current Limitations

- No backend deck API, SQLite persistence, or cloud synchronization.
- No complete single-commander eligibility, special-case Commander rules, or
  Rule Zero override model.
- No persisted price history or true Cardmarket trend integration.
- No full printing/finish chooser.
- No plaintext import/export.
- No deck analytics.
- The deck agent streams its turns, but not its reasoning: at `xhigh` effort most of
  a turn is thinking, so the panel reports that it is thinking rather than narrating it.
- The deck agent's panel is desktop-only. It can read the open deck (`read_deck`), look
  cards up (`see_cards`), search the whole catalog under filters it writes itself
  (`search_cards`), read what has already been done (`read_history`), search the open web
  for brews and write-ups (`search_web`), read one of those pages (`read_page`) and change
  the deck (`edit_deck`) — but not everything an edit could be. It sets the count a card should be
  at and which of the two zones it sits in, it does not reorder anything, and Partner and
  background command zones are unhandled here as they are in the other tools.
- Deck history is browser-local and per deck, so it does not survive a browser wipe and
  is not readable across devices. There is no branching: stepping back and then editing
  discards what came after, as every undo stack does.
- Search returns one representative printing per gameplay card: the cheapest one
  that is not a full-art, promo, foil-only or Secret Lair version. There is no
  way to ask for a specific printing.
- Scryfall images remain remote.

The recommended implementation order is maintained in
[`docs/implementation-status.md`](docs/implementation-status.md) and
[`plan.md`](plan.md).

## Agent And Contributor Handoff

Coding agents must read [`AGENTS.md`](AGENTS.md) before editing this repository.
It defines:

- Current boundaries and product invariants.
- Search and persistence traps.
- Required test tiers.
- Contract synchronization rules.
- Documentation and ADR expectations.
- Definition of done.

Decision history begins at
[`docs/decisions/README.md`](docs/decisions/README.md).

## Documentation

- [Documentation index](docs/README.md)
- [Implementation status](docs/implementation-status.md)
- [Current architecture](docs/architecture.md)
- [Development guide](docs/development.md)
- [Search system](docs/search.md)
- [Decision records](docs/decisions/README.md)
- [Product plan](plan.md)
- [Changelog](changelog.md)
- [Archidekt UX benchmark](docs/archidekt-ux-benchmark.md)

This is a private personal repository. Do not add public accounts, hosted
collaboration, tracking, or deployment infrastructure unless the product scope
changes explicitly.
