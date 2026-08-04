# ADR 0047: The Deck Brief Renders Bounded Markdown

- Status: Accepted
- Date: 2026-08-04
- Supersedes: ADR 0046's plain-text read rendering only

## Context

The shared brief is written by both a person and the deck agent. As it grows beyond one
sentence, literal Markdown markers make the most important information harder to scan: a
constraint beginning with `-` is shown as punctuation instead of a list item, and emphasis
shows its asterisks. The agent also learned the transcript convention that braces around a
card name make that name openable. When the same markup leaks into a stored description,
the brief displays `{Toggo, Goblin Weaponsmith}` even though it has no resolved card-link
payload.

A general Markdown dependency would allow far more syntax than this small local field needs.
Reusing the transcript renderer would be misleading too: transcript card links are resolved
by the backend and carry printing data, while a persisted deck description is only a string.

## Decision

The description remains one browser-local string of at most 2,000 characters, edited whole
in a textarea. Its read view renders a bounded Markdown subset:

- paragraphs and preserved single line breaks;
- unordered and ordered lists, including wrapped list items;
- bold, italic and inline code;
- hash-prefixed lines as visually emphasized brief labels, not document headings; and
- known mana and ability symbols through the existing synced symbol set.

Raw HTML, links, images, tables and arbitrary embedded content are not syntax. React therefore
continues to escape everything outside the parser's explicit node types.

Curly braces around card names belong only to agent answers, where the backend resolves them
into openable cards. The deck-agent prompt writes card names plainly in descriptions, and the
`edit_deck_text` boundary removes non-symbol braces before it emits a future agent-authored
brief. The read parser also removes braces from older stored descriptions. It does not rewrite
the user's source, and symbol-shaped runs keep their braces when they cannot be resolved so a
mistyped mana cost does not silently change meaning.

The three-line clamp covers the rendered block tree rather than one paragraph. Editing, history,
undo, background-deck ownership, storage and the stale-replay rule remain those of ADR 0046.
An agent-authored description change on the open deck expands the brief and marks the history
entry as **Updated by agent**. Otherwise a change confined below the clamp would be applied but
look identical to the user. A later edit, Undo or deck switch clears that marker.

## Consequences

- Existing descriptions require no storage migration.
- A legacy braced card name becomes readable plain prose, but not an openable card; there is no
  card identity or printing payload in the stored field.
- Agent-written descriptions converge on brace-free source, while user-authored source remains
  byte-for-byte under the user's control until they save another edit.
- The parser is intentionally smaller than CommonMark and is tested as its own pure domain
  function so expanding the syntax requires an explicit product choice.
