# ADR 0035: The Deck Agent Searches The Catalog Itself, Owning Every Filter

- Status: Accepted
- Date: 2026-08-01

## Context

The deck agent could read the open deck and look up cards it could already name
([ADR 0029](0029-read-only-deck-agent-tools.md)). It could not find a card. Its system
prompt said so outright — *"you cannot search the catalog for cards you have not been
given — when the user wants to find cards, tell them to use the card search"* — which
made "what ramp should I add?" a question it had to decline and hand back to the
interface.

Meanwhile the search agent already had a search engine that does everything such a
question needs: exact filters over the whole local catalog, semantic ordering over
rules text and gameplay tags, and EDHREC inclusion and synergy blended into a weighted
sort. The only thing standing between the two was **who owns the filters**. For a panel
search the interface owns the immutable half — the user picks colours, tags, a
commander and price bounds on screen, and the model fills in the rest. A chat has no
panel.

## Decision

### `search_cards` is the search agent's engine with the filters moved

`LocalCardSearchTool` is reused unchanged. `deck_agent_tools` supplies both halves of
its input: the model's own `LocalCardSearchRequest`, and the `CardSearchFilters` the
interface would otherwise have supplied. Nothing in `agentic_card_search.py` changed,
and the search agent's prompt, its eight tuned examples and its parsing test contract
are untouched.

`SearchCardsArguments` **subclasses** `LocalCardSearchRequest` rather than restating
it. Every ordering field, every filter, every bound and every cross-field validator
comes from the one definition both callers share, so a field added for the search agent
is advertised to the deck agent without a second edit, and the two cannot drift.

Three fields are added, and they are only what the filter panel used to decide:
`commander`, `commander_legal_only`, `exclude_cards_in_deck`.

### The commander is a nested object with no default

A commander does two unrelated things to a search, and conflating them is how a search
silently deletes the card the user wanted:

- Its **colour identity** is a hard filter. It removes cards and nothing restores them.
- Its **EDHREC inclusion and synergy** are sort signals. They reorder and remove
  nothing.

So `commander` carries `card`, `restrict_to_color_identity` and `edhrec_theme`
separately, and "rank by what this commander's decks actually play, but still show me
cards outside its colours" is a request that can be made.

Omitting the object means there is no commander: no identity gate, no EDHREC evidence,
both EDHREC orderings unavailable. It does **not** silently fall back to the deck's
command zone. The agent has `read_deck` and can name it; inheriting a card-deleting
filter it never typed is the one thing this contract refuses to do.

`card` accepts any card in the catalog, not only the one in the command zone. That is
the point rather than a side effect: it makes "would this work under a different
commander?" a single tool call.

`restrict_to_color_identity: false` is expressed by sending **no** identity at all
rather than by also setting `include_outside_commander_color_identity`. Two fields that
have to agree is one more way to be wrong, and `matches_card_filters` already treats a
missing identity as "do not restrict".

### The two colour gates are not interchangeable, and the prompt says so

A commander's identity gate keeps colorless cards — an artifact's identity is empty,
which is a subset of every commander's colours. The `colors` filter removes every
colorless card unless `include_colorless` is set. So a green-commander ramp search that
"helpfully" adds `colors: {identity: ["G"]}` deletes every mana rock in the catalog.
Both halves of that asymmetry are pinned by tests, because the prompt asserts it.

### Failure is a tool result, never a dead turn

Every way the engine can refuse — an EDHREC ordering with no evidence, a search with no
criteria, `max_results` over the cap, a missing semantic index — becomes a failed
`ToolOutcome` whose text the model reads and adapts to. Two causes that need different
fixes get different messages: *no commander was named* and *there is no EDHREC data for
X* are not the same problem. A commander name that resolves to nothing fails the call
rather than quietly searching without one.

The engine's own wording for a criteria-less search is deliberately not passed through:
it talks about the interface filters a panel search has, and quoting it would send the
model looking for something this tool has no equivalent of.

### The result reuses `see_cards`' card block, under a header of only what the model could not know

A card found by searching and a card looked up by name arrive in the same layout, from
the same renderer, with rules text and one EUR estimate. Not the three-way price
breakdown `see_cards` gives: in a search the price is one selection signal among
several, and EUR is what every other price surface in this application leads with.

The header is two lines at most, because **everything the model sent is still sitting in
its own tool call.** Echoing back the filters, the sort, the legality flag and the
commander's name costs tokens on every search to tell the model what it said a moment
earlier. What it cannot know is reported and nothing else:

- How many cards matched against how many are shown. Without it, "these are the only
  matches" and "these are twelve of seven thousand" are indistinguishable, and the model
  will assert the first.
- The commander's colour identity, but only when it actually removed cards.
- A **missing** EDHREC lookup. A successful one needs no announcement: it is visible on
  every card's own inclusion line.

