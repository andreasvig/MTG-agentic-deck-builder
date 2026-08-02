/**
 * Contact sheet for the hand-drawn icon set. Open `#icons` in the dev server.
 *
 * A pixel glyph is only correct at the size it ships at, and this app ships
 * them from 11px to 26px. Drawing one on the grid and trusting it is how you
 * get a mark that is legible at 22 and mush at 11 — so every edit to
 * `components/Icon.tsx` gets looked at here first, at all four sizes and
 * blown up on the grid.
 */
import { ICONS, Icon, type IconName } from "../components/Icon";

const SIZES = [11, 14, 18, 26];
const names = Object.keys(ICONS) as IconName[];

export function IconSheet() {
  return (
    <div className="icon-sheet">
      <h1>Icon sheet</h1>
      <p>
        {names.length} glyphs · shipped sizes {SIZES.join(" / ")}px · the large
        column is the same rects at 8× with the 12×12 grid behind them.
      </p>
      <table>
        <thead>
          <tr>
            <th>name</th>
            {SIZES.map((s) => (
              <th key={s}>{s}px</th>
            ))}
            <th>grid</th>
          </tr>
        </thead>
        <tbody>
          {names.map((name) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              {SIZES.map((size) => (
                <td key={size}>
                  <Icon name={name} size={size} />
                </td>
              ))}
              <td className="icon-sheet__grid">
                <Icon name={name} size={96} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
