import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiClient } from "../lib/api";
import {
  cardSearchPage,
  failedAgentSearchDebugSummary,
  ghalta,
  searchDebugSummary,
  solRing,
} from "../test/fixtures";
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
    expect(screen.getAllByText("83.2ms")).toHaveLength(2);
    await userEvent.click(screen.getByText("Search trace"));
    expect(screen.getByText("Local fuzzy title ranking")).toBeInTheDocument();
    expect(screen.getAllByText("rapidfuzz.WRatio")).toHaveLength(1);
    expect(screen.getByText("Title candidates")).toBeInTheDocument();
    expect(screen.getByText("Full raw trace JSON")).toBeInTheDocument();
    expect(screen.getByText(/"schema_version": 1/)).toBeInTheDocument();
    expect(
      screen.getByText("local-data/search-debug.jsonl"),
    ).toBeInTheDocument();
  });

  it("shows per-card fuzzy scores and loaded-page candidate evidence", async () => {
    window.localStorage.setItem("manabase.search-debug", "true");
    const page = cardSearchPage(undefined, "sol rng");
    page.strategy = "fuzzy";
    page.interpretation = "Titles ranked locally by fuzzy similarity";
    page.name_match_scores = { "printing-sol-ring": 0.933333 };
    page.title_confidence_scores = { "printing-sol-ring": 0.72 };
    const debug = searchDebugSummary();
    debug.stages = [
      {
        name: "Local fuzzy title ranking",
        status: "ok",
        duration_ms: 83.2,
        input_count: null,
        output_count: 1,
      },
    ];
    debug.trace.decision = {
      input_kind: "card_title",
      strategy: "fuzzy",
      source: "local_sqlite_catalog",
      top_score: 0.933333,
      page_start: 0,
      page_end: 1,
    };
    debug.trace.stages = [
      {
        name: "Local fuzzy title ranking",
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
          algorithm: "rapidfuzz.WRatio",
          minimum_score: null,
          catalog_card_count: 1,
          filtered_card_count: 1,
          removed_by_filters: 0,
          page: 1,
          page_size: 6,
          page_start: 0,
          page_end: 1,
          top_score: 0.933333,
          fuzzy_candidates: [
            {
              rank: 1,
              name: "Sol Ring",
              matched_alias: "sol ring",
              score: 0.933333,
              original_rank: 1,
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

    expect(
      await screen.findByText("Title confidence 72%"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByText("Search trace"));
    expect(screen.getByText("Title candidates")).toBeInTheDocument();
    expect(screen.getAllByText("93%")).not.toHaveLength(0);
  });

  it("shows confident previews while agentic search ranks the final results", async () => {
    const preview = cardSearchPage([solRing], "green big creature");
    preview.agentic_required = true;
    preview.interpretation =
      "Confident title matches shown while agentic search continues";
    let resolveAgentic: (page: ReturnType<typeof cardSearchPage>) => void =
      () => undefined;
    const agenticResult = new Promise<ReturnType<typeof cardSearchPage>>(
      (resolve) => {
        resolveAgentic = resolve;
      },
    );
    const searchCards = vi.fn<ApiClient["searchCards"]>().mockResolvedValue(
      preview,
    );
    const searchCardsAgentic = vi
      .fn<NonNullable<ApiClient["searchCardsAgentic"]>>()
      .mockReturnValue(agenticResult);

    render(
      <SearchDrawer
        initialQuery="green big creature"
        entries={[]}
        client={{
          getHealth: vi.fn(),
          searchCards,
          searchCardsAgentic,
        }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("Agentic search loading"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Understanding the request and ranking cards"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Sol Ring")).not.toHaveLength(0);
    expect(searchCardsAgentic).toHaveBeenCalledTimes(1);

    const final = cardSearchPage([ghalta], "green big creature");
    final.strategy = "agentic";
    final.reranked = true;
    final.agentic_required = false;
    final.search_session_id = "search-session-1";
    final.interpretation = "Large green creatures, strongest matches first.";
    resolveAgentic(final);

    expect(
      await screen.findAllByText("Ghalta, Primal Hunger"),
    ).not.toHaveLength(0);
    expect(
      screen.getByText("Large green creatures, strongest matches first."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Agentic search loading")).not.toBeInTheDocument(),
    );
  });

  it("keeps and opens the failed agent trace beside the error", async () => {
    window.localStorage.setItem("manabase.search-debug", "true");
    const preview = cardSearchPage([], "green big creature");
    preview.agentic_required = true;
    const debug = failedAgentSearchDebugSummary();
    const searchCardsAgentic = vi
      .fn<NonNullable<ApiClient["searchCardsAgentic"]>>()
      .mockRejectedValue(
        new ApiError(
          "Agentic card search is temporarily unavailable.",
          503,
          debug,
        ),
      );

    render(
      <SearchDrawer
        initialQuery="green big creature"
        entries={[]}
        client={{
          getHealth: vi.fn(),
          searchCards: vi.fn().mockResolvedValue(preview),
          searchCardsAgentic,
        }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("Search could not finish"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Agentic card search is temporarily unavailable."),
    ).toBeInTheDocument();
    expect(screen.getByText("Search stopped here")).toBeVisible();
    expect(screen.getByText("OpenRouterError")).toBeVisible();
    expect(screen.getByText("The provider returned HTTP 429.")).toBeVisible();
    expect(screen.getAllByText("Not reached because an earlier agentic-search step failed."))
      .toHaveLength(4);
  });

  it("hides fuzzy percentages outside debug mode", async () => {
    const page = cardSearchPage(undefined, "sol rng");
    page.name_match_scores = { "printing-sol-ring": 0.933333 };
    page.title_confidence_scores = { "printing-sol-ring": 0.72 };

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

    expect(
      await screen.findByRole("button", { name: "Add Sol Ring to deck" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Title confidence 72%")).not.toBeInTheDocument();
  });

  it("shows 12 results first and appends the next page with Load more", async () => {
    const cards = Array.from({ length: 13 }, (_, index) => ({
      ...solRing,
      oracle_id: `oracle-${index + 1}`,
      scryfall_id: `printing-${index + 1}`,
      name: `Forest Match ${index + 1}`,
    }));
    const searchCards = vi.fn<ApiClient["searchCards"]>().mockImplementation(
      async (query, page = 1) => {
        const response = cardSearchPage(
          page === 1 ? cards.slice(0, 12) : cards.slice(12),
          query,
        );
        response.page = page;
        response.total_results = cards.length;
        response.has_more = page === 1;
        return response;
      },
    );
    const user = userEvent.setup();

    render(
      <SearchDrawer
        initialQuery="forest"
        entries={[]}
        client={{ getHealth: vi.fn(), searchCards }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findAllByRole("article")).toHaveLength(12);
    expect(screen.getByText("13 ranked cards")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() =>
      expect(screen.getAllByRole("article")).toHaveLength(13),
    );
    expect(searchCards).toHaveBeenLastCalledWith(
      "forest",
      2,
      expect.any(AbortSignal),
      expect.any(Object),
      false,
    );
    expect(
      screen.getByRole("button", { name: "Load more" }),
    ).toBeInTheDocument();
  });

  it("starts an agentic continuation after cached results are exhausted", async () => {
    const first = cardSearchPage([solRing], "mana rocks");
    first.has_more = false;
    let resolveContinuation: (page: ReturnType<typeof cardSearchPage>) => void =
      () => undefined;
    const continuation = new Promise<ReturnType<typeof cardSearchPage>>(
      (resolve) => {
        resolveContinuation = resolve;
      },
    );
    const searchCardsAgentic = vi
      .fn<NonNullable<ApiClient["searchCardsAgentic"]>>()
      .mockReturnValue(continuation);
    const user = userEvent.setup();

    render(
      <SearchDrawer
        initialQuery="mana rocks"
        entries={[]}
        client={{
          getHealth: vi.fn(),
          searchCards: vi.fn().mockResolvedValue(first),
          searchCardsAgentic,
        }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Load more" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(
      await screen.findByText("Agentic search loading"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Sol Ring")).not.toHaveLength(0);
    expect(searchCardsAgentic).toHaveBeenCalledWith(
      "mana rocks",
      2,
      expect.any(AbortSignal),
      expect.any(Object),
      false,
      null,
      ["oracle-sol-ring"],
    );

    const additional = cardSearchPage([ghalta], "mana rocks");
    additional.page = 2;
    additional.total_results = 2;
    additional.strategy = "agentic";
    additional.reranked = true;
    additional.search_session_id = "search-session-1";
    resolveContinuation(additional);

    await waitFor(() =>
      expect(screen.getAllByRole("article")).toHaveLength(2),
    );
    expect(
      screen.getByRole("button", { name: "Load more" }),
    ).toBeInTheDocument();
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
