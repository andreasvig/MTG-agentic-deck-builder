# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added

- **A cancelled agent turn keeps the work it already did.** Escape before the first
  event still hands the question back; after a tool, prose or edit, the transcript keeps
  those lines with an interrupted marker and the next turn receives the completed calls
  and results in provider-shaped replay. Deck-dependent results are substituted if the
  deck moved, missing old payloads degrade to a framing-only sentence, and a committed
  cross-side fixture corpus now feeds the browser's real request builder to the backend's
  real validator (ADR 0045).

- **A running agent turn belongs to its deck.** Switching decks leaves it working and
  up to three decks can run at once. The rail marks only background turns; replies,
  failures, cost and edits land in the conversation and deck that started them, and a
  background edit names the deck it changed (ADR 0045).

- **A deck can leave, in a shape a shop can read.** An **Export** button in the editor
  toolbar opens a dialog holding the generated list: **plain text** (`1 Sol Ring`),
  **MTG Arena** (`1 Sol Ring (CMM) 396`, with `Commander` / `Deck` headings), and **CSV**
  (quantity, name, set, collector number, EUR). Copy it, download it, or open a
  **TCGplayer** cart already holding the deck. Cardmarket's import is behind a login and
  has no public link, so that one gets the list plus the name of the page that takes it.
  The plain-text format carries **no section headings on purpose**: a shop parses every
  line as a card to sell you, so a `Commander` heading is a card called "Commander" and
  the whole paste fails on it (ADR 0044). A double-faced card exports to Arena by its
  front face; a split card keeps both halves, because `Wear // Tear` is its printed name.

### Changed

- **A column is ordered by what its cards cost, and that is now the default sort.** Mana
  value first, then how many coloured pips the cost has, then those pips in WUBRG order —
  so at any one value every single-pip cost sits together and every double-pip cost after
  them, and cards costing exactly the same thing are always adjacent. Mana value alone
  left the curve in name order, which puts `{2}{G}` between two `{G}{G}` cards. It is the
  default because a stacked card shows its own printed top, and that band is the name
  *and* the cost: the curve is now readable straight down the column. A hybrid or
  Phyrexian symbol counts as one coloured pip and files under the earliest of its halves,
  so `{G/W}` and `{W/G}` are the same shape; a split card's shape comes from its front
  face, because its mana value does.

- **The interface is printed on paper.** Cream stock, one monospace face, hairline rules
  instead of drop shadows, flat tint blocks instead of glows, and nothing rounder than
  3px — the sheet `ai-plays-pokemon`'s control center uses, re-inked with green as the
  house ink. The sidebar was the app's one dark surface and is now a recessed well on the
  same sheet. What this buys is contrast where it matters: with the chrome desaturated,
  the card art, mana symbols and set symbols are the only saturated things on screen, and
  they keep their own colour and their own printed corner. 252 frontend tests and all 15
  end-to-end tests pass unmodified, which is the evidence that this is a re-skin.

- **Every icon is hand-drawn pixels; `lucide-react` is gone.** Thirty-nine glyphs set as rects
  on a 12x12 grid — half the usual resolution on purpose, so they read as printed marks
  rather than as small tidy line art. The brand mark is the colour pie: five pips wired
  into a pentagon, which is the diagram a manabase is a choice about. Because a glyph
  that is fine at 26px can be mush at 11, `#icons` in the dev server opens a contact
  sheet of the whole set at every size the app ships, plus an 8x blow-up on the grid.

### Added

- **Escape cancels the open deck's turn from anywhere in the panel.** Sending keeps the
  composer focused so the key reaches the conversation even after clicking Send. The old
  ten-second proxy is gone; the event boundary above now decides whether the question is
  returned or the interrupted work is kept.

- **The visual board stacks, and a card can be carried into the chat.** Each card is
  overlapped by the one below it so all that shows is the band across its top that the
  card prints its own name and mana cost on, and the card under the pointer opens by
  pushing the rest of the column down. A land column is now readable at once instead of
  thirty pictures deep. Which card is open is not state: the pull-up is a percentage
  margin, which resolves against the column's *width* and is therefore the only way a
  card's aspect-ratio height is expressible in CSS, and the opening is `:hover +` /
  `:focus-within +`. Nothing the application draws sits on that band — the count is a
  badge outside the top-left corner, any warning outside the top-right, and the quantity
  controls and price are a row *beneath* the open card. A card is picked up by its own
  art, and the drag means two things depending on where it is let go: dropped on a group
  it moves there, dropped anywhere on the agent panel it puts the card's name in the
  composer at the caret, spaced against the words either side of it. And hovering a card
  the agent named now shows its EUR estimate under the picture — the one number the agent
  is instructed never to repeat out of a web summary (ADR 0042).

