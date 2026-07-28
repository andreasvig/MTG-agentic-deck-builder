import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";

import { ghalta, searchDebugSummary } from "../test/fixtures";
import { SearchTracePanel } from "./SearchTracePanel";

it("renders readable content for every agentic trace stage", async () => {
  const debug = searchDebugSummary();
  debug.trace.decision = {
    strategy: "agentic",
    input_kind: "card_search_query",
  };
  debug.trace.stages = [
    {
      name: "request_context",
      status: "ok",
      duration_ms: 0,
      details: {
        query: "galtha",
        filters: {},
        preview_candidates: [ghalta],
      },
    },
    {
      name: "initial_model_request",
      status: "ok",
      duration_ms: 0,
      details: {
        model: "test/model",
        tool_choice: "required",
        messages: [
          { role: "system", content: "Choose one search tool." },
          { role: "user", content: "galtha" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "search_local_cards" },
          },
        ],
      },
    },
    {
      name: "initial_model_response",
      status: "ok",
      duration_ms: 100,
      details: {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              reasoning: "The query resembles a card title.",
              tool_calls: [
                {
                  id: "call-1",
                  function: {
                    name: "search_local_cards",
                    arguments: '{"name":{"query":"Ghalta"}}',
                  },
                },
              ],
            },
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
      name: "tool_result",
      status: "ok",
      duration_ms: 25,
      details: {
        total_candidates: 33253,
        request: { name: { query: "Ghalta" } },
        compiled_query: {
          engine: "local_sqlite_catalog",
          semantic_mode: "disabled",
          result_limit: 24,
        },
        candidates: [{ card: ghalta }],
      },
    },
    {
      name: "final_model_request",
      status: "ok",
      duration_ms: 0,
      details: {
        model: "test/model",
        tool_choice: "none",
        messages: [{ role: "tool", content: "one candidate" }],
        tools: [],
      },
    },
    {
      name: "final_model_response",
      status: "ok",
      duration_ms: 120,
      details: {
        model: "test/model",
        provider: "test-provider",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                interpretation: "Ghalta title matches.",
                ranked_ids: [ghalta.scryfall_id],
              }),
              reasoning_details: [{ type: "reasoning.summary" }],
            },
          },
        ],
        usage: { total_tokens: 100, cost: 0.001 },
      },
    },
    {
      name: "validation",
      status: "ok",
      duration_ms: 0,
      details: {
        status: "accepted",
        candidate_count: 1,
        all_candidates_ranked: true,
        invented_ids: [],
      },
    },
  ];

  const { container } = render(<SearchTracePanel debug={debug} />);
  await userEvent.click(screen.getByText("Search trace"));

  expect(screen.getByText("Planning request")).toBeInTheDocument();
  expect(screen.getByText("Requested tool call")).toBeInTheDocument();
  expect(screen.getByText("Returned candidates")).toBeInTheDocument();
  expect(screen.getByText("Ghalta title matches.")).toBeInTheDocument();
  expect(screen.getByText("Ranking accepted")).toBeInTheDocument();
  expect(container.querySelectorAll(".search-debug-layer__body")).toHaveLength(8);
  expect(
    [...container.querySelectorAll(".search-debug-layer__body")].every(
      (body) => (body.textContent ?? "").trim().length > 0,
    ),
  ).toBe(true);
});
