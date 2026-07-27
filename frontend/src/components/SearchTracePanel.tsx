import { Bug, ChevronDown } from "lucide-react";

import type {
  SearchDebugSummary,
  SearchDebugTraceStage,
} from "../domain/card";

interface SearchTracePanelProps {
  debug: SearchDebugSummary;
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
    <details
      className={`search-debug-layer search-debug-layer--${stage.status}`}
      open
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

        {outputCards.length > 0 ? (
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

        {fuzzyCandidates.length > 0 ? (
          <NameCandidateList
            candidates={fuzzyCandidates}
            title="Title candidates"
          />
        ) : null}
      </div>
    </details>
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
  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })}ms`;
}
