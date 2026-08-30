# Frontend

React 19 and TypeScript interface for the local Commander deck builder.

Read [`../AGENTS.md`](../AGENTS.md),
[`../docs/architecture.md`](../docs/architecture.md), and
[`../docs/implementation-status.md`](../docs/implementation-status.md) before
changing deck persistence or editor structure.

## Run

Normally use the root runner:

```bash
npm run dev
```

Frontend-only:

```bash
npm run dev --prefix frontend
```

The browser API base defaults to:

```dotenv
VITE_API_BASE_URL=http://127.0.0.1:43127/api/v1
```

## Source Map

```text
src/
  App.tsx                     Shell, navigation, dialogs, mobile toolbar
  components/
    DeckBoard.tsx             Grouping, sorting, cards, movement
    SearchDrawer.tsx          Search workflow and filters
    SearchTracePanel.tsx      Backend trace inspection
    DeckAgentPanel.tsx        Per-deck streamed chat and applied-edit transcript
    MarkdownText.tsx          Bounded deck-brief Markdown rendering
    ExportDeckDialog.tsx      Copy, download, and TCGplayer export surface
    CardInspector.tsx         Centered card details and placement control
    DeckHistoryPanel.tsx      Recorded diffs, and travel to any of them
    CardArt.tsx               Remote art with fallback
    ConnectionStatus.tsx      Backend health state
  domain/
    card.ts                   Search/card types and helpers
    deck.ts                   Persistence schema, migration, warnings
    agent.ts                  Chat storage, snapshots, SSE event validation
    history.ts                Derived diffs, history cursor, replay planning
    markdown.ts               Bounded deck-brief parser
    export.ts                 Pure deck serializers
    cardSymbols.ts            Synced mana/ability symbol tokenization
  hooks/
    useDeck.ts                Deck application service, history and travel
    useDeckAgentChats.ts      Persisted per-deck chats, drafts, cost and replay
    useDebugMode.ts           Shared search/deck-agent debug preference
    useBackendHealth.ts       Health polling
    useMediaQuery.ts          Responsive state
  lib/
    api.ts                    URL construction, fetch, runtime validation
  test/
    fixtures.ts               Shared deterministic fixtures
```

## Current State Ownership

Deck libraries live in browser `localStorage`:

```text
manabase.deck-library.v2
```

The frontend reads the legacy key only for migration:

```text
manabase.active-deck.v1
```

Related browser-owned state is also per deck:

```text
manabase.deck-history.v1     # diff log and current history cursor
manabase.deck-agent-chats.v1 # transcript, draft, replay payloads and cost
```

`useDeck.ts` is the only current mutation boundary. Components receive named
operations for:

- Add card.
- Set quantity and remove.
- Move card between the command zone and the deck.
- Create and select deck.
- Rename deck.
- Replace the shared deck description.
- Apply one agent card edit or deck-text edit atomically.
- Travel along the recorded history: back, forward, or straight to a named edit.

Deck deletion is confirmed and current-session recoverable through
`useDeck.ts`. Add any further mutation through the same service rather than
introducing component-local mutations.

Keep mutation announcements meaningful for assistive technology.

## Editor Invariants

- Card search is the single add workflow.
- The board groups by derived card type, under a permanent Command zone heading.
  There is no grouping control and no user-created group (ADR 0037).
- A card moves along one axis only: into the command zone or back into the deck.
- Card types are derived from card data and cannot be edited.
- No standalone maybeboard.
- Card details are a dialog, not a persistent right inspector.
- The right workspace belongs to the desktop deck agent and is hidden below 860px.
- Mobile uses the deck-action toolbar rather than shrinking desktop navigation.
- Illegal commander color identity is warned before and after add.
- Command-zone cards have quantity one. A second is allowed only for a
  recognized legal co-commander pairing, and a third is rejected.
- The shared brief is one current 2,000-character source string. Its read view uses
  only ADR 0047's bounded Markdown subset; raw HTML, links, images and arbitrary
  embedded content are not syntax.

## Deck Agent Contract

- One persisted conversation, draft, cost total, and running turn per deck under
  `manabase.deck-agent-chats.v1`.
- The browser posts the deck's name, description, revision, card identities,
  placement, and bounded history with every turn; the backend stores no deck.
- `deck_edit` and `deck_text_edit` events are proposals only until `useDeck` applies
  them. Transcript blocks are built from the store's outcome, never from the event's
  claim.
- A description-only Pydantic event carries `name: null` on the real SSE wire. The
  validator treats `null` and omission as the same absence and tests the serialized
  producer shape.
- Agent edits target the deck that started the turn even after the user switches decks.
  A visible brief update expands the open deck's brief and marks it **Updated by agent**.
- Answered turns commit from `done`; interrupted turns retain the tool calls, partial
  prose, and applied edits that already streamed. Deck-dependent replay is rejected when
  its recorded revision is stale.

## Search Contract

The browser validates every fuzzy and agentic search response at runtime in
`lib/api.ts`. When fuzzy search returns `agentic_required`, the drawer retains
the confident preview cards, shows an animated agentic-loading banner, and
POSTs the same query and immutable filters to `/cards/search/agentic`. The
final response replaces the preview. Later pages include `search_session_id`,
so **Load more** first reads stored ranking batches without a new model run.
After those batches are exhausted, the next explicit click starts one
continuation round with every visible card supplied as **Already showing**.

