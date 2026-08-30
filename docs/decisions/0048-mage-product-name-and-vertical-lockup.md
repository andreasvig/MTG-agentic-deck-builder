# ADR 0048: The Product Is MAGE, Written Down The Page

- Status: Accepted
- Date: 2026-08-30

## Context

`Manabase` described one familiar part of deck construction, but the product now has a
larger idea to communicate: natural-language card discovery and a tool-using deck agent
working over the same local catalog and editable deck. The public name should make that
agentic identity visible without abandoning the terse, printed, Magic-native character
established in ADR 0043.

The repository also contains browser persistence keys under `manabase.*`. Those strings
are data compatibility boundaries, not display copy. Renaming them as part of a visual
rebrand would silently hide existing decks, history, conversations, and preferences.

## Decision

The product name is **MAGE**, expanded as **Magic's Agentic Gathering Engine**.

The primary lockup writes the acronym down its first column by enlarging the initial of
each word:

```text
Magic's
Agentic
Gathering
Engine
```

The four oversized initials read **MAGE** vertically. Each remainder begins immediately
after its initial; the word never repeats that letter at a second, smaller size.

It uses the existing monospace face, green house ink, square geometry, and flat printed
treatment. It is built from accessible HTML and CSS so it stays crisp, selectable by the
browser's accessibility tree, and native to the interface rather than arriving as a
detached image asset.

At favicon and small-icon sizes, four text rows cannot remain legible. Those surfaces use
a compact block-built **M** on the existing 12x12 icon grid. The full vertical lockup,
not the compact initial, remains the primary logo.

The active browser title, product documentation, and deck-agent self-identification use
MAGE. Package names, API service identifiers, repository paths, and every `manabase.*`
storage key remain unchanged: they are technical identities or migration inputs, not
user-facing branding.

## Consequences

- The name now describes the agentic system rather than only its card resources.
- The expansion is visible in the interface instead of surviving only as README trivia.
- The logo stays within the paper-and-pixel visual system and needs no new image or font
  dependency.
- Existing local data loads without migration or reset.
- The old colour-pie mark remains part of the historical decision recorded by ADR 0043,
  but no longer represents the current product.
