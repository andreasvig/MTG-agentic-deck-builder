# ADR 0044: A Deck Leaves As A List A Shop Can Read

- Status: Accepted
- Date: 2026-08-02

## Context

A Commander deck built here was worth about fifty euro of cardboard and had no way out of
the browser. The daily price estimate in the topbar said what it would cost; nothing said
where to go and buy it. Every other deck builder has an export, and what people do with
one is paste it into a shop.

## Decision

**Export is one button, one dialog, three formats, and a cart link.** The dialog shows the
generated list before anything leaves — copy, download, or open a prefilled cart — because
the whole risk of an export is a file whose format is wrong in a way you only discover in
someone else's paste box.

### There are two audiences, and they want different files

This is the decision the rest of the module follows from.

A **shop** — Cardmarket's wants import, TCGplayer's Mass Entry — parses every line as a
card to sell you. A **deck site** — Moxfield, Archidekt, Arena itself — needs section
headings to know which card is the commander.

So `text` is **headingless**, always. Its lines are `1 Sol Ring` and nothing else, the
commander among them as an ordinary card, because a `Commander` heading in a shop's paste
box is a card called "Commander" that fails the whole import. `arena` carries
`Commander` / `Deck` headings and pins each printing as `1 Sol Ring (CMM) 396`. `csv` is
for spreadsheets: quantity, name, set, collector number, EUR.

Do not merge `text` and `arena` into one format with a flag, and do not add headings to
`text` to make the two look alike.

### The cart link is real, and it is built from the buyable list

`https://www.tcgplayer.com/massentry?productline=Magic&c=<lines joined by ||>` is
TCGplayer's own documented parameter, and it opens a cart holding the deck. It is built
from `text`'s output rather than from whatever the preview is currently showing — the
parameter feeds the same parser as the paste box and has the same objection to a heading.

**Cardmarket gets no link.** Their decklist import is behind a login and has no public
entry point, so what the dialog gives is the plain list plus the name of the page that
takes it. Guessing a URL that 403s a fetch would have looked more finished and been worse.

### What the formats disagree about is card names

A **double-faced** card — `transform`, `modal_dfc`, `reversible_card` — is named by its
front face alone in Arena's format: `Brutal Cathar // Moonrage Brute` exports as
`1 Brutal Cathar (MID) 7`. Every other multi-part layout — split, adventure, flip,
aftermath — is one physical face whose *printed* name is `A // B`, so `Wear // Tear` stays
whole in all three formats. Shops list them under the printed name too.

A card can also carry no `details` at all: `isDeckEntry` has never required one, so a deck
saved by an older build hydrates with a name and nothing else. Such a card falls back to a
bare `1 Lightning Bolt`, which every importer accepts and resolves to a printing of its
own choosing. The alternative is a line reading `(undefined) undefined`, which no importer
accepts at all.

CSV quotes any field holding a comma, a quote or a newline. This is not politeness:
legendary creatures are named "Elesh Norn, Grand Cenobite", so an unquoted name column
splits a deck's commanders across two cells.

### The module is pure, and the dialog is the only thing that touches the browser

`domain/export.ts` is functions from a `Deck` to a string, with no React, no clipboard and
no DOM — the same shape as `domain/history.ts`. Every format decision above is testable
without rendering anything, which is what let a seventeen-mutation control run over the
ordering, the headings, the quoting and the URL.

## Consequences

- The export is read-only and derives from the live deck. It has no state to keep in sync.
- Adding a format is a row in `DECK_EXPORT_FORMATS` plus a branch in `exportDeck`. The
  dialog enumerates the table and needs no change.
- Basic lands are exported like everything else. Nobody has asked for a filter yet, and
  guessing which cards a builder already owns is a collection feature, not an export one.
- Import is still not implemented. This ADR covers one direction only.

## Alternatives Considered

- **A single "copy decklist" button with no dialog.** Cheapest, and it makes the format an
  invisible choice. The formats genuinely differ in where they can be pasted, so the
  choice belongs to whoever is pasting.
- **MTGO `.dek` XML.** A real format, but it is for playing online, and the ask was
  buying. Deferred until someone wants it.
- **Per-card Cardmarket links.** Every card already carries a `cardmarket_url`. A hundred
  of them is a hundred tabs, not a purchase.