`Title confidence N%` from `title_confidence_scores` appears only while debug
mode is enabled on a completed straight fuzzy search. Progressive previews
awaiting the agent and final agent-ranked pages do not render the badge. The
scores remain available in response and trace data and stay alias-aware after
agentic reranking, including short pre-comma aliases such as `Ghalta`.

The agent user prompt treats already-visible fuzzy cards as selectable
candidates. Their reserved IDs do not overlap with later local-tool cards,
except that the same Oracle card deliberately reuses its preview ID. Each
preview includes mana, type, power/toughness, Oracle text, and EUR price.
Structured tool fields filter locally; `semantic_sort` only orders the
surviving candidates and never applies a score cutoff. With EDHREC evidence,
`sort_by` may instead make inclusion or synergy primary while keeping semantic
closeness as evidence and a tie-breaker.

Card-type toggles and fuzzy subtype lookup add immutable required filters.
Multiple selected card types and subtypes use AND semantics, so Artifact plus
Creature finds artifact creatures and Elf plus Druid finds Elf Druids. The same
values are sent unchanged through fuzzy, agentic, and continuation requests.

With exactly one commander selected, **Enhance with EDHREC** is checked by
default and makes an empty-query/filter-only request meaningful. The backend
sorts that page by cached commander inclusion. A deck-theme selector loads the
commander's advertised EDHREC themes and defaults to **All commander decks**.
Typed agentic requests pass the commander and selected theme as immutable
context; the tool returns inclusion and synergy and may use either as its
primary sort. An unavailable EDHREC response is still a successful search
page: the drawer renders a clear failure message and keeps local/semantic
results usable. The controls are disabled with no commander or two commanders
because the current contract accepts one `commanderOracleId`.

`CardSearchPage.edhrec` is always present. The runtime validator accepts
`not_requested`, `applied`, or `unavailable`, with `cache`/`network` source
evidence only when applicable. Do not turn `unavailable` into the drawer's
global search-error state.

The debug viewer presents agentic execution as exactly seven chronological,
color-coded stages: system prompt, user input prompt, thinking, tool call, tool
response, final thinking, and output response. It omits duplicated request
envelopes, request context, validation plumbing, log metadata, and full-trace
JSON. The tool-response stage shows the exact simplified plain-text message
sent to the model with IDs `1..N`, plus the untouched raw tool JSON.

When the backend changes `CardSearchPage`, update:

- `domain/card.ts`.
- `lib/api.ts`.
- `test/fixtures.ts`.
- `../e2e/fixtures/cards.ts`.
- Components that consume the field.
- Unit and E2E assertions.

## Deck Identity

- Use `oracle_id` to recognize the same gameplay card across printings.
- Use `scryfall_id` for selected printing, quantity, image, set, and price.
- Placement is `section`: `command_zone` or `mainboard`.
- A stored deck's `custom_groups` and per-card `categories` are dropped on load, and
  legacy or maybeboard placement becomes `mainboard`. No card is lost.

## Tests And Build

```bash
npm test --prefix frontend
npm run build --prefix frontend
```

From the root:

```bash
npm run test:e2e
```

Test ownership:

- `domain/deck.test.ts`: storage validation, migration, placement, warnings.
- `domain/history.test.ts`: diff round trips, cursor travel, pruning, text fields.
- `domain/agent.test.ts`: chat storage, deck snapshots, and exact SSE event shapes.
- `domain/markdown.test.ts` and `domain/export.test.ts`: brief parsing and serializers.
- `lib/api.test.ts`: request encoding, errors, runtime response validation.
- `components/SearchDrawer.test.tsx`: filters, debug, scores, progressive
  loading.
- `components/SearchTracePanel.test.tsx`: readable content across exactly seven
  agentic trace stages.
- `components/DeckAgentPanel.test.tsx`: streamed turns, replay, per-deck ownership,
  writing events, cost, and failure states.
- `App.test.tsx`: primary deck/editor integration behavior.
- `e2e/deck-builder.spec.ts`: real browser workflows with deterministic API
  fixtures.

Responsive UI changes require desktop and `390x844` inspection. Check:

- No horizontal overflow.
- No clipped text or actions.
- Hidden navigation is inert and unfocusable.
- Dialog focus and Escape behavior.
- Touch-sized primary controls.

## Styling

The application uses one domain-specific stylesheet in `src/styles.css`.

- Follow existing variables, density, borders, and spacing.
- Keep operational interfaces compact and scannable.
- Avoid nested decorative cards.
- Keep fixed card/grid dimensions stable.
- Use the existing hand-drawn `Icon.tsx` set; inspect additions at `#icons` at every
  shipped size.
- Do not add feature-explanation text inside the product.
- Test long card names, deck names, briefs, and transcript content.

## Future Migration

Browser-local persistence is transitional. When backend deck services arrive:

- Preserve the current `DeckLibrary` import shape.
- Do not remove the local copy until server import succeeds.
- Keep manual operations and the existing agent tools on one typed mutation service.
- Move validation and authoritative history to the backend.
- Maintain existing interaction behavior during the migration.
