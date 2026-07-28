import { Bug, ChevronDown } from "lucide-react";

import type {
  SearchDebugSummary,
  SearchDebugTraceStage,
} from "../domain/card";

interface SearchTracePanelProps {
  debug: SearchDebugSummary;
}

interface StagePresentation {
  label: string;
  description: string;
  tone: "request" | "model" | "tool" | "result" | "validation" | "fuzzy";
}

const DETAIL_LABELS: Array<[string, string]> = [
  ["algorithm", "Matching algorithm"],
  ["minimum_score", "Minimum score"],
  ["catalog_card_count", "Catalog cards"],
  ["filtered_card_count", "After filters"],
  ["removed_by_filters", "Removed by filters"],
  ["page", "Page"],
  ["page_size", "Page size"],
  ["page_start", "Page start"],
  ["page_end", "Page end"],
  ["top_score", "Top score"],
  ["error_type", "Error"],
];

const STAGE_PRESENTATIONS: Record<string, StagePresentation> = {
  request_context: {
    label: "Request context",
    description: "Query, filters, and confident fuzzy previews",
    tone: "request",
  },
  initial_model_request: {
    label: "Planning request",
    description: "Prompt and tools sent to the model",
    tone: "model",
  },
  initial_model_response: {
    label: "Planning response",
    description: "The model selects exactly one search tool",
    tone: "model",
  },
  tool_call: {
    label: "Tool call",
    description: "Validated search arguments",
    tone: "tool",
  },
  tool_result: {
    label: "Tool result",
    description: "Candidates returned to the model",
    tone: "tool",
  },
  final_model_request: {
    label: "Ranking request",
    description: "Candidates sent back for final ranking",
    tone: "model",
  },
  final_model_response: {
    label: "Ranking response",
    description: "Interpretation and ranked card IDs",
    tone: "result",
  },
  validation: {
    label: "Validation",
    description: "Checks that every returned ID is valid",
    tone: "validation",
  },
};

export function SearchTracePanel({ debug }: SearchTracePanelProps) {
  const trace = debug.trace;
  const strategy = textValue(trace.decision.strategy) ?? "undecided";
  const inputKind = textValue(trace.decision.input_kind);
  const query = textValue(trace.request.query);

  return (
    <details className="search-debug">
      <summary>
        <Bug aria-hidden="true" size={14} />
        <span>Search trace</span>
        <span className="search-debug__route">{strategy}</span>
        <strong>{formatDuration(debug.total_duration_ms)}</strong>
        <ChevronDown
          className="search-debug__chevron"
          aria-hidden="true"
          size={14}
        />
      </summary>
      <div className="search-debug__body">
        <div className="search-debug__overview">
          <span>
            <small>Query</small>
            <code>{query ?? "Unknown"}</code>
          </span>
          <span>
            <small>Input</small>
            <strong>{inputKind ?? "unknown"}</strong>
          </span>
          <span>
            <small>Steps</small>
            <strong>{trace.stages.length}</strong>
          </span>
          <span>
            <small>Log</small>
            <strong>{debug.log_written ? "written" : "failed"}</strong>
          </span>
        </div>

        <div className="search-debug__timeline">
          {trace.stages.map((stage, index) => (
            <TraceStage
              key={`${stage.name}-${index}`}
              index={index}
              stage={stage}
            />
          ))}
        </div>

        <details className="search-debug-raw">
          <summary>Full raw trace JSON</summary>
          <pre>{JSON.stringify(trace, null, 2)}</pre>
        </details>

        <footer className="search-debug__footer">
          <span>{debug.log_path}</span>
          <code>{debug.trace_id}</code>
        </footer>
      </div>
    </details>
  );
}

function TraceStage({
  index,
  stage,
}: {
  index: number;
  stage: SearchDebugTraceStage;
}) {
  const presentation = stagePresentation(stage.name);

  return (
    <details
      className={[
        "search-debug-layer",
        `search-debug-layer--${stage.status}`,
        `search-debug-layer--${presentation.tone}`,
      ].join(" ")}
      open
    >
      <summary>
        <span className="search-debug-layer__number">{index + 1}</span>
        <span className="search-debug-layer__title">
          <strong>{presentation.label}</strong>
          <small>{presentation.description}</small>
        </span>
        <span className="search-debug-layer__count">
          {formatCounts(stage)}
        </span>
        <strong>{formatDuration(stage.duration_ms)}</strong>
        <ChevronDown aria-hidden="true" size={13} />
      </summary>

      <div className="search-debug-layer__body">
        <TraceStageContent stage={stage} />
      </div>
    </details>
  );
}

