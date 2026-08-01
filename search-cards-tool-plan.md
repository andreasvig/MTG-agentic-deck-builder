# `search_cards` — a third deck-agent tool

The deck agent gets the search agent's engine, but drives every filter itself, and
can point it at a commander other than the one in the command zone.

Today the deck agent's system prompt says the opposite:

> you cannot search the catalog for cards you have not been given — when the user
> wants to find cards, tell them to use the card search.

That line is what this change deletes.

## The controlling constraint

Two agents, one engine. `LocalCardSearchTool` already filters, scores and ranks the
whole catalog — semantic index, EDHREC associations, weighted blend, all of it. The
only thing separating the two callers is **who owns the filters**:

| | search agent | deck agent (`search_cards`) |
| --- | --- | --- |
| `LocalCardSearchRequest` | the model writes it | the model writes it |
| `CardSearchFilters` | the **user's filter panel**, applied around the model | the **model**, from its own arguments |
| commander | `commander_oracle_id` on the HTTP request | a tool argument |

So `search_cards` is not a new search. It is the same call with the immutable half
of the filters moved from the interface into the tool schema. Nothing in
`agentic_card_search.py` changes.

## Decisions taken

1. **Commander is a nested object with no default.** Omit it and there is no
   commander: no colour-identity gate, no EDHREC evidence, no EDHREC sorting. The
   agent has to name one to get any of it, and it can name any card in the catalog —
   which is what makes "would this work under {Kinnan, Bonder Prodigy} instead?"
   a single tool call rather than a feature.
2. **Results are agent-only.** The tool returns text; the agent names cards in
   `{braces}` and ADR 0033 already makes those hoverable and openable. No frontend
   change at all.
3. **Tagger tags are deferred.** `semantic_sort` already reaches tag text softly
   (up to twelve tags per card are in the indexed document) and removes nothing. A
   hard tag filter over a sidecar with uneven coverage returns an empty page for a
   near-miss name, and the agent cannot tell that from "no such cards exist".

### Why the commander object splits into three fields

A commander does two unrelated things to a search, and conflating them is how a
search silently deletes the card the user wanted:

- **Colour identity** is a *hard filter*. It removes cards, and nothing downstream
  restores them.
- **EDHREC inclusion and synergy** are *sort signals*. They reorder and remove
  nothing.

`restrict_to_color_identity` separates them, so "rank this by what Atraxa decks
actually play, but show me out-of-identity cards too" is expressible. It maps
directly onto the existing `include_outside_commander_color_identity`, which the
interface already exposes as its own checkbox.

## The contract

```
search_cards(
  # ─── ordering: these move cards, they never remove one ───
  semantic_sort:  string?          # what the cards do, in rules or tag phrasing
  name_sort:      string?          # a card name; requires sort_by name_similarity
  sort_by:        "weighted" | "semantic" | "edhrec_inclusion"
                | "edhrec_synergy" | "name_similarity"     # default weighted

  # ─── hard filters: each one deletes cards the agent will never see ───
  mana:      { value_minimum?, value_maximum?,
               must_contain_all[], must_contain_any[], must_not_contain[] }?
  types:     { must_contain_all[], must_contain_any[], must_not_contain[] }?
  colors:    { identity[], mode: "subset"|"exact", include_colorless }?
  power:     { minimum?, maximum? }?
  toughness: { minimum?, maximum? }?
  price_eur: { minimum?, maximum? }?

  # ─── NEW: what the interface's filter panel used to own ───
  commander: {
    card:                       string      # name, or a read_deck short id
    restrict_to_color_identity: bool = true # the hard filter
    edhrec_theme:               string?     # slug; the result lists valid ones
  }?
  commander_legal_only: bool = true
  exclude_cards_in_deck: bool = false       # see "One addition beyond the ask"

  max_results: int?              # 1..30, default 12
)
```

Everything above the `NEW` block is `LocalCardSearchRequest`, field for field,
unchanged. That is deliberate: the search agent's prompt carries eight tuned
examples and a parsing test contract over exactly these fields, and none of it
should have to be rewritten.

### How the new fields become existing ones

`_search_cards` builds two objects and hands them to `LocalCardSearchTool.search`:

```python
LocalCardSearchRequest        # the base fields, verbatim, no translation

CardSearchFilters(
    include_non_commander_legal            = not args.commander_legal_only,
    commander_color_identity               = resolved.color_identity | None,
    include_outside_commander_color_identity
                                           = not commander.restrict_to_color_identity,
    # every other field left at its default
)
```

Traced through `matches_card_filters` (`search.py:446`): with `colors=[]`,
`include_colorless=False` and `color_mode="subset"`, the exact branch is skipped,
`selected_colors` is falsy, and `include_colorless` is false — so an all-default
`CardSearchFilters` filters nothing. The projection is safe to build sparsely.

