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

## Updating Decisions

- Do not edit an accepted ADR to make history appear cleaner.
- Small clarifications that do not change the decision are allowed.
- Material changes require a new ADR that supersedes the old one.
- Update this index, `implementation-status.md`, and `changelog.md` when a
  decision changes state.