function TraceStageContent({ stage }: { stage: SearchDebugTraceStage }) {
  if (stage.name === "request_context") {
    return <RequestContext details={stage.details} />;
  }
  if (
    stage.name === "initial_model_request" ||
    stage.name === "final_model_request"
  ) {
    return <ModelRequest details={stage.details} />;
  }
  if (
    stage.name === "initial_model_response" ||
    stage.name === "final_model_response"
  ) {
    return (
      <ModelResponse
        details={stage.details}
        outputCards={stage.output?.top ?? []}
      />
    );
  }
  if (stage.name === "tool_call") {
    return <ToolCall details={stage.details} />;
  }
  if (stage.name === "tool_result") {
    return <ToolResult details={stage.details} />;
  }
  if (stage.name === "validation") {
    return <ValidationResult details={stage.details} />;
  }
  return <FuzzyStage stage={stage} />;
}

function RequestContext({
  details,
}: {
  details: Record<string, unknown> | undefined;
}) {
  const filters = recordValue(details?.filters);
  const previews = recordList(details?.preview_candidates);
  const activeFilters = filters ? meaningfulEntries(filters) : [];

  return (
    <>
      <section className="search-debug-card search-debug-card--request">
        <header>
          <strong>User query</strong>
          <span>{previews.length} confident title previews</span>
        </header>
        <code className="search-debug-query">
          {textValue(details?.query) ?? "Unknown query"}
        </code>
        <div className="search-debug-chips">
          {activeFilters.length > 0 ? (
            activeFilters.map(([key, value]) => (
              <span key={key}>
                {humanize(key)}: {inlineValue(value)}
              </span>
            ))
          ) : (
            <span>No active UI filters</span>
          )}
        </div>
      </section>

      {previews.length > 0 ? (
        <CardCandidateList
          candidates={previews}
          title="Fuzzy previews already shown"
        />
      ) : null}
      <StageRawPayload details={details} />
    </>
  );
}

function ModelRequest({
  details,
}: {
  details: Record<string, unknown> | undefined;
}) {
  const messages = recordList(details?.messages);
  const tools = recordList(details?.tools);
  const reasoning = recordValue(details?.reasoning);

  return (
    <>
      <TraceMeta
        values={[
          ["Model", textValue(details?.model)],
          ["Tool choice", textValue(details?.tool_choice)],
          ["Messages", messages.length],
          ["Tools", tools.length],
          ["Temperature", numberValue(details?.temperature)],
          ["Reasoning", textValue(reasoning?.effort)],
        ]}
      />
      <MessageList messages={messages} />
      {tools.length > 0 ? (
        <details className="search-debug-nested">
          <summary>
            Available tools
            <span>{tools.map(toolName).filter(Boolean).join(", ")}</span>
          </summary>
          <pre>{JSON.stringify(tools, null, 2)}</pre>
        </details>
      ) : null}
      <StageRawPayload details={details} />
    </>
  );
}