`commander.edhrec_theme` and the resolved oracle id go to
`edhrec_service.ranking_for(...)`, and the resulting `EdhrecCommanderRanking` is
passed as the tool's `edhrec_ranking` argument. That is the whole of the EDHREC
wiring — the ranking is the same object `_resolve_commander_context` builds for the
search agent.

### The one guard that behaves oddly

`resolve_local_tool_limit` rejects a call with neither agent criteria nor
non-default filters. `commander_legal_only: true` maps to
`include_non_commander_legal: False`, which *is* the default, so it does not count
as a filter — correct, since it narrows nothing the agent chose. A bare
`search_cards()` is therefore rejected, and `search_cards(commander={...})` is
accepted because `commander_color_identity` is non-default. Both are the behaviour
we want; it is worth knowing it falls out of `exclude_defaults=True` rather than
from anything explicit.

## What comes back

One card-block renderer, two tools. `_card_block`, `_identity_lines`, `_rules_lines`
and `_prices` in `deck_agent_tools.py` already render a card the way this agent
reads cards, so `search_cards` reuses them and appends its search evidence:

```
## Search
Looked for: "mana rock, ramp, mana producer" · sorted by weighted
Commander: "Atraxa, Praetors' Voice" — identity {W}{U}{B}{G}, cards outside it removed
EDHREC: available, theme "counters" · other themes: superfriends, infect, stax
Legality: Commander-legal only
342 cards matched these filters. The best 12 are below.

Name: "Sol Ring"
  Types: "Artifact"
  Mana cost: "{1}"
  Mana value: 1
  Rules: "{T}: Add {C}{C}."
  Price: EUR 1.35
  Semantic closeness: 0.812
  Inclusion: 94% of 41,203 Atraxa decks, synergy +0.11

… 11 more …

Call see_cards with any of these names for tags, similar cards or legality.
```

Three things that block goes out of its way to say:

- **`342 cards matched`.** Without the total the agent cannot tell "these are the
  only twelve" from "these are twelve of hundreds", and will state the first when
  the second is true.
- **What the gates actually did.** The agent typed the filters, but it did not type
  Atraxa's colour identity, and it cannot know whether the EDHREC fetch landed.
- **The available theme slugs**, so picking a theme is a follow-up call rather than
  a guess. An unrecognised slug is a tool error that lists the valid ones.

### Rules text is included, and `max_results` defaults to 12

The search agent returns 24 candidates with full rules text. This one returns 12.

The count is lower because the deck agent's context also carries the transcript and
a `read_deck` listing. Rules text stays because a recommendation without it is
guesswork — and the agent would answer a bare name list by calling `see_cards` on
all twelve, which costs one of only four tool iterations and a second full catalog
scan. Twelve with rules ≈ twenty-four without, and saves the round trip.

Both bounds are config, not constants: `search_cards_default_max_results: 12`,
`search_cards_hard_max_results: 30`.

## Failure is a tool result, never an exception

`LocalCardSearchTool.search` raises `AgentSearchContractError` (EDHREC sort with no
ranking, no criteria at all, `max_results` over the cap) and `CardSearchUnavailable`
(semantic index or Tagger missing). Every one becomes a `DeckAgentToolError` and
therefore a `ToolOutcome(ok=False, …)` whose text the model reads and adapts to —
the same path `see_cards` already uses. A turn must never die because a search was
badly formed.

Specifically:

| Situation | What the model reads |
| --- | --- |
| commander name resolves to nothing | `No card called "Atrxa" — names must match exactly.` |
| `sort_by: edhrec_inclusion`, no commander | `EDHREC ordering needs a commander. Name one, or sort by semantic.` |
| commander set, EDHREC unreachable | Results still return, sorted by the fallback, with `EDHREC: unavailable` in the header |
| unknown `edhrec_theme` | The valid slugs for that commander |
| no criteria at all | `Give at least one filter or a semantic_sort.` |

The middle row matters most: EDHREC is a network fetch behind a 30-day cache, and a
search that dies because a popularity signal was slow is a worse answer than a
search that says so and ranks semantically.

## File map

| File | Change |
| --- | --- |
| `backend/src/mtg_deck_builder/domain/agent_chat.py` | `SearchCardsArguments`, `CommanderArguments` |
| `backend/src/mtg_deck_builder/deck_agent_tools.py` | `SEARCH_CARDS`, its definition, `_search_cards`, `_resolve_commander_argument`, the two projections, the result header |
| `backend/src/mtg_deck_builder/config.py` | `search_cards_description`, the two `max_results` bounds |
| `config.yaml` | the description, the bounds, and the system-prompt edits below |
| `backend/src/mtg_deck_builder/main.py` | a second `LocalCardSearchTool` into `DeckAgentToolbox` |
| `docs/decisions/0035-…` | ADR |

