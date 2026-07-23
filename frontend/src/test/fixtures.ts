import type {
  CardSearchPage,
  CardSearchResult,
  SearchDebugSummary,
} from "../domain/card";

export const solRing: CardSearchResult = {
  oracle_id: "oracle-sol-ring",
  scryfall_id: "printing-sol-ring",
  name: "Sol Ring",
  layout: "normal",
  mana_cost: "{1}",
  mana_value: 1,
  type_line: "Artifact",
  oracle_text: "{T}: Add {C}{C}.",
  colors: [],
  color_identity: [],
  image_uris: {
    small: "https://cards.example/sol-ring-small.jpg",
    normal: "https://cards.example/sol-ring.jpg",
    large: null,
    png: null,
    art_crop: null,
    border_crop: null,
  },
  card_faces: [],
  set_code: "cmm",
  set_name: "Commander Masters",
  collector_number: "396",
  rarity: "uncommon",
  prices: {
    usd: "1.50",
    usd_foil: null,
    usd_etched: null,
    eur: "1.10",
    eur_foil: null,
    tix: null,
  },
  legalities: { commander: "legal" },
  finishes: ["nonfoil"],
  scryfall_url: "https://scryfall.com/card/cmm/396/sol-ring",
  cardmarket_url: "https://www.cardmarket.com/sol-ring",
};

export const ghalta: CardSearchResult = {
  ...solRing,
  oracle_id: "oracle-ghalta",
  scryfall_id: "printing-ghalta",
  name: "Ghalta, Primal Hunger",
  mana_cost: "{10}{G}{G}",
  mana_value: 12,
  type_line: "Legendary Creature — Elder Dinosaur",
  oracle_text: "Trample",
  colors: ["G"],
  color_identity: ["G"],
  set_code: "rix",
  set_name: "Rivals of Ixalan",
  collector_number: "130",
  rarity: "rare",
};

export const counterspell: CardSearchResult = {
  ...solRing,
  oracle_id: "oracle-counterspell",
  scryfall_id: "printing-counterspell",
  name: "Counterspell",
  mana_cost: "{U}{U}",
  mana_value: 2,
  type_line: "Instant",
  oracle_text: "Counter target spell.",
  colors: ["U"],
  color_identity: ["U"],
  set_code: "mh2",
  set_name: "Modern Horizons 2",
  collector_number: "267",
  rarity: "uncommon",
};

export const gamble: CardSearchResult = {
  ...solRing,
  oracle_id: "oracle-gamble",
  scryfall_id: "printing-gamble",
  name: "Gamble",
  mana_cost: "{R}",
  mana_value: 1,
  type_line: "Sorcery",
  oracle_text:
    "Search your library for a card, put that card into your hand, discard a card at random, then shuffle.",
  colors: ["R"],
  color_identity: ["R"],
  set_code: "uma",
  set_name: "Ultimate Masters",
  collector_number: "128",
  rarity: "rare",
};

export function cardSearchPage(
  cards: CardSearchResult[] = [solRing],
  query = "Sol Ring",
): CardSearchPage {
  return {
    query,
    page: 1,
    total_results: cards.length,
    has_more: false,
    cards,
    name_match_scores: {},
    warnings: [],
    strategy: "exact",
    interpretation: "Exact card name",
    reranked: false,
    debug: null,
  };
}

export function searchDebugSummary(): SearchDebugSummary {
  const systemPrompt = "Rank Magic cards for the user's deck-building intent.";
  const userPrompt = JSON.stringify({
    intent: "green ramp",
    cards: [{ scryfall_id: "printing-sol-ring", name: "Sol Ring" }],
  });
  const assistantResponse = JSON.stringify({
    ordered_scryfall_ids: ["printing-sol-ring"],
  });
  const requestBody = {
    model: "google/gemini-3.5-flash-lite",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    reasoning: { effort: "minimal", exclude: true },
    max_tokens: 900,
  };
  const responseBody = {
    model: "google/gemini-3.5-flash-lite",
    provider: "Google AI Studio",
    choices: [
      {
        message: {
          role: "assistant",
          content: assistantResponse,
        },
      },
    ],
    usage: { total_tokens: 312, cost: 0.00042 },
  };

  return {
    trace_id: "f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f",
    log_path: "local-data/search-debug.jsonl",
    log_written: true,
    total_duration_ms: 742.3,
    stages: [
      {
        name: "Scryfall intent candidates",
        status: "ok",
        duration_ms: 110.2,
        input_count: null,
        output_count: 175,
      },
      {
        name: "Local semantic ranking",
        status: "ok",
        duration_ms: 310.1,
        input_count: 175,
        output_count: 175,
      },
      {
        name: "OpenRouter ranking",
        status: "ok",
        duration_ms: 322,
        input_count: 175,
        output_count: 175,
      },
    ],
    trace: {
      schema_version: 1,
      trace_id: "f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f",
      started_at: "2026-07-23T18:00:00Z",
      completed_at: "2026-07-23T18:00:00.742Z",
      total_duration_ms: 742.3,
      request: { query: "green ramp", page: 1, debug: true, filters: {} },
      configuration: {
        semantic_ranker: "BAAI/bge-small-en-v1.5",
        llm_ranker: "google/gemini-3.5-flash-lite",
      },
      decision: {
        input_kind: "natural_language_intent",
        strategy: "intent",
      },
      stages: [
        {
          name: "Scryfall intent candidates",
          status: "ok",
          duration_ms: 110.2,
          output: {
            count: 175,
            top: [
              {
                rank: 1,
                scryfall_id: "printing-sol-ring",
                name: "Sol Ring",
              },
            ],
          },
          details: {
            provider_query: 'o:"add" game:paper',
            provider_order: "edhrec",
            provider_total_results: 175,
          },
        },
        {
          name: "Local semantic ranking",
          status: "ok",
          duration_ms: 310.1,
          input: {
            count: 175,
            top: [
              {
                rank: 4,
                scryfall_id: "printing-sol-ring",
                name: "Sol Ring",
              },
            ],
          },
          output: {
            count: 175,
            top: [
              {
                rank: 1,
                scryfall_id: "printing-sol-ring",
                name: "Sol Ring",
              },
            ],
          },
          rank_changes: [
            {
              scryfall_id: "printing-sol-ring",
              name: "Sol Ring",
              before_rank: 4,
              after_rank: 1,
              delta: 3,
            },
          ],
          details: { model: "BAAI/bge-small-en-v1.5" },
        },
        {
          name: "OpenRouter ranking",
          status: "ok",
          duration_ms: 322,
          input: {
            count: 175,
            top: [
              {
                rank: 1,
                scryfall_id: "printing-sol-ring",
                name: "Sol Ring",
              },
            ],
          },
          output: {
            count: 175,
            top: [
              {
                rank: 1,
                scryfall_id: "printing-sol-ring",
                name: "Sol Ring",
              },
            ],
          },
          rank_changes: [
            {
              scryfall_id: "printing-sol-ring",
              name: "Sol Ring",
              before_rank: 1,
              after_rank: 1,
              delta: 0,
            },
          ],
          details: {
            model: "google/gemini-3.5-flash-lite",
            reasoning_effort: "minimal",
            max_tokens: 900,
            exchange: {
              request: {
                method: "POST",
                path: "/chat/completions",
                body: requestBody,
                raw_body: JSON.stringify(requestBody),
              },
              response: {
                status_code: 200,
                body: responseBody,
                raw_body: JSON.stringify(responseBody),
              },
            },
          },
        },
      ],
      result: { status: "ok", strategy: "intent" },
    },
  };
}