function ModelResponse({
  details,
  outputCards,
}: {
  details: Record<string, unknown> | undefined;
  outputCards: Array<{ rank: number; scryfall_id: string; name: string }>;
}) {
  const choice = recordList(details?.choices)[0];
  const message = recordValue(choice?.message);
  const usage = recordValue(details?.usage);
  const content = textValue(message?.content);
  const parsedContent = parseJsonRecord(content);
  const toolCalls = recordList(message?.tool_calls);
  const reasoning = textValue(message?.reasoning);
  const reasoningDetails = message?.reasoning_details;
  const rankedIds = parsedContent ? stringList(parsedContent.ranked_ids) : [];
  const interpretation = parsedContent
    ? textValue(parsedContent.interpretation)
    : null;

  return (
    <>
      <TraceMeta
        values={[
          ["Model", textValue(details?.model)],
          ["Provider", textValue(details?.provider)],
          ["Finish", textValue(choice?.finish_reason)],
          ["Tokens", numberValue(usage?.total_tokens)],
          ["Cached", numberValue(recordValue(usage?.prompt_tokens_details)?.cached_tokens)],
          ["Cost", currencyValue(usage?.cost)],
        ]}
      />

      {reasoning ? (
        <section className="search-debug-card search-debug-card--reasoning">
          <header>
            <strong>Model reasoning</strong>
          </header>
          <p>{reasoning}</p>
        </section>
      ) : null}

      {reasoningDetails !== null && reasoningDetails !== undefined ? (
        <details className="search-debug-nested search-debug-nested--reasoning">
          <summary>
            Reasoning relay JSON
            <span>{recordList(reasoningDetails).length || "available"}</span>
          </summary>
          <pre>{JSON.stringify(reasoningDetails, null, 2)}</pre>
        </details>
      ) : null}

      {toolCalls.length > 0 ? (
        <section className="search-debug-card search-debug-card--tool">
          <header>
            <strong>Requested tool call</strong>
            <span>{toolCalls.length}</span>
          </header>
          {toolCalls.map((call, index) => {
            const fn = recordValue(call.function);
            return (
              <div className="search-debug-call" key={`${textValue(call.id)}-${index}`}>
                <code>{textValue(fn?.name) ?? "unknown_tool"}</code>
                <pre>{prettyJsonText(textValue(fn?.arguments))}</pre>
              </div>
            );
          })}
        </section>
      ) : null}

      {interpretation ? (
        <section className="search-debug-card search-debug-card--result">
          <header>
            <strong>Final interpretation</strong>
            <span>{rankedIds.length} ranked IDs</span>
          </header>
          <p>{interpretation}</p>
        </section>
      ) : null}

      {content && !interpretation ? (
        <TraceMessage role="assistant" content={content} />
      ) : null}

      {outputCards.length > 0 ? (
        <section className="search-debug-ranking">
          <h4>Top ranked output</h4>
          <div>
            {outputCards.slice(0, 8).map((card) => (
              <span key={card.scryfall_id}>
                <strong>{card.name}</strong>
                <small>rank #{card.rank}</small>
              </span>
            ))}
          </div>
        </section>
      ) : null}
      <StageRawPayload details={details} />
    </>
  );
}

function ToolCall({
  details,
}: {
  details: Record<string, unknown> | undefined;
}) {
  const argumentsValue = details?.arguments ?? details?.raw_arguments;
  const normalizations = stringList(details?.provider_boundary_normalizations);

  return (
    <>
      <section className="search-debug-card search-debug-card--tool">
        <header>
          <strong>{textValue(details?.name) ?? "Unknown tool"}</strong>
          <span>{textValue(details?.tool_call_id)}</span>
        </header>
        <div className="search-debug-call">
          <small>Validated arguments</small>
          <pre>{JSON.stringify(argumentsValue ?? {}, null, 2)}</pre>
        </div>
        {normalizations.length > 0 ? (
          <div className="search-debug-normalizations">
            <strong>Provider input normalized</strong>
            {normalizations.map((normalization) => (
              <span key={normalization}>{normalization}</span>
            ))}
          </div>
        ) : null}
      </section>
      <StageRawPayload details={details} />
    </>
  );
}

function ToolResult({
  details,
}: {
  details: Record<string, unknown> | undefined;
}) {
  const candidates = recordList(details?.candidates);
  const compiledQuery = recordValue(details?.compiled_query);
  const request = recordValue(details?.request);

  return (
    <>
      <TraceMeta
        values={[
          ["Catalog", numberValue(details?.total_candidates)],
          ["Returned", candidates.length],
          ["Engine", textValue(compiledQuery?.engine)],
          ["Semantic", textValue(compiledQuery?.semantic_mode)],
          ["Limit", numberValue(compiledQuery?.result_limit)],
        ]}
      />
      {request ? (
        <details className="search-debug-nested" open>
          <summary>
            Search specification
            <span>local tool filters</span>
          </summary>
          <pre>{JSON.stringify(request, null, 2)}</pre>
        </details>
      ) : null}
      {candidates.length > 0 ? (
        <CardCandidateList candidates={candidates} title="Returned candidates" />
      ) : null}
      {compiledQuery ? (
        <details className="search-debug-nested">
          <summary>
            Compiled query
            <span>{textValue(compiledQuery.engine) ?? "provider query"}</span>
          </summary>
          <pre>{JSON.stringify(compiledQuery, null, 2)}</pre>
        </details>
      ) : null}
      <StageRawPayload details={details} />
    </>
  );
}