- **The deck agent can reach the open web.** `search_web` runs one Perplexity `sonar`
  search and returns its prose with the citations numbered beneath it in Sonar's own
  order, because its inline markers cite positionally. `read_page` fetches one of those
  URLs as text, paginated rather than truncated: every part with a successor ends by
  naming the exact call that fetches the next, so a long primer is read on rather than
  cut off. The tier was chosen by measurement — about $0.006 and five seconds a call,
  against $0.056 and 26 seconds for `sonar-pro-search` reaching the same conclusions.
  Every web result ends by saying nothing in it has been checked, because the bake-off
  found Sonar reliably right about mechanics and reliably wrong about identifiers: deck
  counts off by up to 128x, and a real card returned under a name one letter wrong
  (ADR 0040).
- **YouTube, a fetch cache, and a catalog check on every fetched decklist.** `read_page`
  now reads a YouTube video through oEmbed and its own description rather than refusing
  it — 17% of what a Magic search cites is video, and on a deck tech the description is
  where the decklist link lives. An identical fetch is reused for `page_cache_seconds`
  (120 by default), which turns walking EDHREC's five-part Sol Ring page from five
  identical 137 KB downloads into one and stops the parts of a read from disagreeing
  about their own boundaries. And each adapter now declares the card names it read from
  a card field, so `read_page` can name the ones the local catalog does not have —
  normalising typographic punctuation first, without which *Ashnod's Altar* and
  *Lim-Dûl's Vault* are both scored as fabrications. Search results mark which sources
  can be read in full. `pytest -m live` checks every adapter against the real endpoints
  and is excluded from the default run (ADR 0041).
- **Seven deck sites are read through their own data rather than their pages.** EDHREC,
  Archidekt, MTGGoldfish, TappedOut, Aetherhub, Commander Spellbook and cEDHstat now go
  through adapters behind `read_page` — not a new tool, so the agent keeps calling
  `read_page` with the URL it already has. This is a correctness fix, not a tidy-up: on
  MTGGoldfish the card names live in `img alt` attributes, which an HTML-to-text
  extractor discards, so the generic reader returned a deck page with the price, the
  type counts and **no cards at all**. EDHREC's real inclusion figures are now read from
  its own API instead of being restated by a model. Any miss — an unmatched path, an
  unparseable payload, a capped download — falls back to the generic reader, so a site
  changing shape degrades rather than breaks (ADR 0041).
- **The deck agent can now edit the deck, and its edits apply themselves.** `edit_deck`
  takes one declarative change per card — the copy count you want *afterwards*, so add is
  `1`, cut is `0`, a move is the same count with a new group — plus one reason per call
  that history keeps. The change lands as a single undo step and the transcript shows an
  applied-edit block in the past tense, `Applied: +2 / −1` over the names, with an
  **Undo** rather than a confirm. There is no proposed diff and no confirmation step: the
  durable history log is the safety net, and an applied edit shows up in the next turn's
  deck snapshot so the agent can verify its own work instead of asking (ADR 0036).
  Stating a target count rather than an operation is what makes the call idempotent, so a
  retry cannot double-add.
- Added a durable per-deck **edit history** under `manabase.deck-history.v1`, and rebuilt
  undo on top of it. Undo now survives a reload, which the thirty-step in-memory snapshot
  stack it replaces could not — that was the one real weakness of letting an agent edit
  apply itself. Every entry carries a time, an actor and a summary, and an agent edit
  carries the model's own reason; edits group into sessions by actor and a three-minute
  gap, so an agent's stretch of editing never merges into the user's. A deleted deck's
  history is archived with the deck and restored with it (ADR 0036).
- Gave the deck agent `read_history`, so it can read what has already been done to the
  deck — the last sessions newest first, the actor as **You** and **Me**, and each agent
  session's stated reason. "What did we change earlier?" is now a question it can answer
  from the record rather than from the transcript (ADR 0036).
