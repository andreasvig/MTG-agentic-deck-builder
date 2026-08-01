# ADR 0034: Card Symbols Are Drawn, From Artwork Synced Into The Repository

- Status: Accepted
- Date: 2026-08-01

## Context

Magic writes its costs and abilities in braces, and a player reads them as pictures.
This application was showing them as the letters they are stored as — `{2}{G}{G}` in a
deck row, `{T}: Add {G}.` in a rules box — which is the notation a database uses, not
the notation a card is printed in. The interface is otherwise built around recognising
cards at a glance.

[ADR 0033](0033-braced-card-names-resolved-to-openable-cards.md) had already made a
parser out of the agent's braces, so a second brace syntax was already being read in
one place and ignored everywhere else.

## Decision

### Symbols are drawn everywhere card text appears, by one component

`CardText` turns a string into words and symbols, and every place that shows a mana
cost or rules text renders through it: the deck list, the deck board, the search
results and their preview, the card inspector, the search trace, and the agent's
answers. A cost in a 9px deck row and the same cost in an answer are the same
component at two font sizes, because the symbol is sized in `em`.

The parse is exact, not shaped. A braced run is a symbol because Scryfall's symbol
table lists it — not because it is short or uppercase. That distinction only matters
in one place, and it is the place that matters most: in agent prose, `{Sol Ring}` and
`{T}` arrive through identical syntax, and the previous heuristic was a regex guessing
which was which. The table also gives every symbol Scryfall's own reading of it, so a
cost read aloud is "two generic mana, one green mana" rather than punctuation.

Anything the table does not list is left exactly as written, braces included. Card
text is the one place where a literal `{` beats a silent edit: the meaning of a cost
lives in its braces, and dropping them off something we failed to recognise would
change what the card does. The answer parser keeps a shape test for the same reason —
an agent mistyping `{W/U/B}` has not named a card either.

### The artwork is synced into the repository, not hotlinked

`npm run symbols:sync` reads Scryfall's symbology endpoint and writes 84 SVGs into
`frontend/public/card-symbols/` plus a generated manifest. Both are committed, so a
fresh clone renders symbols without running anything.

Card art is hotlinked from Scryfall's CDN and this deliberately is not, because the
two are not alike:

- Rules text is symbol-dense — one ability can carry five — where a card is one image.
- The whole set is ~360 KB and fixed; card art is gigabytes and grows weekly.
- It matches how the catalog and the Tagger sidecar already work: sync once, read
  offline. Symbols were the last thing in a card panel that needed the network.
- Tests and screenshots become deterministic. A symbol that fails to load is a broken
  image in the middle of a sentence, and that is not worth a CDN's uptime.

The sync writes every new file before removing any retired one, so an interrupted run
leaves the previous set intact rather than an empty directory, and it refuses a file
name that is not Scryfall's own shape before writing a remote body into a public
directory.

### The prompt now asks for the notation rather than forbidding it

The system prompt used to end its bracing rule with "not a mana symbol", which was
correct when a brace could only mean a link. It now says the opposite: symbols keep
the braces they are printed with, and the interface draws them.

## Consequences

- 84 SVGs live in the repository. They change about as often as Wizards prints a new
  symbol, and the sync is idempotent, so the diff is empty until one does.
- A symbol Scryfall adds after the last sync renders as literal braces until someone
  runs the script. That is the same trade the card catalog already makes, and it fails
  visibly rather than silently.
- The manifest is generated and committed. Editing it by hand would be overwritten;
  the file says so.
- `parseCardText`'s newline exclusion changes no outcome — the brace bound and the
  table already settle every case. It is kept only so the two parsers read alike, and
  a planted mutant removing it survives on purpose rather than by oversight.

## Verification

Against the real model and catalog: asked to quote two cards' costs and rules text,
the agent answered `{Llanowar Elves} — Mana cost: {G}. Rules text: "{T}: Add {G}."`,
and that exact reply was replayed into a real browser — five symbols drawn, every one
loaded, both card names still resolving to openable cards, and no brace left in the
visible text.

In Chrome, symbols were read at their rendered size in all three shapes card text
takes: a search result's cost, a rules box, and the deck list's `MANA` column, where
the row is a grid sized for text and an image at its intrinsic size would push the
columns apart. Screenshots were read, not just captured.

Seven of eight planted mutants died: the table always returning nothing, casing left
unnormalised, the shape fallback removed, artwork pointed back at Scryfall's CDN, the
trailing words of an ability dropped, alternative text blanked, and the agent's
symbol branch disabled. The eighth survived and is recorded above as redundant rather
than untested.
