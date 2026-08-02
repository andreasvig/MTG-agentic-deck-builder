/**
 * Chunky pixel icons, hand-set on a 12x12 grid.
 *
 * This replaces `lucide-react`. Lucide is a 1.5px-stroke line set drawn for a
 * sans-serif UI; on the paper sheet (see the header of `styles.css`) it was the
 * one thing left that looked vector-drawn. Coarser than an off-the-shelf pixel
 * set on purpose: at 12 units each "pixel" is twice the size of a 24-grid
 * icon's, so these read as printed marks rather than as small tidy line art.
 *
 * Every icon is a list of `[x, y, w, h]` rects in grid units, drawn in
 * `currentColor` with `shape-rendering="crispEdges"` — a parent tints it with
 * `color:` and it stays hard-edged at any size. Same contract as PokeBench's
 * `Icon.svelte`, which is where the aesthetic comes from.
 *
 * Adding one is hand work, which is the known cost of this direction. Draw it on the
 * grid first, then look at it on the contact sheet — `#icons` in the dev server, see
 * `dev/IconSheet.tsx`. A 1px feature turns to mush at 11px, which is why nothing below
 * is thinner than two units unless it is a diagonal.
 */
import type { SVGProps } from "react";

type Rect = readonly [number, number, number, number];

/** `n` blocks of `s`x`s` stepping by (dx, dy) — a diagonal thick enough to survive. */
const step = (
  x: number,
  y: number,
  dx: number,
  dy: number,
  n: number,
  s = 2,
): Rect[] => Array.from({ length: n }, (_, i) => [x + i * dx, y + i * dy, s, s] as const);

/** A `t`-thick rectangular outline. */
const box = (x: number, y: number, w: number, h: number, t = 2): Rect[] => [
  [x, y, w, t],
  [x, y + h - t, w, t],
  [x, y, t, h],
  [x + w - t, y, t, h],
];

/** A solid arrowhead: tip one unit deep, growing by 2 rows per unit of depth. */
const head = (x: number, y: number, dir: "left" | "right" | "up" | "down", d = 3): Rect[] =>
  Array.from({ length: d }, (_, i) => {
    const span = 2 + i * 2;
    switch (dir) {
      case "left":
        return [x + i, y - i, 1, span] as const;
      case "right":
        return [x - i, y - i, 1, span] as const;
      case "up":
        return [x - i, y + i, span, 1] as const;
      default:
        return [x - i, y - i, span, 1] as const;
    }
  });

/** A 12x12 pixel circle, 2 units thick. The base of every round glyph here. */
const RING: Rect[] = [
  [4, 0, 4, 2],
  [2, 1, 2, 2],
  [8, 1, 2, 2],
  [1, 2, 2, 2],
  [9, 2, 2, 2],
  [0, 4, 2, 4],
  [10, 4, 2, 4],
  [1, 8, 2, 2],
  [9, 8, 2, 2],
  [2, 9, 2, 2],
  [8, 9, 2, 2],
  [4, 10, 4, 2],
];

/** RING with its top-right quadrant left open, for the two rotate arrows. */
const RING_OPEN: Rect[] = RING.filter(([x, y]) => !(x >= 8 && y <= 2));

/** The pointed shield the two warning glyphs share. */
const BANG: Rect[] = [
  [5, 3, 2, 4],
  [5, 8, 2, 2],
];

