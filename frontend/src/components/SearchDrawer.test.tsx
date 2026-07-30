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

  it("defaults EDHREC enhancement on for one commander and shows fetch failure", async () => {
    const page = cardSearchPage([], "");
    page.edhrec = {
      status: "unavailable",
      source: null,
      message:
        "EDHREC data could not be fetched. Results use normal local sorting.",
    };
    const searchCards = vi.fn<ApiClient["searchCards"]>().mockResolvedValue(page);

    render(
      <SearchDrawer
        entries={[
          {
            card: {
              oracle_id: ghalta.oracle_id,
              scryfall_id: ghalta.scryfall_id,
              name: ghalta.name,
              details: ghalta,
            },
            quantity: 1,
            section: "command_zone",
            categories: ["command_zone"],
          },
        ]}
        client={{ getHealth: vi.fn(), searchCards }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("checkbox", { name: "Enhance with EDHREC" }),
    ).toBeChecked();
    await waitFor(() =>
      expect(searchCards).toHaveBeenCalledWith(
        "",
        1,
        expect.any(AbortSignal),
        expect.any(Object),
        false,
        {
          enhanceWithEdhrec: true,
          commanderOracleId: ghalta.oracle_id,
        },
      ),
    );
    expect(
      await screen.findByText("EDHREC enhancement failed"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "EDHREC data could not be fetched. Results use normal local sorting.",
      ),
    ).toBeInTheDocument();
  });

  it("offers commander themes and applies the selected theme to EDHREC search", async () => {
    const page = cardSearchPage([], "");
    const searchCards = vi.fn<ApiClient["searchCards"]>().mockResolvedValue(page);
    const user = userEvent.setup();

    render(
      <SearchDrawer
        entries={[
          {
            card: {
              oracle_id: ghalta.oracle_id,
              scryfall_id: ghalta.scryfall_id,
              name: ghalta.name,
              details: ghalta,
            },
            quantity: 1,
            section: "command_zone",
            categories: ["command_zone"],
          },
        ]}
        client={{
          getHealth: vi.fn(),
          searchCards,
          getCommanderEdhrecContext: vi.fn().mockResolvedValue({
            status: "applied",
            source: "cache",
            commander_oracle_id: ghalta.oracle_id,
            commander_name: ghalta.name,
            themes: [
              { slug: "stompy", name: "Stompy", deck_count: 239 },
              { slug: "tokens", name: "Tokens", deck_count: 12 },
            ],
            message: null,
          }),
        }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const themePicker = await screen.findByRole("combobox", {
      name: "EDHREC deck theme",
    });
    expect(
      screen.getByRole("option", { name: "Tokens (12 decks)" }),
    ).toBeInTheDocument();
    await user.selectOptions(themePicker, "tokens");

    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(
        "",
        1,
        expect.any(AbortSignal),
        expect.any(Object),
        false,
        {
          enhanceWithEdhrec: true,
          commanderOracleId: ghalta.oracle_id,
          edhrecTheme: "tokens",
        },
      ),
    );
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
    expect(
      screen.getByRole("checkbox", {
        name: "Show non-Commander-legal cards",
      }),
    ).toHaveFocus();

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
          includeNonCommanderLegal: false,
          includeOutsideCommanderColorIdentity: false,
          commanderColorIdentity: null,
          tags: [],
          cardTypes: [],
          subtypes: [],
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
    window.localStorage.setItem("manabase.search-debug", "true");
    const preview = cardSearchPage([solRing], "green big creature");
    preview.agentic_required = true;
    preview.title_confidence_scores = { [solRing.scryfall_id]: 0.72 };
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
    expect(screen.queryByText("Title confidence 72%")).not.toBeInTheDocument();
    expect(searchCardsAgentic).toHaveBeenCalledTimes(1);

    const final = cardSearchPage([ghalta], "green big creature");
    final.strategy = "agentic";
    final.reranked = true;
    final.agentic_required = false;
    final.search_session_id = "search-session-1";
    final.interpretation = "Large green creatures, strongest matches first.";
    final.title_confidence_scores = { [ghalta.scryfall_id]: 0.83 };
    resolveAgentic(final);

    expect(
      await screen.findAllByText("Ghalta, Primal Hunger"),
    ).not.toHaveLength(0);
    expect(
      screen.getByText("Large green creatures, strongest matches first."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Title confidence 83%")).not.toBeInTheDocument();
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

  it("shows local tags and related-card links for the highlighted card", async () => {
    const getCardEnrichment = vi
      .fn<NonNullable<ApiClient["getCardEnrichment"]>>()
      .mockResolvedValue({
        oracle_id: solRing.oracle_id,
        tags: [
          {
            id: "tag-mana-rock",
            name: "mana rock",
            slug: "mana-rock",
            description: "Artifacts that produce mana.",
          },
        ],
        similar_cards: [
          { oracle_id: "oracle-mana-vault", name: "Mana Vault" },
        ],
        references: [],
        referenced_by: [
          { oracle_id: "oracle-reference", name: "Sol Ring Replica" },
        ],
      });
    const getCard = vi
      .fn<NonNullable<ApiClient["getCard"]>>()
      .mockResolvedValue({ ...solRing, name: "Mana Vault" });
    const onOpenCard = vi.fn();

    render(
      <SearchDrawer
        initialQuery="sol ring"
        entries={[]}
        client={{
          getHealth: vi.fn(),
          getCardEnrichment,
          getCard,
          searchCards: vi.fn().mockResolvedValue(cardSearchPage()),
        }}
        onOpenCard={onOpenCard}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText("mana rock")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Similar cards" }))
      .toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Referenced by" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Sol Ring Replica")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mana Vault" }));
    expect(getCard).toHaveBeenCalledWith("oracle-mana-vault");
    expect(onOpenCard).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Mana Vault" }),
    );
    expect(getCardEnrichment).toHaveBeenCalledWith(
      solRing.oracle_id,
      expect.any(AbortSignal),
    );
  });

  it("passes default safety filters and current commander identity to search", async () => {
    const searchCards = vi.fn<ApiClient["searchCards"]>().mockResolvedValue(
      cardSearchPage(),
    );
    const user = userEvent.setup();
    render(
      <SearchDrawer
        initialQuery="creature"
        entries={[
          {
            card: {
              oracle_id: ghalta.oracle_id,
              scryfall_id: ghalta.scryfall_id,
              name: ghalta.name,
              details: ghalta,
            },
            quantity: 1,
            section: "command_zone",
            categories: ["command_zone"],
          },
        ]}
        client={{ getHealth: vi.fn(), searchCards }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(
        "creature",
        1,
        expect.any(AbortSignal),
        expect.objectContaining({
          includeNonCommanderLegal: false,
          includeOutsideCommanderColorIdentity: false,
          commanderColorIdentity: ["G"],
        }),
        false,
      ),
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: "Show non-Commander-legal cards",
      }),
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: "Show cards outside commander color identity",
      }),
    );
    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(
        "creature",
        1,
        expect.any(AbortSignal),
        expect.objectContaining({
          includeNonCommanderLegal: true,
          includeOutsideCommanderColorIdentity: true,
          commanderColorIdentity: ["G"],
        }),
        false,
      ),
    );
  });

  it("fuzzy-finds, applies, and removes immutable tag filters", async () => {
    const searchCards = vi.fn<ApiClient["searchCards"]>().mockResolvedValue(
      cardSearchPage(),
    );
    const searchCardTags = vi
      .fn<NonNullable<ApiClient["searchCardTags"]>>()
      .mockResolvedValue([
        {
          id: "tag-elf",
          name: "elf typal",
          slug: "elf-typal",
          description: "Cards that reward Elf decks.",
          match_score: 0.94,
        },
      ]);
    const user = userEvent.setup();
    render(
      <SearchDrawer
        initialQuery="untapping creatures"
        entries={[]}
        client={{ getHealth: vi.fn(), searchCards, searchCardTags }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.type(
      screen.getByRole("searchbox", { name: "Search card tags" }),
      "elfs",
    );
    await user.click(
      await screen.findByRole("button", { name: "Add elf typal tag" }),
    );
    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(
        "untapping creatures",
        1,
        expect.any(AbortSignal),
        expect.objectContaining({
          tags: [{ id: "tag-elf", name: "elf typal" }],
        }),
        false,
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "Remove elf typal tag" }),
    );
    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(
        "untapping creatures",
        1,
        expect.any(AbortSignal),
        expect.objectContaining({ tags: [] }),
        false,
      ),
    );
  });

  it("applies required card types and fuzzy-selected subtypes", async () => {
    const searchCards = vi.fn<ApiClient["searchCards"]>().mockResolvedValue(
      cardSearchPage(),
    );
    const searchCardSubtypes = vi
      .fn<NonNullable<ApiClient["searchCardSubtypes"]>>()
      .mockResolvedValue([
        {
          name: "Dinosaur",
          match_score: 0.92,
        },
      ]);
    const user = userEvent.setup();
    render(
      <SearchDrawer
        entries={[]}
        client={{
          getHealth: vi.fn(),
          searchCards,
          searchCardSubtypes,
        }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Creature" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search card subtypes" }),
      "dino",
    );
    await user.click(
      await screen.findByRole("button", { name: "Add Dinosaur subtype" }),
    );

    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(
        "",
        1,
        expect.any(AbortSignal),
        expect.objectContaining({
          cardTypes: ["Creature"],
          subtypes: ["Dinosaur"],
        }),
        false,
      ),
    );
    expect(
      screen.getByRole("button", { name: "Remove Dinosaur subtype" }),
    ).toBeInTheDocument();
  });

  it("uses selected tag names as the intent when tag-only results are exhausted", async () => {
    const first = cardSearchPage([solRing], "");
    first.has_more = false;
    const continuation = cardSearchPage([ghalta], 'cards tagged "mana rock"');
    continuation.strategy = "agentic";
    continuation.search_session_id = "tag-search-session";
    const searchCardsAgentic = vi
      .fn<NonNullable<ApiClient["searchCardsAgentic"]>>()
      .mockResolvedValue(continuation);
    const user = userEvent.setup();

    render(
      <SearchDrawer
        initialTags={[{ id: "tag-mana-rock", name: "mana rock" }]}
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

    await user.click(
      await screen.findByRole("button", { name: "Load more" }),
    );
    await waitFor(() =>
      expect(searchCardsAgentic).toHaveBeenCalledWith(
        'cards tagged "mana rock"',
        2,
        expect.any(AbortSignal),
        expect.objectContaining({
          tags: [{ id: "tag-mana-rock", name: "mana rock" }],
        }),
        false,
        null,
        [solRing.oracle_id],
      ),
    );
    expect(
      await screen.findAllByText("Ghalta, Primal Hunger"),
    ).not.toHaveLength(0);
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
