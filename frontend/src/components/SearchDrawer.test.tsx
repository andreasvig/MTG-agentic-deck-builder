import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../lib/api";
import { cardSearchPage, searchDebugSummary } from "../test/fixtures";
import { SearchDrawer } from "./SearchDrawer";

const idleClient: ApiClient = {
  getHealth: vi.fn(),
  searchCards: vi.fn(),
};

describe("card search dialog", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("contains keyboard focus, locks scrolling, and closes with Escape", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <SearchDrawer
        entries={[]}
        client={idleClient}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={onClose}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: "Search cards",
    });
    expect(input).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");

    screen.getByRole("button", { name: "Search settings" }).focus();
    await user.tab({ shift: true });
    expect(screen.getByRole("spinbutton", { name: "Maximum price in euros" }))
      .toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("sends color, mana value, and EUR price filters with the search", async () => {
    const searchCards = vi.fn<ApiClient["searchCards"]>().mockResolvedValue(
      cardSearchPage(),
    );
    const user = userEvent.setup();
    render(
      <SearchDrawer
        entries={[]}
        client={{ getHealth: vi.fn(), searchCards }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Search cards" }), "ramp");
    await user.click(screen.getByRole("radio", { name: "Exact" }));
    await user.click(screen.getByRole("checkbox", { name: "Blue" }));
    await user.click(screen.getByRole("checkbox", { name: "Colorless" }));
    await user.type(
      screen.getByRole("spinbutton", { name: "Minimum mana value" }),
      "2",
    );
    await user.type(
      screen.getByRole("spinbutton", { name: "Maximum mana value" }),
      "5",
    );
    await user.type(
      screen.getByRole("spinbutton", { name: "Minimum price in euros" }),
      "0.25",
    );
    await user.type(
      screen.getByRole("spinbutton", { name: "Maximum price in euros" }),
      "12",
    );
    await user.click(screen.getByRole("button", { name: /^Search$/ }));

    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(
        "ramp",
        1,
        expect.any(AbortSignal),
        {
          colors: ["U"],
          includeColorless: true,
          colorMode: "exact",
          manaValueMin: 2,
          manaValueMax: 5,
          priceEurMin: 0.25,
          priceEurMax: 12,
        },
        false,
      ),
    );
  });

  it("persists the search debug setting and requests a trace", async () => {
    const searchCards = vi.fn<ApiClient["searchCards"]>().mockResolvedValue(
      cardSearchPage(),
    );
    const user = userEvent.setup();
    render(
      <SearchDrawer
        entries={[]}
        client={{ getHealth: vi.fn(), searchCards }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Search settings" }));
    await user.click(screen.getByRole("switch", { name: "Search debug log" }));
    await user.type(
      screen.getByRole("textbox", { name: "Search cards" }),
      "red card draw",
    );
    await user.click(screen.getByRole("button", { name: /^Search$/ }));

    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(
        "red card draw",
        1,
        expect.any(AbortSignal),
        expect.any(Object),
        true,
      ),
    );
    expect(window.localStorage.getItem("manabase.search-debug")).toBe("true");
  });

  it("shows the persisted layer trace when backend debug mode is enabled", async () => {
    const page = cardSearchPage();
    page.debug = searchDebugSummary();
    const searchCards = vi.fn<ApiClient["searchCards"]>().mockResolvedValue(page);
    render(
      <SearchDrawer
        initialQuery="green ramp"
        entries={[]}
        client={{ getHealth: vi.fn(), searchCards }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText("Search trace")).toBeInTheDocument();
    expect(screen.getByText("742.3ms")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Search trace"));
    expect(screen.getByText("Local semantic ranking")).toBeInTheDocument();
    expect(screen.getAllByText("175 → 175")).toHaveLength(2);
    expect(screen.getByText('o:"add" game:paper')).toBeInTheDocument();
    expect(screen.getByText("LLM request")).toBeInTheDocument();
    expect(screen.getByText("LLM response")).toBeInTheDocument();
    expect(
      screen.getAllByText(
        /Rank Magic cards for the user's deck-building intent/,
      ),
    ).toHaveLength(2);
    expect(screen.getByText("Exact raw request JSON")).toBeInTheDocument();
    expect(screen.getByText("Google AI Studio")).toBeInTheDocument();
    expect(
      screen.getByText("local-data/search-debug.jsonl"),
    ).toBeInTheDocument();
  });

  it("shows per-card fuzzy scores and every cutoff candidate", async () => {
    const page = cardSearchPage(undefined, "sol rng");
    page.strategy = "fuzzy";
    page.interpretation = "Closest card names above 0.450";
    page.name_match_scores = { "printing-sol-ring": 0.933333 };
    const debug = searchDebugSummary();
    debug.stages = [
      {
        name: "Fuzzy name lookup",
        status: "ok",
        duration_ms: 83.2,
        input_count: null,
        output_count: 1,
      },
    ];
    debug.trace.decision = {
      input_kind: "card_name",
      strategy: "fuzzy",
      fuzzy_cutoff: 0.45,
      fuzzy_top_score: 0.933333,
      fuzzy_routing_signal: "accept_name_match",
    };
    debug.trace.stages = [
      {
        name: "Fuzzy name lookup",
        status: "ok",
        duration_ms: 83.2,
        output: {
          count: 1,
          top: [
            {
              rank: 1,
              scryfall_id: "printing-sol-ring",
              name: "Sol Ring",
            },
          ],
        },
        details: {
          fuzzy_cutoff: 0.45,
          top_score: 0.933333,
          routing_signal: "accept_name_match",
          fuzzy_candidates: [
            {
              name: "Sol Ring",
              matched_alias: "sol ring",
              score: 0.933333,
              accepted_by_score: true,
              returned_after_filters: true,
            },
            {
              name: "Soul Burn",
              matched_alias: "soul burn",
              score: 0.4,
              accepted_by_score: false,
              returned_after_filters: false,
            },
          ],
        },
      },
    ];
    page.debug = debug;

    render(
      <SearchDrawer
        initialQuery="sol rng"
        entries={[]}
        client={{
          getHealth: vi.fn(),
          searchCards: vi.fn().mockResolvedValue(page),
        }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText("Fuzzy 0.933")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Search trace"));
    await userEvent.click(screen.getByText("Fuzzy name lookup"));
    expect(screen.getByText("Fuzzy candidates")).toBeInTheDocument();
    expect(screen.getByText(/below cutoff/)).toBeInTheDocument();
    expect(screen.getByText("0.933")).toBeInTheDocument();
    expect(screen.getByText("0.400")).toBeInTheDocument();
  });

  it("keeps the trace available when a search returns no cards", async () => {
    const page = cardSearchPage([], "misspelled card");
    page.debug = searchDebugSummary();
    render(
      <SearchDrawer
        initialQuery="misspelled card"
        entries={[]}
        client={{
          getHealth: vi.fn(),
          searchCards: vi.fn().mockResolvedValue(page),
        }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "No cards found" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Search trace")).toBeInTheDocument();
  });
});