**Wiring.** `DeckAgentToolbox` gains `local_tool: LocalCardSearchTool | None`, and
`main.py` constructs a *second* instance rather than sharing the search agent's —
the bounds differ (12/30 against 24/60) and they are baked in at construction. It is
a cheap object: it holds references to the same catalog, the same semantic index and
the same Tagger sidecar, so nothing is duplicated but the two integers. The
`weighted` blend weights are shared from `search.agentic.ranking.weighted`, because
how much semantic closeness is worth against EDHREC inclusion is a property of the
ranking, not of which agent asked for it.

`enabled` already returns false without a card catalog; it gains the same check for
`local_tool`, and `definitions()` advertises `search_cards` only when it can run.

## Prompt work

Two edits, and they are the risky part of this change.

**1. `agent.system_prompt`** — the "you cannot search the catalog" paragraph is now
false and gets replaced by the third tool and when to reach for it. Same class of
defect as ADR 0034's bracing rule, which told the agent not to brace mana symbols
right up until the interface started drawing them.

**2. `agent.tools.search_cards_description`** — this carries the craft. The search
agent's prompt holds roughly two thousand words of hard-won guidance that applies
verbatim here: functional categories like *removal* and *ramp* span printed types
and must never become a `types` filter; `semantic_sort` cannot see the words
*efficient*, *cheap* or *best*; `include_colorless` defaults to false and therefore
deletes every artifact; a hard filter's bounds should be looser than instinct
because the ranking can narrow but never restore.

Condensed into the tool description rather than the system prompt, because tool
descriptions are already established as prompt text in this codebase, and because
the deck agent needs none of the search agent's continuation-round or `ranked_ids`
sections.

**The cost is drift.** Two prompts now describe one engine, and tuning one will not
tune the other. Mitigated the way this codebase already handles mirrored constants
(`_PRIMARY_TYPE_PRECEDENCE` ↔ `primaryCardType`): a cross-reference comment at both
sites in `config.yaml` saying change one and change the other. Not solved — noted.

## One addition beyond the ask

`exclude_cards_in_deck: false`. `_filter_local_candidates` already accepts
`excluded_oracle_ids`, and `_resolve_deck` already runs, so "find me a ramp piece
I'm not already running" costs one argument and one set comprehension. It is the
most obvious thing a *deck* agent wants from a search and the least obvious thing to
retrofit later, because the default has to be chosen before the prompt is tuned
around it. Easy to strike if you'd rather keep v1 to the ask.

## Verification

**Contract, at import.** `SearchCardsArguments`'s base-field set must equal
`LocalCardSearchRequest.model_fields`, checked at import and raising like
`_MISSING_FROM_DETAIL_ORDER` does. A field added to one and not the other is then a
startup failure rather than a filter that silently stops being sent.

**Tests that bite.**

- Commander omitted → `commander_color_identity is None`, and a mono-red card
  survives a search run from a Bant deck. Mutant: default `restrict` to true with no
  commander present.
- `restrict_to_color_identity: false` **with** a commander → EDHREC ranking still
  loads, identity gate off. The with-and-without-trigger control: the same search
  with `true` must drop the out-of-identity card.
- A commander that is not in the deck resolves and ranks.
- `sort_by: edhrec_inclusion` with EDHREC switched off → `ok=False`, message names
  EDHREC, and **the turn still completes with an answer**.
- Unknown theme slug → error text contains the valid slugs.
- `search_cards()` bare → rejected with the criteria message.

**Mutants to plant.** Invert `include_non_commander_legal = not commander_legal_only`;
drop `excluded_oracle_ids` from the call; pass `commander_color_identity` while
leaving `include_outside_commander_color_identity=True`. Each must kill a named
test — and note *which* test dies, since a failure elsewhere means the invariant is
protected by something other than what I wrote.

**Live.** Three real turns: a ramp search under the deck's own commander; the same
question aimed at a commander not in the deck; and an invalid-value control — a
commander name that does not exist — which must produce the tool error and a
graceful answer rather than a dead turn.

## Deferred

- **Tagger tag filtering**, with fuzzy name→id resolution and the resolved names
  echoed back so a near-miss is visible rather than silent.
- **Partner commanders.** `commander.card` is one card. This matches what
  `see_cards`' `inclusion` detail already does — it takes the first command-zone
  entry — but `plan.md` calls multi-card command zones a product principle, so both
  should be fixed together rather than half here.
- **Validating that the named card can actually be a commander.** Skipped for now:
  colour identity is well-defined for any card, and EDHREC reporting nothing is
  already an informative answer. Backgrounds and *can be your commander* make the
  check less trivial than it looks.
- **Pushing results into the search drawer** so they can be dragged into the deck.
- **Reconciling the two prompts** into one shared source.
