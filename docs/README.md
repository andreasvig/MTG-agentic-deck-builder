# Documentation Index

This directory separates current implementation facts, durable decisions, and
future plans.

## Read Order For New Contributors

1. [`../README.md`](../README.md) - product snapshot and quick start.
2. [`implementation-status.md`](implementation-status.md) - shipped, partial,
   and not-started features.
3. [`architecture.md`](architecture.md) - current runtime, modules, contracts,
   and ownership.
4. [`development.md`](development.md) - environment, commands, testing, and
   common change workflows.
5. [`search.md`](search.md) - fuzzy/agentic search, filters, EDHREC commander/theme evidence,
   configuration, and traces.
6. [`decisions/README.md`](decisions/README.md) - accepted and proposed ADRs.
7. [`../plan.md`](../plan.md) - product scope and roadmap.

## Document Types

### Current Facts

- [`implementation-status.md`](implementation-status.md)
- [`architecture.md`](architecture.md)
- [`development.md`](development.md)
- [`search.md`](search.md)

These must stay synchronized with code in the same commit.

### Decisions

- [`decisions/`](decisions/)

ADRs explain why durable choices were made. An accepted ADR should not be
silently contradicted by implementation.

### Product Direction

- [`../plan.md`](../plan.md)

This document guides scope and tradeoffs. Planned items are not evidence of
implementation.

### History

- [`../changelog.md`](../changelog.md)

The changelog records notable delivered changes. Git history remains the detailed
source of chronology.

## Status Vocabulary

- **Shipped**: implemented, reachable in the product, and covered by tests.
- **Partial**: a useful subset exists, but named requirements remain.
- **Planned**: accepted scope or direction with no complete implementation.
- **Deferred**: intentionally outside the current phase.
- **Rejected**: considered and deliberately not pursued.

Use these labels instead of ambiguous phrases such as "supported" or "current"
when the implementation state matters.
