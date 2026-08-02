# ADR 0043: The Interface Is Printed On Paper, And Its Icons Are Drawn On A 12×12 Grid

- Status: Accepted
- Date: 2026-08-02

## Context

The application looked like a 2020s SaaS dashboard: Inter, a near-white sheet with a
faint green cast, a dark sidebar, rounded 4–12px corners, and about thirty drop shadows.
None of that was wrong on its own terms. What it was, was loud in the wrong place. Every
screen here has real Magic cards on it — saturated, illustrated, printed objects — and a
chrome that also uses colour, depth and roundness competes with them.

`ai-plays-pokemon`'s control center had already been through this and landed somewhere
better: cream stock, one monospace face, hairline rules instead of shadows, flat tint
blocks instead of glows, nothing rounder than 3px. That sheet is documented at the top of
`src/dashboard/web/src/app.css` there, and this ADR is that aesthetic re-inked for a deck
builder.

## Decision

**Everything is printed ink on one piece of paper.** Cream stock (`--canvas: #f2efe9`),
warm ink (`--ink: #1f1c17`), hairline rules, flat tint blocks, `--radius: 3px`, and
`box-shadow` reserved for the handful of things that genuinely float above the sheet —
modals, popovers, and the mobile sidebar drawer.

**The house ink is green, not blue.** PokeBench's accent is blue; this app is about
mana, and green (`--accent: #3f6b46`) is the one colour the product has always used.

**Cards are the exception, and that is the point.** Card art, mana symbols and set
symbols keep their own colour and their own printed corner radius (`--radius-card`, 5px).
They are photographs of coloured objects lying on the sheet. With the chrome desaturated
they are now the only saturated thing on screen, which is the whole reason for doing
this. The `.color-filter` pips stay circular for the same reason: they are card
iconography, not chrome.

**The sidebar is not dark.** It was the app's one dark surface. On paper there are no
dark surfaces; it is a recessed well (`--surface-subtle`) told apart by a hairline rule.

**One typeface.** `--mono` for the entire page, at a 12.5px base. Not 13: the same
measure in mono runs ~8% wider than in the Inter this sheet was laid out in, and the
dense rows (deck list, search results, trace panel) are sized in px. The sidebar went
from 196px to 214px for the same reason — at the old width every deck name ellipsed.

**Icons are hand-drawn pixels, not a line set.** `lucide-react` is gone. Its replacement,
`components/Icon.tsx`, is 39 glyphs hand-set as `[x, y, w, h]` rects on a 12×12 grid,
rendered in `currentColor` with `shape-rendering="crispEdges"`. Twelve units rather than
the usual twenty-four is deliberate: each "pixel" is twice the size, so the marks read as
printed rather than as small tidy line art. The brand mark is the colour pie — five pips
wired into a pentagon, the one diagram every Magic player already reads, and the thing a
manabase is a choice about. The favicon is the same rects.

## Consequences

**Hand work, and a tool to make it survivable.** Adding a glyph is drawing it. `#icons`
in the dev server opens `dev/IconSheet.tsx`, a contact sheet rendering every glyph at the
four sizes this app actually ships (11 / 14 / 18 / 26px) plus an 8× blow-up on the grid.
That sheet is not optional: the first pass of this set had eight glyphs that were fine at
26px and mush at 11 — a filled warning triangle that swallowed its own exclamation mark,
a `⌘` whose four loops flooded into a solid square, a dashed circle that came out a
crescent. Every one of them was found by looking, not by reasoning about the grid.

**Two glyphs are honest compromises**, recorded here so they are not re-litigated as
bugs. `command` is a key cap rather than `⌘`, because four 3×3 loops need a one-unit
stroke and at 17px that is under a pixel. `tags` is one tag, not lucide's two, because
the second is unreadable once the first has a hole punched in it.

**Colour was re-inked mechanically, then reviewed.** 195 distinct hex literals across
5,250 lines of CSS were mapped by hue and lightness onto the paper ramp by a script
rather than by 271 hand edits. The classifier keys on absolute chroma (`max - min`), not
HLS saturation: saturation divides by `2 - max - min`, which explodes near white and
filed every faintly-green off-white in the sheet as a green.

**No behaviour changed.** 252 frontend tests and all 15 end-to-end tests pass unmodified,
which is the evidence that this is a re-skin and not a rewrite. Nothing in `backend/`
was touched.

**One dependency less.** `lucide-react` is uninstalled.