- Made `read_deck` report a quantity-weighted **mana curve** and a **total EUR price**
  without being asked. Both adopt the on-screen statistics' conventions exactly — price
  over every card including the command zone, average mana value over neither the command
  zone nor anything with `Land` in its type line — so the tool and the interface cannot
  give two different correct answers. A card with no EUR estimate is excluded and counted
  in words rather than silently read as free, which is what the sidebar total does.
- Gave the deck agent a third read-only tool, `search_cards`, so it can find cards
  that are neither in the deck nor named in the conversation. It reuses the search
  agent's `LocalCardSearchTool` unchanged and writes every filter itself, including a
  `commander` object that separates the colour-identity gate (a hard filter) from
  EDHREC inclusion and synergy (which only sort) — so a question about a commander
  other than the one in the command zone is a single tool call. Omitting the commander
  means there is no commander rather than inheriting the open deck's. Results render
  through the same card block `see_cards` uses — rules text and one EUR estimate —
  under a two-line header carrying only what the model could not have known: how many
  cards matched against how many are shown, a colour identity that removed cards, and a
  missing EDHREC lookup (ADR 0035).
- Added `themes` to `see_cards`: the deck themes EDHREC tracks for a card as a
  commander, most played first with the deck count behind each, which are the slugs
  `search_cards` takes as `commander.edhrec_theme`. Only a card that can legally be a
  commander has an EDHREC page, so for anything else the detail says so explicitly
  rather than reporting a bare absence (ADR 0035).

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
- Added a `weighted` primary sort and made it the agent's default ordering. It
  averages semantic closeness and EDHREC commander inclusion using the weights
  in `search.agentic.ranking.weighted`, renormalizes over whichever signals a
  run has, and needs no commander evidence, so a commanderless search orders
  exactly as `semantic` did (ADR 0021).

- Surfaced every card relationship Scryfall Tagger publishes. The reader
  previously grouped only similar cards and reference directions and discarded
  10,214 of 18,421 stored edges (55%), including all 8,985 strictness edges. Card
  details now show Upgrades, Outclasses, Creature versions, Spell versions,
  Variants and Related cards alongside the existing groups, with direction read
  from a local inverse table rather than the feed's own `classifierInverse`
  (ADR 0025). No re-sync or re-embed is needed.
- Added EDHREC similar cards to card details, fetched per card on demand and
  cached in the existing EDHREC sidecar (schema 3) under a dedicated
  `edhrec.similar_refresh_after_days`, 180 days by default, because a functional
  similar-card list only moves when new cards are printed. EDHREC publishes six
  names with no identifiers, so names are resolved against the local catalog by
  exact name with a front-face fallback. That resolution is re-derived on every
  read rather than cached with the names, so `catalog:sync` repairs a suggestion
  that could not previously be opened; unresolved names are kept in the stored
  list but omitted from the interface links (ADR 0026).
- Added the deck agent to the reserved right side of the workspace: a chat panel
  with conversation memory and a **Reset chat** control in its header. The
  transcript lives in the browser and is posted back on every turn, so the
  backend keeps no chat session and `agent.max_history_messages` is the whole of
  the agent's memory. Configured under a new top-level `agent:` block in
  `config.yaml`, on `openai/gpt-5.6-luna` at `xhigh` reasoning effort with a
  180-second timeout of its own (ADR 0027). Desktop only for now.
- Gave the deck agent two read-only tools, and made every call it makes visible in
  the chat as its own small line above the answer — `read_deck()`,
  `see_cards(Sol Ring, Cultivate · inclusion, tags)` (ADR 0029).
  - `read_deck()` lists the open deck grouped under each card's primary type, with
    names, short ids and the custom group each card sits in on screen, and no card
    text at all — a hundred-card deck with full Oracle text would be a large and
    mostly irrelevant payload on every turn.
  - `see_cards(cards, details)` takes names or those short ids and reports only the
    detail asked for: rules text, daily prices, Scryfall Tagger gameplay tags,
    EDHREC similar cards, EDHREC inclusion for this deck's commander, or Commander
    legality. It defaults to rules, so an EDHREC lookup happens only on request.
  - Both tools only read. The agent still cannot add, remove or move a card, and it
    has no catalog search of its own.
  - The backend holds no deck, so the browser now posts a deck snapshot alongside
    the transcript, carrying identity and placement only. Names, types, rules and
    prices are resolved from the local catalog rather than trusted from the client,
    and a printing the catalog does not know is reported rather than dropped.
  - A turn is up to `agent.tools.max_iterations` rounds of tool use followed by one
    completion that advertises no tools, so a model that would keep calling them
    still has to answer. A tool that cannot answer — missing catalog, sidecar or
    EDHREC page — returns text the model adapts to and a marked line in the chat,
    rather than failing the turn.
  - Both tool descriptions live in `config.yaml` under `agent.tools` beside the
    system prompt, because they are the only thing telling the model when a tool is
    worth calling.
