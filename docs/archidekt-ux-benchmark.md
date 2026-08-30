# Archidekt UX Benchmark

Research date: 2026-07-23

This benchmark defines the interaction qualities the local Commander builder
should match. It does not require copying Archidekt's visual identity or its
social, marketplace, and hosted-account features.

## Sources Reviewed

- [Public Commander deck](https://archidekt.com/decks/20057620/deathleaper_terror_weapon_a_myriad_of_possibilities)
- [Archidekt FAQ](https://archidekt.com/faq)
- [2026 mobile UI overhaul](https://archidekt.com/news/22633051)
- [2026 static card view and search UI](https://archidekt.com/news/20605672)
- [Draggable categories and deck controls](https://archidekt.com/news/7305181)
- [Multiple categories](https://archidekt.com/news/660198)

The public deck, desktop search overlay, search results, and mobile deck page
were also inspected with Playwright at desktop and mobile viewport sizes.

## Experience To Match

### Cards First

- Keep the deck name, format, legality, card count, and estimated price compact.
- Give most of the screen to cards and category or list organization.
- Show category quantities and subtotals where edits happen.
- Keep card identity, quantity, printing, finish, category, and price in context.

### Fast And Detailed Add Paths

- Keep one **Add cards** action visible on desktop and mobile.
- Open a focused search surface without navigating away from the deck.
- Show card art, key metadata, price, and current deck membership in results.
- Allow repeated add and remove actions without closing search.
- Let the same fuzzy title search handle exact names, partial segments,
  misspellings, and filters.
- Make loading, no-results, invalid-query, and provider-error states explicit.

### Power Without Clutter

- Keep view, grouping, and sorting next to the deck.
- Provide visual category and dense list modes.
- Use a centered detail dialog for card inspection and placement actions.
- Keep high-frequency controls visible; place secondary actions in menus.
- Preserve keyboard and non-drag alternatives for repeated work.
- Reserve the right workspace edge for the desktop deck agent.

### Purpose-Built Mobile

- Use a persistent bottom toolbar for Add cards, Layout, Undo, and More.
- Use drawers for search, layout controls, and card inspection.
- Avoid shrinking the complete desktop control surface into a narrow viewport.
- Keep touch targets at least 40 pixels and prevent hidden navigation from
  remaining keyboard-focusable.

## Current Acceptance Slice

- Local SQLite card search through the FastAPI provider boundary, using a
  Scryfall-derived bulk catalog.
- One fuzzy title path with structured filters, percentages in debug mode, and
  inline deck membership.
- Persistent local deck state with add, remove, quantity, move, and undo.
- Permanent Command zone above groups derived from card type; custom groups were
  deliberately removed in ADR 0037.
- Stacked visual and dense list views with actual card images.
- Category and deck EUR estimates for the selected printing.
- One derived Card types grouping with sort controls.
- Centered selected-card dialog with rules and printing details.
- Drag, touch, and keyboard movement between the command zone and the deck.
- Commander color-identity warnings before and after illegal additions.
- Multi-deck rail with commander art, inline naming, and deck creation.
- Compact desktop controls and a mobile bottom toolbar.
- Responsive, accessible search/navigation/drawer behavior.
- A desktop deck-agent panel with streamed tools, catalog/web research, and
  auto-applied card or shared-brief edits backed by durable history.
- Plain-text, MTG Arena, and CSV export plus a prefilled TCGplayer cart.
- Unit, integration, production-build, and browser-driven workflow tests.

## Useful Next

- Printing and finish selection with an all-printings endpoint.
- Multi-select and bulk editing.
- Optional analysis tags that do not become a second placement axis.
- Configurable dense-list columns where that improves scanning.
- Printing optimizer with a previewed diff.
- Mana curve, color production, probability, and category charts.
- Plaintext import preview with unmatched-line reporting; export is shipped.
- Backend-persisted mutation history and named deck snapshots; browser-local
  durable history is shipped.

## Later Or Intentionally Excluded

- Hosted accounts, collaboration, public deck discovery, and social features.
- Collection ownership and third-party marketplace account synchronization.
- Full playtester and game simulation.
- Bulk or background EDHREC automation without a permitted, stable provider
  agreement.
- Salt or Commander bracket scoring until the product model is chosen.

## Product Lesson

The target is not Archidekt's decoration or a literal copy of every feature.
The target is short distance between intent and card action: one capable search
path, continuous deck context, visible power-user controls, one understandable
placement axis, and a mobile layout designed around the same repeated actions.
