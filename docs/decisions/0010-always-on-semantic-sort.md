# ADR 0010: Always-On Semantic Sort Inside Local Card Search

- Status: Accepted
- Date: 2026-07-28
- Amends: ADR 0009

ADR 0014 later replaces this record's v1 document shape while preserving its
always-on, no-score-cutoff semantic-sort decision.

## Context

ADR 0009 reserved `oracle_text.semantic_query` for a later embedding
implementation and required the agent to avoid it while the capability was
disabled. That made one field behave unlike the rest of the tool while also
describing it as a query that might filter results.

The intended behavior is simpler:

- structured conditions decide which cards are eligible;
- semantic similarity changes their order;
- no card is rejected because its semantic score is low;
- the existing local-tool result limit bounds what the final model sees.

## Decision

- Replace `oracle_text.semantic_query` with top-level `semantic_sort`.
- Treat every other structured tool field as a hard filter.
- Apply immutable UI filters, agent filters, and continuation exclusions before
  semantic scoring.
- Cosine-sort every surviving candidate without a similarity threshold.
- Return only the configured top candidate count after sorting.
- Keep `semantic_sort` optional in the reusable tool contract, but default it
  to the original user request in agent orchestration when the model omits it.
- Remove the semantic enabled flag and runtime capability warning. A current
  semantic index is part of the catalog contract.
- Use the local `BAAI/bge-small-en-v1.5` FastEmbed ONNX model.
- Embed stable gameplay documents containing name, mana cost, type line, Oracle
  text, power/toughness, and card-face details.
- Store normalized vectors in an atomic SQLite sidecar tied to the exact catalog
  modification time, source metadata, model, indexed fields, and template
  version.
- Make `npm run catalog:sync` ensure both the card catalog and semantic index.
- Return a safe agentic failure when the index is absent or stale rather than
  silently substituting lexical ranking.
- Teach the model that vague meaning belongs in `semantic_sort`, while exact
  Oracle text and other structured fields should be used only for justified
  constraints.

## Consequences

Positive:

- The tool contract says exactly which fields filter and which field sorts.
- Broad natural-language intent keeps recall instead of being lost to guessed
  literal rules text.
- Semantic ranking is deterministic, local, observable, and independent from
  the chat provider.
- There is no new relevance threshold to tune.
- Exact filters and semantic meaning can work together in one bounded tool call.

Costs:

- Initial setup downloads approximately 67 MB of model files.
- Catalog refreshes must also refresh roughly 33,000 card embeddings.
- The semantic sidecar consumes additional local disk space.
- Query embedding and vector scoring add local CPU latency to agent rounds.
- Changing the model, document fields, catalog, or template invalidates the
  sidecar and requires a rebuild.

## Rejected Alternatives

- Keep a disabled capability flag: rejected because it complicates the prompt
  and permits an advertised tool field to fail by configuration.
- Use semantic similarity as a minimum-score filter: rejected because the final
  model already decides relevance and the product deliberately avoids hidden
  retrieval cutoffs.
- Embed through the chat provider on every request: rejected because card
  documents are stable and should be cached locally.
- Restore the former layered semantic/reranker pipeline: rejected because
  semantic ordering belongs inside the one accepted local tool.