- Gave every deck its own saved conversation. Switching decks switches chat, and
  coming back to a deck comes back to what was already said about it, running spend
  included; **Reset chat** now clears one deck's conversation and no other's. The
  store is persisted under `manabase.deck-agent-chats.v1` beside the deck library, so
  a reload no longer forgets the chat (ADR 0030).
  - ADR 0030 initially abandoned a reply in flight when the deck changed. ADR 0045
    supersedes that boundary: the running turn now belongs to its deck just as the saved
    conversation does, so switching views leaves it working.
  - The chat store spends a fixed character budget newest-chat-first and
    newest-turn-first: tool payloads are dropped before turns, turns before the newest
    conversation, and only the twelve most recently used decks are written at all. The
    deck library shares the same browser-storage quota and holds every card's full
    payload, so an unbounded chat store would eventually have stopped *decks* from
    saving.
  - The composer's unsent draft belongs to the deck as well: a half-written question
    about one deck no longer follows the user to the next one, and it survives a reload
    with the rest of the conversation.
  - A deleted deck's conversation is deliberately kept, so the delete's **Undo**
    restores a working chat.
- Made every card the agent names an actual card. The agent now writes each name in
  braces, the backend resolves them against the local catalog, and the chat renders
  them as underlined names: hovering shows the card image, clicking opens the same
  inspector the deck board uses (ADR 0033).
  - Resolution is the backend's because braces already mean mana in Magic — the agent
    quotes rules text, so `{T}` and `{C}{C}` appear in answers, and only the catalog
    can say that no card is called `T`. It also corrects the agent's casing to the
    printed name and matches a double-faced card by its front face.
- Drew mana and ability symbols wherever card text appears instead of printing the
  notation they are stored as: `{2}{G}{G}` in a deck row, `{T}: Add {G}.` in a rules
  box, and both in the agent's answers (ADR 0034).
  - One component renders all of it — deck list, deck board, search results and
    preview, card inspector, search trace, agent chat — sized in `em`, so a cost reads
    the same at 9px in a row and at body size in a sentence.
  - A braced run is a symbol because Scryfall's symbol table lists it, which is what
    tells `{T}` from `{Sol Ring}` in prose. Anything unlisted is left exactly as
    written, braces and all, because the meaning of a cost lives in its braces.
  - `npm run symbols:sync` brings the 84 symbol SVGs and their manifest into the
    repository, both committed. Rules text is symbol-dense and the whole set is
    ~360 KB, so it is served from this origin rather than hotlinked — the same
    sync-once-then-read-offline shape the catalog and Tagger sidecar already use.
  - A name the catalog does not recognise renders as plain words, never as stray
    braces, and without the underline that promises a click will do something.
  - Card links are stored with the transcript, so a restored conversation stays
    clickable, and images are fetched on hover and cached per message.
  - `**bold**` and `*italic*` now render instead of showing their asterisks, since
    turning text into nodes for card names made it a few lines rather than a project.
