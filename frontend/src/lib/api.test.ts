import { describe, expect, it, vi } from "vitest";

import {
  cardSearchPage,
  failedAgentSearchDebugSummary,
  searchDebugSummary,
  solRing,
} from "../test/fixtures";
import { ApiError, createApiClient } from "./api";

describe("API client", () => {
  it("requests and validates health from the configured API", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "ok",
        service: "mtg-agentic-deck-builder-api",
        version: "0.1.0",
      }),
    );
    const client = createApiClient("http://localhost:9999/api/v1/", fetcher);

    await expect(client.getHealth()).resolves.toMatchObject({
      status: "ok",
      service: "mtg-agentic-deck-builder-api",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:9999/api/v1/health",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("loads and validates lazy highlighted-card enrichment", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        oracle_id: "oracle-city",
        tags: [
          {
            id: "tag-rainbow",
            name: "rainbow land",
            slug: "rainbow-land",
            description: "Lands that make any color.",
          },
        ],
        similar_cards: [
          { oracle_id: "oracle-mana", name: "Mana Confluence" },
        ],
        references: [],
        referenced_by: [
          { oracle_id: "oracle-joke", name: "City of Ass" },
        ],
      }),
    );
    const client = createApiClient("http://localhost:9999/api/v1/", fetcher);

    await expect(
      client.getCardEnrichment?.("oracle-city"),
    ).resolves.toMatchObject({
      tags: [expect.objectContaining({ name: "rainbow land" })],
      similar_cards: [
        expect.objectContaining({ name: "Mana Confluence" }),
      ],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:9999/api/v1/cards/oracle-city/enrichment",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("loads canonical related cards and fuzzy tag matches", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(solRing))
      .mockResolvedValueOnce(
        Response.json([
          {
            id: "tag-mana-rock",
            name: "mana rock",
            slug: "mana-rock",
            description: "Artifacts that produce mana.",
            match_score: 0.93,
          },
        ]),
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            name: "Construct",
            match_score: 0.91,
          },
        ]),
      );
    const client = createApiClient("http://localhost:9999/api/v1/", fetcher);

    await expect(client.getCard?.(solRing.oracle_id)).resolves.toMatchObject({
      name: "Sol Ring",
    });
    await expect(client.searchCardTags?.(" mana rok ")).resolves.toEqual([
      expect.objectContaining({ id: "tag-mana-rock", match_score: 0.93 }),
    ]);
    await expect(client.searchCardSubtypes?.(" constrct ")).resolves.toEqual([
      expect.objectContaining({ name: "Construct", match_score: 0.91 }),
    ]);

    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `http://localhost:9999/api/v1/cards/${solRing.oracle_id}`,
    );
    const tagUrl = new URL(String(fetcher.mock.calls[1]?.[0]));
    expect(tagUrl.pathname).toBe("/api/v1/cards/tags/search");
    expect(tagUrl.searchParams.get("q")).toBe("mana rok");
    const subtypeUrl = new URL(String(fetcher.mock.calls[2]?.[0]));
    expect(subtypeUrl.pathname).toBe("/api/v1/cards/subtypes/search");
    expect(subtypeUrl.searchParams.get("q")).toBe("constrct");
  });

  it("sends raw queries and structured card filters", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(cardSearchPage()));
    const client = createApiClient("http://localhost:9999/api/v1", fetcher);

    await client.searchCards(
      " Sol Ring ",
      2,
      undefined,
      {
        colors: ["U", "R"],
        includeColorless: true,
        colorMode: "exact",
        includeNonCommanderLegal: true,
        includeOutsideCommanderColorIdentity: true,
        commanderColorIdentity: ["U", "R"],
        tags: [{ id: "tag-ramp", name: "ramp" }],
        cardTypes: ["Artifact", "Creature"],
        subtypes: ["Construct"],
        manaValueMin: 2,
        manaValueMax: 5,
        priceEurMin: 0.25,
        priceEurMax: 12,
      },
      true,
    );

    const requestedUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requestedUrl.pathname).toBe("/api/v1/cards/search");
    expect(requestedUrl.searchParams.get("q")).toBe("Sol Ring");
    expect(requestedUrl.searchParams.get("page")).toBe("2");
    expect(requestedUrl.searchParams.getAll("color")).toEqual(["U", "R"]);
    expect(requestedUrl.searchParams.get("include_colorless")).toBe("true");
    expect(requestedUrl.searchParams.get("color_mode")).toBe("exact");
    expect(requestedUrl.searchParams.get("include_non_commander_legal"))
      .toBe("true");
    expect(
      requestedUrl.searchParams.get("include_outside_commander_identity"),
    ).toBe("true");
    expect(requestedUrl.searchParams.getAll("commander_color")).toEqual([
      "U",
      "R",
    ]);
    expect(requestedUrl.searchParams.get("commander_identity_known")).toBe(
      "true",
    );
    expect(requestedUrl.searchParams.getAll("tag")).toEqual(["tag-ramp"]);
    expect(requestedUrl.searchParams.getAll("card_type")).toEqual([
      "Artifact",
      "Creature",
    ]);
    expect(requestedUrl.searchParams.getAll("subtype")).toEqual(["Construct"]);
    expect(requestedUrl.searchParams.get("mana_min")).toBe("2");
    expect(requestedUrl.searchParams.get("mana_max")).toBe("5");
    expect(requestedUrl.searchParams.get("price_min")).toBe("0.25");
    expect(requestedUrl.searchParams.get("price_max")).toBe("12");
    expect(requestedUrl.searchParams.get("debug")).toBe("true");
  });

  it("preserves an established colorless commander identity", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(cardSearchPage()));
    const client = createApiClient("http://localhost:9999/api/v1", fetcher);

    await client.searchCards("artifacts", 1, undefined, {
      colors: [],
      includeColorless: false,
      colorMode: "subset",
      includeNonCommanderLegal: false,
      includeOutsideCommanderColorIdentity: false,
      commanderColorIdentity: [],
      tags: [],
      cardTypes: [],
      subtypes: [],
      manaValueMin: null,
      manaValueMax: null,
      priceEurMin: null,
      priceEurMax: null,
    });

    const requestedUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requestedUrl.searchParams.getAll("commander_color")).toEqual([]);
    expect(requestedUrl.searchParams.get("commander_identity_known")).toBe(
      "true",
    );
  });

  it("requests optional EDHREC ranking with a single commander", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(cardSearchPage()));
    const client = createApiClient("http://localhost:9999/api/v1", fetcher);

    await client.searchCards("", 1, undefined, undefined, false, {
      enhanceWithEdhrec: true,
      commanderOracleId: "commander-oracle-id",
      edhrecTheme: "tokens",
    });

    const requestedUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requestedUrl.searchParams.get("enhance_with_edhrec")).toBe("true");
    expect(requestedUrl.searchParams.get("commander_oracle_id")).toBe(
      "commander-oracle-id",
    );
    expect(requestedUrl.searchParams.get("edhrec_theme")).toBe("tokens");
  });

  it("loads typed EDHREC theme choices for a selected commander", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "applied",
        source: "cache",
        commander_oracle_id: "commander-oracle-id",
        commander_name: "Ghalta, Primal Hunger",
        themes: [
          { slug: "stompy", name: "Stompy", deck_count: 239 },
          { slug: "tokens", name: "Tokens", deck_count: 12 },
        ],
        message: null,
      }),
    );
    const client = createApiClient("http://localhost:9999/api/v1", fetcher);

    const context = await client.getCommanderEdhrecContext?.(
      "commander-oracle-id",
    );

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:9999/api/v1/cards/commander-oracle-id/edhrec",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
    expect(context?.themes[1]).toEqual({
      slug: "tokens",
      name: "Tokens",
      deck_count: 12,
    });
  });

  it("posts agentic searches and continues the same ranked session", async () => {
    const page = cardSearchPage();
    page.strategy = "agentic";
    page.reranked = true;
    page.search_session_id = "search-session-1";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(page));
    const client = createApiClient("http://localhost:9999/api/v1", fetcher);

    await client.searchCardsAgentic?.(
      " green big creature ",
      2,
      undefined,
      {
        colors: ["G"],
        includeColorless: false,
        colorMode: "subset",
        includeNonCommanderLegal: false,
        includeOutsideCommanderColorIdentity: false,
        commanderColorIdentity: ["G"],
        tags: [{ id: "tag-stompy", name: "stompy" }],
        cardTypes: ["Creature"],
        subtypes: ["Dinosaur"],
        manaValueMin: 4,
        manaValueMax: null,
        priceEurMin: null,
        priceEurMax: 10,
      },
      true,
      "search-session-1",
      ["oracle-ghalta"],
      {
        enhanceWithEdhrec: true,
        commanderOracleId: "oracle-ghalta",
        edhrecTheme: "stompy",
      },
    );

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:9999/api/v1/cards/search/agentic",
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      }),
    );
    const request = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      q: "green big creature",
      page: 2,
      filters: {
        colors: ["G"],
        include_colorless: false,
        color_mode: "subset",
        include_non_commander_legal: false,
        include_outside_commander_color_identity: false,
        commander_color_identity: ["G"],
        tags: [{ id: "tag-stompy", name: "stompy" }],
        card_types: ["Creature"],
        subtypes: ["Dinosaur"],
        mana_value_min: 4,
        mana_value_max: null,
        price_eur_min: null,
        price_eur_max: 10,
      },
      debug: true,
      search_session_id: "search-session-1",
      already_shown_oracle_ids: ["oracle-ghalta"],
      commander_oracle_id: "oracle-ghalta",
      enhance_with_edhrec: true,
      edhrec_theme: "stompy",
    });
  });

  it("surfaces a safe provider message and rejects malformed payloads", async () => {
    const providerFailure = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { detail: { message: "Scryfall is temporarily unavailable." } },
          { status: 503 },
        ),
      );
    await expect(
      createApiClient("http://localhost/api/v1", providerFailure).searchCards(
        "Sol Ring",
      ),
    ).rejects.toEqual(
      new ApiError("Scryfall is temporarily unavailable.", 503),
    );

    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ cards: [{ name: "Sol Ring" }] }));
    await expect(
      createApiClient("http://localhost/api/v1", malformed).searchCards(
        "Sol Ring",
      ),
    ).rejects.toEqual(
      new ApiError("The card search response was invalid.", 502),
    );
  });

  it("retains a typed failed agent trace on API errors", async () => {
    const debug = failedAgentSearchDebugSummary();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          detail: {
            code: "agentic_search_unavailable",
            message: "Agentic card search is temporarily unavailable.",
            debug,
          },
        },
        { status: 503 },
      ),
    );

    await expect(
      createApiClient(
        "http://localhost/api/v1",
        fetcher,
      ).searchCardsAgentic?.("green big creature"),
    ).rejects.toEqual(
      new ApiError(
        "Agentic card search is temporarily unavailable.",
        503,
        debug,
      ),
    );
  });

  it("accepts typed search debug summaries", async () => {
    const page = cardSearchPage();
    page.debug = searchDebugSummary();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(page));

    await expect(
      createApiClient("http://localhost/api/v1", fetcher).searchCards("Forest"),
    ).resolves.toMatchObject({
      debug: {
        log_written: true,
        stages: expect.arrayContaining([
          expect.objectContaining({ name: "Local fuzzy title ranking" }),
        ]),
        trace: {
          decision: expect.objectContaining({ strategy: "fuzzy" }),
        },
      },
    });
  });

  it("rejects a healthy response from an unrelated service", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "ok",
        service: "unrelated-local-api",
        version: "1.0.0",
      }),
    );

    await expect(
      createApiClient("http://localhost/api/v1", fetcher).getHealth(),
    ).rejects.toEqual(
      new ApiError("The backend health response was invalid.", 502),
    );
  });
});
