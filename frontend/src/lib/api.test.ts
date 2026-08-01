import { describe, expect, it, vi } from "vitest";

import {
  cardSearchPage,
  failedAgentSearchDebugSummary,
  searchDebugSummary,
  solRing,
} from "../test/fixtures";
import { ApiError, createApiClient } from "./api";

/** A server-sent-event response body, delivered in the chunks given. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

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
        upgrades: [],
        downgrades: [],
        variants: [],
        creature_versions: [],
        spell_versions: [],
        related_cards: [],
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




  it("posts the open deck and reads back the tools the agent ran", async () => {
    const deck = {
      name: "Ghalta Stompy",
      cards: [
        {
          scryfall_id: "aaaaaaaa-2222-4222-8222-222222222222",
          quantity: 1,
          section: "mainboard" as const,
          group: "Ramp",
        },
      ],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        `data: ${JSON.stringify({
          type: "done",
          reply: {
            message: { role: "assistant", content: "You are light on ramp." },
            model: "openai/gpt-5.6-luna",
            replayed_message_count: 1,
            cost_usd: 0.0009,
            unpriced_call_count: 1,
            tool_calls: [
              { name: "read_deck", signature: "read_deck()", ok: true, detail: null },
              {
                name: "see_cards",
                signature: "see_cards(Sol Ring · rules)",
                ok: false,
                detail: "catalog unavailable",
              },
            ],
          },
        })}\n\n`,
      ]),
    );

    const reply = await createApiClient(
      "http://localhost/api/v1",
      fetcher,
    ).streamDeckAgentChat?.(
      [{ role: "user", content: "What am I missing?" }],
      deck,
      { onText: () => {}, onToolCall: () => {} },
    );

    // A turn taken with debug off reports no payloads, and absent is normalized to
    // null rather than to an empty call or an empty result.
    expect(reply?.tool_calls).toEqual([
      {
        name: "read_deck",
        signature: "read_deck()",
        ok: true,
        detail: null,
        arguments_json: null,
        result: null,
      },
      {
        name: "see_cards",
        signature: "see_cards(Sol Ring · rules)",
        ok: false,
        detail: "catalog unavailable",
        arguments_json: null,
        result: null,
      },
    ]);
    expect(reply?.unpriced_call_count).toBe(1);
    // The backend holds no deck, so the snapshot has to be in the request body.
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost/api/v1/agent/chat/stream",
      expect.objectContaining({
        body: JSON.stringify({
          messages: [{ role: "user", content: "What am I missing?" }],
          deck,
          debug: false,
        }),
      }),
    );
  });

  it("rejects a finished turn that is not usable", async () => {
    const unusable = [
      // A tool call missing its signature: the chat would have nothing to show.
      {
        message: { role: "assistant", content: "Play Sol Ring." },
        model: "openai/gpt-5.6-luna",
        replayed_message_count: 1,
        cost_usd: 0.000222,
        tool_calls: [{ name: "read_deck" }],
      },
      // An empty answer is a successful response with nothing in it.
      {
        message: { role: "assistant", content: "" },
        model: "openai/gpt-5.6-luna",
        replayed_message_count: 1,
        cost_usd: null,
      },
    ];

    for (const invalid of unusable) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          sseResponse([`data: ${JSON.stringify({ type: "done", reply: invalid })}\n\n`]),
        );

      await expect(
        createApiClient("http://localhost/api/v1", fetcher).streamDeckAgentChat?.(
          [{ role: "user", content: "Best ramp?" }],
          null,
          { onText: () => {}, onToolCall: () => {} },
        ),
      ).rejects.toEqual(new ApiError("The deck agent response was invalid.", 502));
    }
  });

  it("streams a turn's progress and returns the reply it finished with", async () => {
    const collected: string[] = [];
    const tools: string[] = [];
    // Deliberately split mid-frame: a chunk boundary is not an event boundary, and
    // a reader that assumed it was would drop half a turn.
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'data: {"type": "tool", "call": {"name": "read_deck", "signature": "read_deck()", "ok": true, "detail": null}}\n\n',
        'data: {"type": "text", "content": "Sol "}\n\ndata: {"type": "te',
        'xt", "content": "Ring."}\n\n',
        `data: ${JSON.stringify({
          type: "done",
          reply: {
            message: { role: "assistant", content: "Sol Ring." },
            model: "openai/gpt-5.6-luna",
            replayed_message_count: 1,
            cost_usd: 0.0009,
            unpriced_call_count: 0,
            tool_calls: [
              {
                name: "read_deck",
                signature: "read_deck()",
                ok: true,
                detail: null,
                arguments_json: "{}",
                result: "Deck listing",
              },
            ],
          },
        })}\n\n`,
      ]),
    );

    const reply = await createApiClient(
      "http://localhost/api/v1",
      fetcher,
    ).streamDeckAgentChat?.(
      [{ role: "user", content: "What am I missing?" }],
      null,
      {
        onText: (content) => collected.push(content),
        onToolCall: (call) => tools.push(call.signature),
      },
      undefined,
      true,
    );

    expect(collected).toEqual(["Sol ", "Ring."]);
    expect(tools).toEqual(["read_deck()"]);
    // The finished reply is the same shape the JSON route returns, payloads included.
    expect(reply?.cost_usd).toBe(0.0009);
    expect(reply?.tool_calls[0].result).toBe("Deck listing");
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost/api/v1/agent/chat/stream",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Accept: "text/event-stream" }),
        body: JSON.stringify({
          messages: [{ role: "user", content: "What am I missing?" }],
          debug: true,
        }),
      }),
    );
  });

  it("raises an error event as the failure it is", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'data: {"type": "text", "content": "Sol "}\n\n',
        'data: {"type": "error", "code": "deck_agent_contract_error", "message": "The deck agent did not answer. Please try again."}\n\n',
      ]),
    );

    // A 200 was already sent, so the failure arrives in-band — and must still reach
    // the caller as a failure rather than as a turn that quietly produced nothing.
    await expect(
      createApiClient("http://localhost/api/v1", fetcher).streamDeckAgentChat?.(
        [{ role: "user", content: "Best ramp?" }],
        null,
        { onText: () => {}, onToolCall: () => {} },
      ),
    ).rejects.toThrow("The deck agent did not answer. Please try again.");
  });

  it("rejects a stream that stopped before the turn was finished", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(sseResponse(['data: {"type": "text", "content": "Sol "}\n\n']));

    await expect(
      createApiClient("http://localhost/api/v1", fetcher).streamDeckAgentChat?.(
        [{ role: "user", content: "Best ramp?" }],
        null,
        { onText: () => {}, onToolCall: () => {} },
      ),
    ).rejects.toThrow("The deck agent did not finish answering.");
  });

  it("reports an unavailable streaming agent from its HTTP status", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        { detail: { code: "deck_agent_unavailable", message: "Agent switched off." } },
        { status: 503 },
      ),
    );

    await expect(
      createApiClient("http://localhost/api/v1", fetcher).streamDeckAgentChat?.(
        [{ role: "user", content: "Best ramp?" }],
        null,
        { onText: () => {}, onToolCall: () => {} },
      ),
    ).rejects.toThrow("Agent switched off.");
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