No line about something means nothing surprising happened. With no commander named there
is no commander line at all.

Rules text is included and `max_results` defaults to 12 rather than the search agent's
24. A chat turn already carries the transcript and possibly a deck listing, and a bare
name list would only make the agent spend one of its four tool iterations calling
`see_cards` on everything it just found.

### A commander's deck themes are a `see_cards` detail, not a search header line

EDHREC's theme slugs are genuinely useful — `edhrec_synergy` inside `mana-dorks` is a
sharp query — but they are not a search result. Marwyn advertises 66 and Ghalta 77,
ordered by popularity with a tail backed by a single deck each, so putting them in every
search header cost most of a kilobyte per call to advertise evidence mostly not worth
sorting on.

They are now `themes`, a seventh `see_cards` detail (extending
[ADR 0029](0029-read-only-deck-agent-tools.md)): asked for when wanted, on the one card
it means anything for. Capped at twenty with the deck count beside each slug, because
that count is what says whether a theme is worth sorting on. A slug past the cap still
works; getting one wrong is what lists every one of them.

Only a card that can legally be a commander has an EDHREC commander page, so for
anything else the detail reports *which* of the two things is true — "EDHREC has no
commander page for this, which in practice means a legendary creature" rather than a
bare "no themes", because the two lead somewhere different. Like `similar`, it is one
network lookup per card, so the tool description says to ask for it on a commander
rather than across a list.

## Consequences

- The deck agent can answer "what should I add?" with cards, and every name it writes
  is already openable via [ADR 0033](0033-braced-card-names-resolved-to-openable-cards.md).
  No frontend change: the tool line and its debug expander are name-agnostic.
- **Two prompts now describe one engine.** The field reference lives in
  `agent.tools.search_cards_description` and the craft in the deck agent's
  `# Searching for cards` section, mirroring how the search agent splits its `# Tools`
  from its `# Guidelines` — but tuning one does not tune the other. Cross-reference
  comments sit at both sites in `config.yaml`, the way mirrored constants are handled
  elsewhere in this codebase. Noted, not solved.
- A second `LocalCardSearchTool` instance exists, because the result bounds are fixed at
  construction. It holds references to the same catalog, semantic index and sidecar, so
  what is duplicated is two integers. The `weighted` blend weights are shared from
  `search.agentic.ranking.weighted`: how much semantic closeness is worth against
  EDHREC inclusion is a property of the ranking, not of which agent asked.
- Every search with a commander loads EDHREC rather than gating it behind a flag, since
  the default `weighted` sort blends inclusion into its score. It is a 30-day cache, so
  this is normally a local read, and a failure degrades to a note.
- `search_cards` is advertised only when the engine is wired in. An advertised tool that
  always fails costs the model an iteration and teaches it nothing.
- **Measured while tuning the theme guidance:** under `edhrec_inclusion` or
  `edhrec_synergy`, `semantic_sort` only orders the cards EDHREC has no figure for, and
  those all sort below every card it does. Two searches differing only in whether
  `semantic_sort` was sent returned identical lists. The deck agent's prompt now says
  so and tells it to spend the effort on the theme and a `types` filter instead. The
  search agent's prompt has the same trap and has deliberately not been edited — it is
  a working surface nobody asked to change — but `docs/search.md` records the finding.
- The tool line carries the theme after the commander (`… · Ghalta, Primal Hunger /
  voltron`), because after the commander it is the argument that changes the result most
  and it is otherwise invisible in the transcript.
- Tagger tag filtering is **not** included. `semantic_sort` already reaches tag text
  softly — up to twelve tags per card are in the indexed document — and removes nothing,
  whereas a hard tag filter over a sidecar with uneven coverage returns an empty page
  for a near-miss name, which the agent cannot tell from "no such cards exist".
- `commander.card` is one card. Partner and background command zones are unhandled here,
  matching what `see_cards`' `inclusion` detail already does, and both should be fixed
  together.
- The named card is not checked for being a legal commander. Colour identity is
  well-defined for any card, and EDHREC reporting nothing is already informative.

## Alternatives Considered

- **Call the whole `AgenticCardSearchService`.** An agent calling an agent: a second
  model round trip per search, and an inner model re-interpreting a query the outer one
  had already understood.
- **A parallel filter path in `deck_agent_tools`.** Would duplicate
  `_filter_local_candidates` and every trap already measured against it.
- **Defaulting the commander to the open deck's command zone.** Cheapest for the common
  case, and the reason it was rejected is in the Decision above: the agent would inherit
  a hard filter it never chose, on the surface where nothing reports what a filter
  removed.
- **Pushing results into the search drawer** so they could be dragged into the deck.
  Deferred: it needs a new stream event and leaves the drawer's own filter chips
  describing a search they did not run.
