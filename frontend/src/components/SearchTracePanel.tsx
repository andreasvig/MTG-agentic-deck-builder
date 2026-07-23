import { Bug, ChevronDown } from "lucide-react";

import type {
  SearchDebugSummary,
  SearchDebugTraceStage,
} from "../domain/card";

interface SearchTracePanelProps {
  debug: SearchDebugSummary;
}

const DETAIL_LABELS: Array<[string, string]> = [
  ["candidate_query", "Candidate query"],
  ["provider_query", "Scryfall query"],
  ["provider_order", "Scryfall order"],
  ["provider_total_results", "Provider results"],
  ["interpretation", "Interpretation"],
  ["reason", "Decision"],
  ["provider_match", "Closest match"],
  ["accepted_by_filters", "Passed filters"],
  ["model", "Model"],
  ["provider", "Provider"],
  ["reasoning_effort", "Reasoning"],
  ["candidate_limit", "LLM candidates"],
  ["max_tokens", "Output limit"],
  ["error_type", "Error"],
];

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
            <small>Layers</small>
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
  const detailRows = DETAIL_LABELS.flatMap(([key, label]) => {
    if (!stage.details || !(key in stage.details)) {
      return [];
    }
    return [{ key, label, value: displayValue(stage.details[key]) }];
  });
  const exchange = recordValue(stage.details?.exchange);
  const outputCards = stage.output?.top.slice(0, 8) ?? [];
  const rankChanges = stage.rank_changes?.slice(0, 12) ?? [];

  return (
    <details
      className={`search-debug-layer search-debug-layer--${stage.status}`}
      open={stage.name === "OpenRouter ranking"}
    >
      <summary>
        <span className="search-debug-layer__number">{index + 1}</span>
        <span className="search-debug-layer__title">
          <strong>{stage.name}</strong>
          <small>{stage.status}</small>
        </span>
        <span className="search-debug-layer__count">
          {formatCounts(stage)}
        </span>
        <strong>{formatDuration(stage.duration_ms)}</strong>
        <ChevronDown aria-hidden="true" size={13} />
      </summary>

      <div className="search-debug-layer__body">
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

        {rankChanges.length > 0 ? (
          <section className="search-debug-ranking">
            <h4>Rank changes</h4>
            <div>
              {rankChanges.map((change) => (
                <span key={change.scryfall_id}>
                  <strong>{change.name}</strong>
                  <small>
                    {change.before_rank === null
                      ? "new"
                      : `#${change.before_rank}`}
                    {" → "}
                    #{change.after_rank}
                  </small>
                  <b className={rankDeltaClass(change.delta)}>
                    {formatRankDelta(change.delta)}
                  </b>
                </span>
              ))}
            </div>
          </section>
        ) : outputCards.length > 0 ? (
          <section className="search-debug-ranking">
            <h4>Top output</h4>
            <div>
              {outputCards.map((card) => (
                <span key={card.scryfall_id}>
                  <strong>{card.name}</strong>
                  <small>#{card.rank}</small>
                </span>
              ))}
            </div>
          </section>
        ) : null}

        {exchange ? <LlmExchange exchange={exchange} /> : null}
      </div>
    </details>
  );
}

function LlmExchange({ exchange }: { exchange: Record<string, unknown> }) {
  const request = recordValue(exchange.request);
  const response = recordValue(exchange.response);
  const requestBody = recordValue(request?.body);
  const responseBody = recordValue(response?.body);
  const requestMessages = Array.isArray(requestBody?.messages)
    ? requestBody.messages.flatMap((message) => {
        const parsed = recordValue(message);
        return parsed ? [parsed] : [];
      })
    : [];
  const choices = Array.isArray(responseBody?.choices)
    ? responseBody.choices.flatMap((choice) => {
        const parsed = recordValue(choice);
        return parsed ? [parsed] : [];
      })
    : [];
  const assistantMessage = recordValue(choices[0]?.message);
  const usage = recordValue(responseBody?.usage);

  return (
    <div className="search-debug-exchange">
      <section>
        <header>
          <h4>LLM request</h4>
          <span>{textValue(requestBody?.model) ?? "Unknown model"}</span>
        </header>
        <div className="search-debug-exchange__meta">
          <span>
            {textValue(recordValue(requestBody?.reasoning)?.effort) ??
              "default"}{" "}
            reasoning
          </span>
          <span>
            {numberValue(requestBody?.max_tokens)?.toLocaleString() ?? "?"} max
            tokens
          </span>
          {providerValue(requestBody?.provider) ? (
            <span>{providerValue(requestBody?.provider)}</span>
          ) : null}
        </div>
        <div className="search-debug-messages">
          {requestMessages.map((message, index) => (
            <article key={`${textValue(message.role) ?? "message"}-${index}`}>
              <strong>{textValue(message.role) ?? "message"}</strong>
              <pre>{formatMessageContent(message.content)}</pre>
            </article>
          ))}
        </div>
        <RawJson
          label="Exact raw request JSON"
          value={textValue(request?.raw_body)}
        />
      </section>

      <section>
        <header>
          <h4>LLM response</h4>
          <span>
            HTTP {numberValue(response?.status_code) ?? "no response"}
          </span>
        </header>
        <div className="search-debug-exchange__meta">
          {textValue(responseBody?.provider) ? (
            <span>{textValue(responseBody?.provider)}</span>
          ) : null}
          {numberValue(usage?.total_tokens) !== null ? (
            <span>
              {numberValue(usage?.total_tokens)?.toLocaleString()} tokens
            </span>
          ) : null}
          {numberValue(usage?.cost) !== null ? (
            <span>${numberValue(usage?.cost)?.toFixed(6)}</span>
          ) : null}
        </div>
        {assistantMessage ? (
          <div className="search-debug-messages">
            <article>
              <strong>assistant</strong>
              <pre>{formatMessageContent(assistantMessage.content)}</pre>
            </article>
          </div>
        ) : null}
        <RawJson
          label="Exact raw response JSON"
          value={textValue(response?.raw_body)}
        />
      </section>
    </div>
  );
}

function RawJson({ label, value }: { label: string; value: string | null }) {
  if (!value) {
    return null;
  }
  return (
    <details className="search-debug-raw">
      <summary>{label}</summary>
      <pre>{prettyJson(value)}</pre>
    </details>
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

function formatMessageContent(value: unknown): string {
  if (typeof value !== "string") {
    return JSON.stringify(value, null, 2);
  }
  return prettyJson(value);
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function providerValue(value: unknown): string | null {
  const provider = recordValue(value);
  const only = provider && Array.isArray(provider.only) ? provider.only : [];
  return only.filter((item): item is string => typeof item === "string").join(", ") || null;
}

function formatDuration(value: number): string {
  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })}ms`;
}

function formatRankDelta(delta: number | null): string {
  if (delta === null || delta === 0) {
    return "–";
  }
  return delta > 0 ? `+${delta}` : String(delta);
}

function rankDeltaClass(delta: number | null): string {
  if (delta === null || delta === 0) {
    return "";
  }
  return delta > 0 ? "is-up" : "is-down";
}