- Rewrote how `see_cards` presents a card, since its output is the prompt the model
  reasons from (ADR 0032). Every field is now labelled and every free-text value
  quoted — `Name: "Ghalta, Primal Hunger"`, `Types: "Legendary", "Creature"`,
  `Rules: "Trample"` — instead of one run-on heading the model had to read
  punctuation to parse, on a card whose own name contains a comma and a dash.
  - `similar` now reports every related-card list the local data holds, grouped by how
    the cards relate and labelled the way the card panel already labels them — Upgrades,
    Similar cards, Creature versions, Spell versions, Outclasses, Variants, Related
    cards, References. An upgrade is not a variant, so the grouping is the point; empty
    groups print nothing.
  - Each card is named once, under the group that says the most about it. Tagger's
    similar cards and EDHREC's similar cards are merged into one deduplicated list, and
    a card that is an upgrade, an outclassed card, a variant or another version of this
    one is dropped from that list and read only under its own heading. Cross-references
    are deliberately exempt: a card can be both similar and named in the rules text.
  - The two sources are independent: EDHREC being switched off still leaves Tagger's
    groups, a missing sidecar still leaves EDHREC's list, and the gap is named once.
  - Details are reported in one fixed order — rules, legality, prices, tags,
    inclusion, similar — whatever order they were asked in, so the card's own facts
    come before the related-card list and a detail asked for twice is reported once.
    The order is applied in one place, so the tool line in the chat and the body the
    model reads cannot disagree, and it is checked against `CardDetail` at import
    because a forgotten detail would silently never be reported.
  - Only the card-type side of a type line is split into separate values: subtypes can
    be two words, and a double-faced type line is reported as printed.
- Streamed the deck agent's turns. Each tool call now appears in the chat the moment
  it runs, and the answer appears as the model writes it, with a caret marking where
  the next characters will land (ADR 0031). On a measured Ghalta turn the first tool
  line went from invisible to 8.1s and the second to 10.2s, against a turn that
  previously showed nothing at all until 11.4s.
  - `POST /api/v1/agent/chat/stream` sends `tool`, `text`, `done` and `error` events.
    Everything the interface keeps comes from `done`, which carries exactly the reply
    the JSON route returns, so what a turn costs, stores and replays does not depend on
    which route produced it.
  - Text written before a tool call is preamble rather than the answer, so it is
    superseded when the call appears. That keeps the streamed view converging on the
    message that is actually committed instead of quietly changing at the end.
  - One loop serves both routes; only the transport differs. Streaming stays inside the
    existing OpenRouter boundary, reading the connection line by line in worker threads
    rather than adding an HTTP dependency, and reassembles tool calls from the pieces a
    stream sends them in. Cost needs `usage: {include: true}`, which was verified live
    not to conflict with `provider.require_parameters`.
  - The interface now uses the streaming route only. The frontend's plain-JSON client
    method was removed rather than left as an untested fallback; `POST /agent/chat`
    remains the plain API contract.
  - Reasoning is deliberately not streamed: at `xhigh` effort it is most of the turn
    and none of the answer.
- Made a tool call openable while debug mode is on. The line becomes a disclosure over
  two sub-boxes — the arguments the model sent, and the exact text the tool returned —
  the same shape as the search trace's nested layers (ADR 0030). ADR 0045 makes both
  payloads ordinary traffic because an interrupted turn may need to replay them; debug
  mode still controls the disclosure, and answered turns shed their payloads first when
  storage is tight. An oversized payload is bounded with a visible marker, while the
  model's original tool execution still read the whole result.
- Added what the agents cost, taken from the provider's own `usage.cost` rather
  than from token arithmetic. The search trace shows the price of that round
  beside its duration, including for a round that failed after paying for a call,
  and the deck agent totals the current conversation in its header. A turn that
  used tools paid for several completions, and the header totals all of them. A
  cost the provider did not report is never shown as free: a local fuzzy search
  shows no badge at all, and a chat total missing any unpriced model call is
  marked `+` (ADR 0028, ADR 0029).

### Changed

- **The deck agent is told it has no tools on its last pass, and gets fifteen rounds
  instead of four.** The final completion of a turn advertises no tools so the turn
  always ends in prose — but taking the toolbox away silently is not an instruction to
  answer, and what the model did instead was write the call it wanted into the answer:
  `to=search_local_cards` followed by an arguments object, which is its own routing
  syntax with the provider's special tokens stripped. Measured against
  `openai/gpt-5.6-luna`: 5 of 5 forced final passes leaked, 0 of 3 once the pass carried
  one sentence saying there are no tools left, while the same conversation *with* tools
  advertised was clean 4 of 4. The leaks also burned three to seven times the completion
  tokens of the answers that replaced them. Should one arrive anyway, it is now a
  contract error rather than an answer, on the same footing as a reply with no content
  at all (ADR 0029).

- **A card on the visual board has no drag handle: it is dragged by its own art.** The
  handle used to sit over the card, which on a stacked card means over the one band of it
  that is always on screen — the band the card prints its name across. The cost is worth
  stating: the visual board's drag is now the browser's own, and a native drag has no
  keyboard equivalent, so moving a card between groups without a pointer is the list
  view's job or the inspector's placement control. Both were already the keyboard path to
  the command zone.

