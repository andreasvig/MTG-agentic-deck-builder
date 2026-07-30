# ADR 0020: The System Prompt Owns All Agent Logic

- Status: Accepted
- Date: 2026-07-30
- Relates to: ADR 0009, ADR 0019

## Context

Instructions to the search agent had accumulated in four places at once: the
`system_prompt` in `config.yaml`, the rendered user message, the
`search_local_cards` tool description, and the Pydantic field descriptions that
become that tool's JSON schema.

The same rule was often stated in several of them, and the copies drifted. After
ADR 0019 removed the query-wording filter guard, the tool description still
read "use types or colors only when the user's search text explicitly asks",
directly contradicting the system prompt that now teaches the opposite. The user
message also carried strategy — how to broaden a continuation round, what
temporary IDs mean, that a tool call must happen now — so tuning behavior meant
editing Python string concatenation rather than a prompt.

Duplication is the defect. Any instruction stated twice can disagree with
itself, and nothing in the pipeline detects that.

## Decision

One home per concern:

- **System prompt** (`config.yaml`) owns every rule, definition, and worked
  example. It is static text with no runtime injection, written in Markdown
  using this skeleton:

  ```text
  # Task
  # Inputs
  # Output
  # Tools
  # Guidelines
  ```

  `# Inputs` names each section the user message can contain, so the model
  learns the input format from the prompt rather than from prose in the data.
  Examples live under `# Guidelines` and are hand-written in the file — never
  assembled from runtime values.

- **User message** carries labelled data only: `## Request`,
  `## Interface filters`, `## Commander`, `## Fuzzy matches already shown`,
  `## Already showing`, `## Previous tool searches`, `## Round`. A section is
  omitted entirely when it has no data. No sentence in it may instruct the
  model.

- **Tool result message** carries labelled data only: `## Search` and
  `## Candidates (n)`. How to interpret semantic closeness, EDHREC evidence, and
  temporary IDs is explained once, in the system prompt.

- **Tool description** is a single line naming what the tool does. All schema
  field descriptions state shape and units only, never strategy or when to use a
  field.

## Consequences

Positive:

- A behavior change is one edit in one YAML block, reviewable as prose.
- The tool schema can no longer contradict the prompt, because it no longer
  makes claims about intent.
- Traces are readable: the user message is visibly the request and its context,
  not a wall of instructions repeated every round.
- Prompt content is testable. `test_health` asserts the skeleton headings and
  validates every worked example against `LocalCardSearchRequest`, so an example
  cannot drift out of schema.

Costs:

- The model must map `## Inputs` descriptions onto the sections it actually
  receives; a renamed section is now a two-place change (renderer plus prompt),
  and only a test catches the mismatch.
- Per-field schema descriptions no longer nudge usage, so the system prompt must
  cover any field the model misuses.

## Rejected Alternatives

- Keep the guidance duplicated but add a consistency test. Rejected: a test that
  compares prose to prose cannot tell agreement from contradiction.
- Move all logic into the tool description instead. Rejected: providers truncate
  and reformat tool schemas, and it cannot carry input-format or output rules.
- Template the system prompt with runtime values. Rejected: it reintroduces
  injected content and makes the effective prompt unreadable outside a live run.
