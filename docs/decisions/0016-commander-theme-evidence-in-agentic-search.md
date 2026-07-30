# ADR 0016: Commander-Theme Evidence in Agentic Search

Status: Accepted

Date: 2026-07-30

Supersedes: [ADR 0015](0015-on-demand-edhrec-commander-ranking.md)

## Context

The first EDHREC integration ranked only blank-query browsing by the selected
commander's overall inclusion rate. Agentic search knew the deck color identity
but not the commander's identity, EDHREC deck themes, inclusion, or synergy.
That prevented the model from distinguishing established staples from cards
that are unusually specific to a commander or a Tokens, Stompy, or other
theme.

## Decision

- Load the selected single commander and its EDHREC `taglinks` themes on demand.
  The interface may optionally select exactly one advertised theme; **All
  commander decks** remains the default.
- Treat commander and theme as immutable interface context. They are passed to
  the agent user prompt and runtime, not exposed as agent-editable filters.
- Cache normal and theme-specific EDHREC JSON separately for 30 days. Persist
  theme metadata and normalize each page's card associations by Oracle ID.
- Give every local-tool candidate its available inclusion, included-deck count,
  potential-deck count, and raw synergy. Absence means “not listed,” not zero.
- Add three primary tool sorts: `semantic`, `edhrec_inclusion`, and
  `edhrec_synergy`. Semantic closeness remains available as evidence and an
  EDHREC-sort tie-breaker. No semantic, inclusion, or synergy threshold removes
  a card.
- The agent may use an EDHREC sort only when the runtime prompt says fresh
  commander evidence is available. The final model may still reorder or omit
  candidates based on the user's request.
- If EDHREC fails, continue the agentic run with local hard filters and semantic
  ranking. Return a typed `unavailable` status so the drawer can explain the
  degraded path.

## Boundaries

- One commander and at most one theme are supported. Partner-pair aggregation,
  budgets, brackets, and multiple-theme intersections are deferred.
- Theme names and deck counts come from EDHREC rather than local inference.
- EDHREC remains optional ranking evidence; Scryfall remains canonical card
  data and interface filters remain authoritative.
- The integration is intended for low-volume personal testing, not bulk
  crawling.

## Consequences

Agentic search can now deliberately prefer broad inclusion, commander-specific
synergy, or semantic intent while seeing all three signals. Theme selection
adds a synchronous on-demand fetch on the first cache miss, but the separate
sidecar and explicit fallback keep local search usable when EDHREC changes or
is unavailable.