function ValidationResult({
  details,
}: {
  details: Record<string, unknown> | undefined;
}) {
  const inventedIds = stringList(details?.invented_ids);
  const status = textValue(details?.status) ?? "unknown";

  return (
    <>
      <section className="search-debug-card search-debug-card--validation">
        <header>
          <strong>{status === "accepted" ? "Ranking accepted" : humanize(status)}</strong>
          <span>{numberValue(details?.candidate_count) ?? 0} candidates</span>
        </header>
        <div className="search-debug-checks">
          <span>
            <b>{details?.all_candidates_ranked === true ? "✓" : "!"}</b>
            Every candidate ranked
          </span>
          <span>
            <b>{inventedIds.length === 0 ? "✓" : "!"}</b>
            {inventedIds.length === 0
              ? "No invented card IDs"
              : `${inventedIds.length} invented IDs rejected`}
          </span>
        </div>
      </section>
      <StageRawPayload details={details} />
    </>
  );
}

function FuzzyStage({ stage }: { stage: SearchDebugTraceStage }) {
  const detailRows = DETAIL_LABELS.flatMap(([key, label]) => {
    if (!stage.details || !(key in stage.details)) {
      return [];
    }
    return [
      {
        key,
        label,
        value:
          key === "top_score"
            ? percentageValue(stage.details[key])
            : displayValue(stage.details[key]),
      },
    ];
  });
  const fuzzyCandidates = recordList(stage.details?.fuzzy_candidates);
  const outputCards = stage.output?.top.slice(0, 8) ?? [];

  return (
    <>
      {detailRows.length > 0 ? (
        <dl className="search-debug-layer__facts">
          {detailRows.map(({ key, label, value }) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {outputCards.length > 0 ? (
        <section className="search-debug-ranking">
          <h4>Top output</h4>
          <div>
            {outputCards.map((card) => (
              <span key={card.scryfall_id}>
                <strong>{card.name}</strong>
                <small>rank #{card.rank}</small>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {fuzzyCandidates.length > 0 ? (
        <NameCandidateList
          candidates={fuzzyCandidates}
          title="Title candidates"
        />
      ) : null}
      <StageRawPayload details={stage.details} />
    </>
  );
}

function TraceMeta({
  values,
}: {
  values: Array<[string, string | number | null]>;
}) {
  const visibleValues = values.filter(([, value]) => value !== null);
  if (visibleValues.length === 0) {
    return null;
  }
  return (
    <div className="search-debug-exchange__meta">
      {visibleValues.map(([label, value]) => (
        <span key={label}>
          <small>{label}</small>
          <strong>{value}</strong>
        </span>
      ))}
    </div>
  );
}

function MessageList({ messages }: { messages: Record<string, unknown>[] }) {
  if (messages.length === 0) {
    return null;
  }
  return (
    <section className="search-debug-messages">
      <h4>Conversation sent to model</h4>
      {messages.map((message, index) => (
        <TraceMessage
          key={`${textValue(message.role) ?? "message"}-${index}`}
          role={textValue(message.role) ?? "message"}
          content={message.content}
        />
      ))}
    </section>
  );
}

function TraceMessage({
  role,
  content,
}: {
  role: string;
  content: unknown;
}) {
  const text = contentText(content);
  const preview = compactText(text).slice(0, 120);
  return (
    <details className={`search-debug-message search-debug-message--${role}`}>
      <summary>
        <strong>{humanize(role)}</strong>
        <span>{preview || "Structured message"}</span>
      </summary>
      <pre>{text || "No text content"}</pre>
    </details>
  );
}

function CardCandidateList({
  candidates,
  title,
}: {
  candidates: Record<string, unknown>[];
  title: string;
}) {
  return (
    <section className="search-debug-card-list">
      <h4>{title}</h4>
      <div>
        {candidates.slice(0, 12).map((candidate, index) => {
          const card = recordValue(candidate.card) ?? candidate;
          return (
            <span key={`${textValue(card.scryfall_id) ?? textValue(card.name)}-${index}`}>
              <b>{index + 1}</b>
              <span>
                <strong>{textValue(card.name) ?? "Unknown card"}</strong>
                <small>
                  {[textValue(card.mana_cost), textValue(card.type_line)]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
            </span>
          );
        })}
      </div>
      {candidates.length > 12 ? (
        <small className="search-debug-card-list__remainder">
          + {candidates.length - 12} more candidates in raw payload
        </small>
      ) : null}
    </section>
  );
}

function NameCandidateList({
  candidates,
  title,
}: {
  candidates: Record<string, unknown>[];
  title: string;
}) {
  return (
    <section className="search-debug-candidates">
      <h4>{title}</h4>
      <div>
        {candidates.map((candidate, index) => {
          const returned = candidate.returned_after_filters;
          const status =
            returned === false
              ? "filtered out"
              : textValue(candidate.match_kind)?.replaceAll("_", " ") ??
                "ranked";
          const alias = textValue(candidate.matched_alias);
          return (
            <span key={`${textValue(candidate.name) ?? "candidate"}-${index}`}>
              <strong>{textValue(candidate.name) ?? "Unknown card"}</strong>
              <small>
                {status}
                {alias ? ` · via "${alias}"` : ""}
              </small>
              <code>
                {numberValue(candidate.score) === null
                  ? "–"
                  : `${Math.round(numberValue(candidate.score)! * 100)}%`}
              </code>
            </span>
          );
        })}
      </div>
    </section>
  );
}

function StageRawPayload({
  details,
}: {
  details: Record<string, unknown> | undefined;
}) {
  return (
    <details className="search-debug-raw search-debug-raw--stage">
      <summary>Raw stage payload</summary>
      <pre>{JSON.stringify(details ?? {}, null, 2)}</pre>
    </details>
  );
}

function stagePresentation(name: string): StagePresentation {
  return (
    STAGE_PRESENTATIONS[name] ?? {
      label: humanize(name),
      description: "Search pipeline step",
      tone: name.includes("fuzzy") ? "fuzzy" : "request",
    }
  );
}

function formatCounts(stage: SearchDebugTraceStage): string {
  if (stage.input && stage.output) {
    return `${stage.input.count} → ${stage.output.count}`;
  }
  if (stage.output) {
    return String(stage.output.count);
  }
  return "";
}

function meaningfulEntries(
  record: Record<string, unknown>,
): Array<[string, unknown]> {
  return Object.entries(record).filter(([key, value]) => {
    if (value === null || value === undefined || value === false) {
      return false;
    }
    if (key === "color_mode" && value === "subset") {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return value !== "";
  });
}

function toolName(tool: Record<string, unknown>): string {
  return textValue(recordValue(tool.function)?.name) ?? "";
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    return recordValue(JSON.parse(value));
  } catch {
    return null;
  }
}

function prettyJsonText(value: string | null): string {
  if (!value) {
    return "{}";
  }
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  return JSON.stringify(value, null, 2);
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function humanize(value: string): string {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function inlineValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(String).join(", ");
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

function currencyValue(value: unknown): string | null {
  const number = numberValue(value);
  if (number === null) {
    return null;
  }
  return `$${number.toFixed(number < 0.01 ? 5 : 3)}`;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "Automatic";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = recordValue(item);
        return record ? [record] : [];
      })
    : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => (typeof item === "string" ? [item] : []))
    : [];
}

function textValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function percentageValue(value: unknown): string {
  const number = numberValue(value);
  return number === null ? "Automatic" : `${Math.round(number * 100)}%`;
}

function formatDuration(value: number): string {
  if (value <= 0) {
    return "instant";
  }
  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })}ms`;
}