export const ICONS = {
  plus: [
    [5, 1, 2, 10],
    [1, 5, 10, 2],
  ],
  minus: [[1, 5, 10, 2]],
  close: [...step(1, 1, 1, 1, 9), ...step(9, 1, -1, 1, 9)],
  check: [...step(1, 5, 1, 1, 4), ...step(5, 7, 1, -1, 6)],
  chevronDown: [...step(1, 3, 1, 1, 5), ...step(9, 3, -1, 1, 4)],
  chevronRight: [...step(3, 1, 1, 1, 5), ...step(3, 9, 1, -1, 4)],

  menu: [
    [1, 1, 10, 2],
    [1, 5, 10, 2],
    [1, 9, 10, 2],
  ],
  // Rows of type with a marker each — the list view, seen from above.
  list: [
    [0, 1, 2, 2],
    [4, 1, 8, 2],
    [0, 5, 2, 2],
    [4, 5, 8, 2],
    [0, 9, 2, 2],
    [4, 9, 8, 2],
  ],
  grid: [
    [0, 0, 5, 5],
    [7, 0, 5, 5],
    [0, 7, 5, 5],
    [7, 7, 5, 5],
  ],
  // Three filled columns rather than an outlined frame: at 15px the frame's
  // inner rules and its border were the same weight and it read as a grid.
  columns: [
    [0, 1, 3, 10],
    [4, 1, 4, 10],
    [9, 1, 3, 10],
  ],
  // A square lens. A round one needs a 1px ring to leave any glass, and the
  // square reads at 11px where the ring does not — the whole reason to draw
  // our own set rather than pixelate someone else's.
  search: [...box(0, 0, 10, 10), [9, 9, 3, 3]],

  trash: [
    [3, 0, 6, 2],
    [0, 2, 12, 2],
    [2, 4, 2, 8],
    [8, 4, 2, 8],
    [2, 10, 8, 2],
    [5, 5, 2, 5],
  ],
  pencil: [
    [8, 0, 4, 2],
    ...step(7, 2, -1, 1, 6, 3),
    [1, 8, 2, 2],
    [0, 10, 2, 2],
  ],

  // Undo/redo are a shaft that turns a corner — a closed loop would collide
  // with reset/refresh below, which are the ones that really are loops.
  undo: [...head(0, 2, "left"), [2, 2, 7, 2], [7, 2, 2, 8], [2, 8, 7, 2]],
  redo: [...head(11, 2, "right"), [3, 2, 7, 2], [3, 2, 2, 8], [3, 8, 7, 2]],
  reset: [...RING_OPEN.map(mirror), ...head(0, 1, "left", 3)],
  refresh: [...RING_OPEN, ...head(11, 1, "right", 3)],
  history: [...RING, [5, 2, 2, 4], [6, 5, 3, 2]],

  // Slopes stepping two rows per unit, so the interior stays open all the way
  // down and the bang inside it survives at 11px. A filled triangle does not.
  warning: [
    [5, 0, 2, 2],
    ...step(4, 2, -1, 2, 4),
    ...step(6, 2, 1, 2, 4),
    [0, 10, 12, 2],
    [5, 4, 2, 3],
    [5, 8, 2, 2],
  ],
  alert: [...RING, ...BANG],
  checkCircle: [...RING, ...step(3, 5, 1, 1, 2), ...step(5, 5, 1, -1, 2)],
  xCircle: [...RING, ...step(3, 3, 1, 1, 4), ...step(6, 3, -1, 1, 4)],
  plusCircle: [...RING, [5, 3, 2, 6], [3, 5, 6, 2]],
  // A run that has not started: the same circle, printed dashed. Spaced by
  // position rather than by index — dropping every other entry of RING leaves
  // a crescent, because RING is not ordered around the circumference.
  pending: [
    [4, 0, 4, 2],
    [9, 2, 2, 2],
    [10, 5, 2, 2],
    [8, 9, 2, 2],
    [4, 10, 4, 2],
    [2, 9, 2, 2],
    [0, 5, 2, 2],
    [1, 2, 2, 2],
  ],

  external: [
    [0, 3, 2, 9],
    [0, 10, 9, 2],
    [7, 6, 2, 6],
    [0, 3, 4, 2],
    [6, 0, 6, 2],
    [10, 0, 2, 6],
    ...step(5, 4, 1, -1, 4),
  ],
  grip: [
    [3, 1, 2, 2],
    [7, 1, 2, 2],
    [3, 5, 2, 2],
    [7, 5, 2, 2],
    [3, 9, 2, 2],
    [7, 9, 2, 2],
  ],
  more: [
    [0, 5, 2, 2],
    [5, 5, 2, 2],
    [10, 5, 2, 2],
  ],
  send: [[0, 5, 8, 2], ...head(11, 5, "right", 4)],
  // Export: an arrow off the page and onto a base rule. The gap between the
  // tip and the rule is what keeps the two shapes apart at 11px.
  download: [[5, 0, 2, 6], ...head(5, 8, "down", 3), [0, 10, 12, 2]],
  // Two whole sheets, offset — "one of these became two", which is what copy
  // means. Drawn instead of a clipboard because a clipboard's board is one
  // outline: at 15px the walls meet in the middle and it is a solid lozenge.
  // Two 8-unit boxes each keep a 4-unit hole, and a hole is what survives.
  // Not `deck`'s shape mirrored — that is one card with a corner behind it,
  // and a set should not carry the same mark under two names.
  copy: [...box(0, 0, 8, 8), ...box(4, 4, 8, 8)],

  sliders: [
    [0, 1, 12, 2],
    [3, 0, 2, 4],
    [0, 5, 12, 2],
    [7, 4, 2, 4],
    [0, 9, 12, 2],
    [4, 8, 2, 4],
  ],
  // A square gear. A round body plus round teeth needs more than 12 units;
  // squaring both is also the only version that stays a gear at 11px.
  settings: [
    ...box(2, 2, 8, 8),
    [5, 0, 2, 2],
    [0, 5, 2, 2],
    [10, 5, 2, 2],
    [5, 10, 2, 2],
  ],
  // An open-ended spanner: two jaws with a two-unit gap, then the handle.
  wrench: [
    [4, 0, 3, 3],
    [9, 0, 3, 3],
    [4, 3, 8, 3],
    ...step(0, 9, 1, -1, 4, 3),
  ],
  bug: [
    [4, 0, 4, 2],
    ...box(3, 2, 6, 10),
    [1, 4, 2, 2],
    [9, 4, 2, 2],
    [1, 8, 2, 2],
    [9, 8, 2, 2],
  ],
  // A label with its punch hole and stem — one tag, not lucide's two, because
  // the second one is unreadable once the first has a hole in it.
  tags: [...box(0, 2, 9, 8), [4, 5, 2, 2], ...head(11, 5, "right", 3)],
  noImage: [...box(0, 1, 12, 10), ...step(1, 1, 1, 1, 10)],

  // Nav: one card outlined with a second peeking out behind it. Three cards in
  // a row read as a bar chart at 18px, which is the size the nav uses.
  deck: [
    [3, 0, 9, 2],
    [10, 0, 2, 9],
    ...box(0, 3, 9, 9),
  ],
  bot: [...box(1, 2, 10, 10), [3, 5, 2, 2], [6, 5, 2, 2], [4, 8, 4, 2], [5, 0, 2, 3]],
  // A key cap, not ⌘. Four 3x3 corner loops need a 1-unit stroke to leave any
  // hole, and at 17px that is under a pixel — every attempt flooded to a solid
  // square. The frame-plus-centre reads as "a key" instead, which is what the
  // one place it appears (the deck list's keyboard hint) actually means.
  command: [
    [0, 0, 3, 3],
    [9, 0, 3, 3],
    [0, 9, 3, 3],
    [9, 9, 3, 3],
    [3, 0, 6, 2],
    [3, 10, 6, 2],
    [0, 3, 2, 6],
    [10, 3, 2, 6],
    ...box(3, 3, 6, 6),
  ],
  sparkles: [
    [5, 0, 2, 12],
    [0, 5, 12, 2],
    [4, 3, 4, 6],
    [3, 4, 6, 4],
    [2, 5, 8, 2],
  ],
  /* The brand: the colour pie. Five pips at the vertices of a pentagon, wired
     together — WUBRG, the one diagram every Magic player already reads, and
     the thing a manabase is a choice about. Drawn as 2x2 nodes on 1-unit
     edges: the brand is the one glyph that never renders below 20px, so it
     can afford a hairline the rest of the set cannot. */
  brand: [
    [5, 0, 2, 2],
    [10, 3, 2, 2],
    [8, 9, 2, 2],
    [2, 9, 2, 2],
    [0, 3, 2, 2],
    [7, 1, 1, 1],
    [8, 2, 1, 1],
    [9, 3, 1, 1],
    [4, 1, 1, 1],
    [3, 2, 1, 1],
    [2, 3, 1, 1],
    [10, 5, 1, 1],
    [10, 6, 1, 1],
    [9, 7, 1, 1],
    [9, 8, 1, 1],
    [1, 5, 1, 1],
    [1, 6, 1, 1],
    [2, 7, 1, 1],
    [2, 8, 1, 1],
    [4, 10, 4, 1],
  ],
} as const satisfies Record<string, readonly Rect[]>;

/** Mirror a rect across the grid's vertical centre line. */
function mirror([x, y, w, h]: Rect): Rect {
  return [12 - x - w, y, w, h];
}

export type IconName = keyof typeof ICONS;

type Props = Omit<SVGProps<SVGSVGElement>, "name"> & {
  name: IconName;
  /** In px, not em: these sit in fixed-size buttons whose font-size is doing
   *  other work, so inheriting it would couple two unrelated decisions. */
  size?: number;
};

export function Icon({ name, size = 16, ...rest }: Props) {
  return (
    <svg
      viewBox="0 0 12 12"
      width={size}
      height={size}
      fill="currentColor"
      shapeRendering="crispEdges"
      focusable="false"
      {...rest}
    >
      {ICONS[name].map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} />
      ))}
    </svg>
  );
}
