# Architecture Decision Records

ADRs capture durable product and technical choices. They explain context and
tradeoffs; they are not task lists.

## Status Meanings

- **Accepted**: the decision governs current work.
- **Accepted (transitional)**: current implementation is intentional but has a
  named migration target.
- **Proposed**: direction is documented but not yet binding implementation.
- **Superseded**: replaced by a later ADR.
- **Rejected**: explicitly not selected.

## Index

| ADR | Status | Scope |
| --- | --- | --- |
| [0001](0001-local-first-react-fastapi.md) | Accepted | Product and runtime baseline |
| [0002](0002-scryfall-authority-and-derived-catalog.md) | Accepted | Card-data ownership |
| [0003](0003-layered-observable-search.md) | Superseded | Former layered search |
| [0004](0004-browser-local-deck-library.md) | Accepted (transitional) | Current deck persistence |
| [0005](0005-editor-grouping-and-inspection.md) | Accepted | Editor information architecture |
| [0006](0006-agent-uses-typed-deck-patches.md) | Proposed | Future agent mutation safety |
| [0007](0007-single-fuzzy-title-search.md) | Accepted | One fuzzy title-search path |
| [0008](0008-local-catalog-serves-search.md) | Accepted | Local catalog search reads and pagination |
| [0009](0009-progressive-one-tool-agentic-search.md) | Accepted | Progressive one-tool agentic search |
| [0010](0010-always-on-semantic-sort.md) | Accepted | Always-on local semantic sorting |
| [0011](0011-tagger-enrichment-sidecar.md) | Accepted (transitional) | Optional local Tagger data acquisition |
| [0012](0012-immutable-commander-and-tagger-filters.md) | Accepted | Immutable Commander and explicit Tagger filters |
| [0013](0013-recoverable-deck-deletion-and-command-zone-guards.md) | Accepted (transitional) | Local deck deletion and command-zone enforcement |
| [0014](0014-title-resistant-tagger-enriched-semantic-documents.md) | Accepted | Semantic document v2 and bounded Tagger concepts |
| [0015](0015-on-demand-edhrec-commander-ranking.md) | Superseded | Initial blank-query EDHREC commander ranking |
| [0016](0016-commander-theme-evidence-in-agentic-search.md) | Accepted | Commander themes and EDHREC evidence in agentic search |
| [0017](0017-remove-exact-oracle-text-filter.md) | Accepted | Remove brittle exact Oracle-text filtering from the agent tool |
| [0018](0018-runtime-owned-and-query-explicit-filters.md) | Partly superseded | Runtime-owned legality and query-explicit type/color filters |
| [0019](0019-prompt-taught-agent-filters.md) | Accepted | Agent owns its type/color filters; intent taught in the prompt |

## Updating Decisions

- Do not edit an accepted ADR to make history appear cleaner.
- Small clarifications that do not change the decision are allowed.
- Material changes require a new ADR that supersedes the old one.
- Update this index, `implementation-status.md`, and `changelog.md` when a
  decision changes state.
