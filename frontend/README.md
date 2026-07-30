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
    CardInspector.tsx         Centered card details and group action
    CardArt.tsx               Remote art with fallback
    ConnectionStatus.tsx      Backend health state
  domain/
    card.ts                   Search/card types and helpers
    deck.ts                   Persistence schema, migration, warnings
  hooks/
    useDeck.ts                Deck application service and undo
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

`useDeck.ts` is the only current mutation boundary. Components receive named
operations for:

- Add card.
- Set quantity and remove.
- Move card.
- Add a custom group, optionally moving a dropped card into it.
- Create and select deck.
- Rename deck.
- Undo.

Deck deletion is confirmed and current-session recoverable through
`useDeck.ts`. Custom-group rename and delete operations are not implemented
yet; add them through the same service rather than introducing component-local
mutations.

Keep mutation announcements meaningful for assistive technology.

## Editor Invariants

- Card search is the single add workflow.
- Permanent groups are Command zone and Not assigned.
- Card types is the default grouping mode; Custom remains the editable mode.
- Cards move only when grouping by Custom.
- Card types are derived from card data.
- No standalone maybeboard.
- Card details are a dialog, not a persistent right inspector.
- Right workspace remains available for future agent chat.
- Mobile uses the deck-action toolbar rather than shrinking desktop navigation.
- Illegal commander color identity is warned before and after add.
- Command-zone cards have quantity one. A second is allowed only for a
  recognized legal co-commander pairing, and a third is rejected.

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
- Command-zone cards use `section="command_zone"`.
- Custom groups use the first category entry as the primary group ID.
- Invalid and legacy placement normalizes to Not assigned.

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
- `lib/api.test.ts`: request encoding, errors, runtime response validation.
- `components/SearchDrawer.test.tsx`: filters, debug, scores, progressive
  loading.
- `components/SearchTracePanel.test.tsx`: readable content across exactly seven
  agentic trace stages.
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
- Use Lucide icons for familiar actions.
- Do not add feature-explanation text inside the product.
- Test long card, deck, and group names.

## Future Migration

Browser-local persistence is transitional. When backend deck services arrive:

- Preserve the current `DeckLibrary` import shape.
- Do not remove the local copy until server import succeeds.
- Keep manual operations and future agent tools on one typed mutation service.
- Move validation and authoritative history to the backend.
- Maintain existing interaction behavior during the migration.
