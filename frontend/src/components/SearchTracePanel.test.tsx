import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";

import {
  failedAgentSearchDebugSummary,
  ghalta,
  searchDebugSummary,
} from "../test/fixtures";
import type { SearchDebugSummary } from "../domain/card";
import { SearchTracePanel } from "./SearchTracePanel";

it("renders readable content for every agentic trace stage", async () => {
  const debug = searchDebugSummary();
  debug.trace.decision = {
    strategy: "agentic",
    input_kind: "card_search_query",
  };
  debug.trace.stages = [
    {
      name: "system_prompt",
      status: "ok",
      duration_ms: 0,
      details: {
        content: "Choose exactly one search tool.",
      },
    },
    {
      name: "user_input_prompt",
      status: "ok",
      duration_ms: 0,
      details: {
        content:
          'Please find cards for "galtha".\n1. Ghalta, Primal Hunger',
      },
    },
    {
      name: "thinking",
      status: "ok",
      duration_ms: 100,
      details: {
        phase: "tool_selection",
        reasoning: "The query resembles a card title.",
        reasoning_details: [
          {
            type: "reasoning.summary",
            summary: "Use local title search.",
          },
        ],
      },
    },
    {
      name: "tool_call",
      status: "ok",
      duration_ms: 0,
      details: {
        tool_call_id: "call-1",
        name: "search_local_cards",
        arguments: { name: { query: "Ghalta" } },
      },
    },
    {
      name: "tool_response",
      status: "ok",
      duration_ms: 25,
      details: {
        tool: "search_local_cards",
        message_to_agent:
          "The search tool has finished.\nID 1 [ALREADY SHOWN]\nName: Ghalta, Primal Hunger",
        numbered_candidates: [
          { id: 1, already_shown: true, card: ghalta },
        ],
        raw_tool_result: {
          total_candidates: 33253,
          request: { name: { query: "Ghalta" } },
          compiled_query: {
            engine: "local_sqlite_catalog",
            semantic_sort: {
              mode: "cosine",
              model: "BAAI/bge-small-en-v1.5",
              dimensions: 384,
              query: "Ghalta cards",
              score_scale: "normalized_cosine_0_to_1",
              minimum_score: null,
              scored_candidates: 24,
            },
            result_limit: 24,
          },
          candidates: [{ card: ghalta }],
        },
      },
    },
    {
      name: "thinking",
      status: "ok",
      duration_ms: 120,
      details: {
        phase: "final_ranking",
        reasoning: "Ghalta is the strongest title match.",
        reasoning_details: [
          {
            type: "reasoning.summary",
            summary: "Rank Ghalta first.",
          },
        ],
      },
    },
    {
      name: "output_response",
      status: "ok",
      duration_ms: 0,
      details: {
        content: JSON.stringify({
          interpretation: "Ghalta title matches.",
          ranked_ids: [1],
        }),
        interpretation: "Ghalta title matches.",
        ranked_ids: [1],
        ranked_cards: [{ rank: 1, name: "Ghalta, Primal Hunger" }],
      },
    },
  ];

  const { container } = render(<SearchTracePanel debug={debug} />);
  await userEvent.click(screen.getByText("Search trace"));

  expect(screen.getByText("System prompt")).toBeInTheDocument();
  expect(screen.getByText("User input prompt")).toBeInTheDocument();
  expect(screen.getAllByText("Thinking")).toHaveLength(2);
  expect(screen.getByText("Tool call")).toBeInTheDocument();
  expect(screen.getByText("Tool response")).toBeInTheDocument();
  expect(screen.getByText("Output response")).toBeInTheDocument();
  expect(screen.getByText("Exact message returned to agent")).toBeInTheDocument();
  expect(screen.getByText("Raw tool response")).toBeInTheDocument();
  expect(screen.getByText("Ghalta title matches.")).toBeInTheDocument();
  expect(screen.queryByText("Request context")).not.toBeInTheDocument();
  expect(screen.queryByText("Validation")).not.toBeInTheDocument();
  expect(screen.queryByText("Full raw trace JSON")).not.toBeInTheDocument();
  expect(container.querySelectorAll(".search-debug-layer__body")).toHaveLength(7);
  expect(
    [...container.querySelectorAll(".search-debug-layer__body")].every(
      (body) => (body.textContent ?? "").trim().length > 0,
    ),
  ).toBe(true);
});

it("shows what an agent search cost, and nothing for a local one", () => {
  const { rerender } = render(
    <SearchTracePanel debug={failedAgentSearchDebugSummary()} />,
  );

  expect(screen.getByTitle("What this search cost")).toHaveTextContent(
    "$0.0031",
  );

  // A local fuzzy search makes no model call, so there is no price to claim.
  rerender(<SearchTracePanel debug={searchDebugSummary()} />);
  expect(screen.queryByTitle("What this search cost")).not.toBeInTheDocument();

  // A payload that omits the field entirely is a real case: the runtime validator
  // accepts it so an older response still loads. Treating only an explicit null as
  // absent crashed the whole page on `undefined.toFixed`, which every fixture that
  // sets the field explicitly is blind to.
  const withoutCost = searchDebugSummary() as Partial<SearchDebugSummary>;
  delete withoutCost.total_cost_usd;
  rerender(<SearchTracePanel debug={withoutCost as SearchDebugSummary} />);
  expect(screen.getByText("Search trace")).toBeInTheDocument();
  expect(screen.queryByTitle("What this search cost")).not.toBeInTheDocument();
});