- Replaced the deck editor's thirty-step in-memory undo stack with the durable diff log.
  Undo now inverts the last recorded entry and applies it instead of restoring a whole
  deck snapshot, which is why it survives a reload. The trade is honest and worth knowing:
  depth is now bounded by the pooled card payloads rather than by a step count, so an entry
  can be readable in history and no longer replayable — announced when it happens, never
  silent (ADR 0036).

- Moved debug mode out of the card-search drawer and into interface-wide
  **Settings** in the editor toolbar, since it now governs both the search trace
  and the deck agent's running cost. The `manabase.search-debug` storage key is
  unchanged, so an existing preference is preserved (ADR 0028).

- Switched the search agent to `openai/gpt-5.6-luna` at `low` reasoning effort,
  and made both `reasoning_effort` and `temperature` configurable instead of
  hardcoded. Three provider incompatibilities had to be resolved: the model has no
  `temperature` endpoint, so the key is now omitted when unset rather than sent as
  null; the tool no longer claims `strict`, which requires every property to appear
  in `required` while every field here is optional; and the advertised tool schema
  drops the numeric-string alternative Pydantic renders for `Decimal`, whose regex
  uses a negative lookahead that OpenAI's schema validator rejects. Together these
  fix agent tool calls emitting nested objects as truncated strings, which was
  returning zero results for queries such as "cheap mana rocks".

- Changed catalog printing selection from the newest printing to the cheapest
  **ordinary** one, so a card no longer shows up as its full-art, Secret Lair or
  promo version. Ranking is image, then a price, then not special, then cheapest.
  30.8% of priced cards were previously represented by a dearer printing than
  their cheapest, median 1.62x, and 897 cards were wrongly excluded from a €1
  price filter. What counts as special is configuration in `printing_selection`;
  a card with no priced ordinary printing falls back to its cheapest special one.
  Catalog schema version 3, so an installed catalog rebuilds itself
  ([`ADR 0024`](docs/decisions/0024-cheapest-ordinary-printing-selection.md)).
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
- Replaced the agent tool's `name` substring filter with `name_sort` plus a
  `name_similarity` ordering. Naming a card now ranks by fuzzy title similarity
  and removes nothing, so a misspelling no longer empties the page: five of ten
  measured attempts such as `thassas oracle` and `sol ing` previously returned
  zero candidates. The two fields require each other, and name similarity stays
  out of the `weighted` blend (ADR 0023).
- Removed the `sets` and `rarities` fields from the agent search tool and its
  prompt. Both described a printing rather than gameplay identity and invited an
  invented code or a "best means mythic" filter that silently emptied the page.
  Set, collector number, and rarity remain visible on cards, and the tool's
  model-facing property set is now pinned by a test (ADR 0022).
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

- **A card with no image no longer breaks its column.** The art box carries the 488 × 680
  ratio itself rather than inheriting it from the picture, so a printing the catalog has no
  art for holds its height instead of collapsing to the placeholder's while the pull-up
  still subtracts a whole card — which used to haul every later card in that column up out
  of it.

- Fixed a crash that took the whole deck board down for a deck holding a card with no
  cached details. `getCardPrice` dereferenced `card.prices` with no guard, and the
  statistics memo passed the entry through an `as` cast that laundered `undefined` past the
  type checker, so the price total threw inside a `useMemo`. Reachable with no agent and no
  edit involved: a deck persisted by an older build hydrates into exactly that state.

- Fixed EDHREC slugs for card names containing an apostrophe. `edhrec_slug`
  mapped the apostrophe to a separator, producing `thassa-s-oracle`, while EDHREC
  closes the gap and serves `thassas-oracle`; the separated form answers HTTP 403.
  This had been breaking EDHREC enrichment for 2,344 catalog cards and 189 legal
  commanders, among them Yuriko, the Tiger's Shadow. A test that had pinned the
  broken output now pins the reachable slug.

- Fixed bulk catalog sync against Scryfall's current API, which replaced the
  JSON-array export with line-delimited JSON, dropped `download_uri`,
  `content_type` and `size` from the bulk listing, and serves the body as
  `application/gzip` with no `Content-Encoding` header. Discovery now accepts
  either shape and the URI suffix decides compression and format.
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
