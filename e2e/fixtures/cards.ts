import type {
  CardImageUris,
  CardSearchPage,
  CardSearchResult,
  SearchDebugSummary,
} from "../../frontend/src/domain/card";

const solRingImages: CardImageUris = {
  small:
    "https://cards.scryfall.io/small/front/9/1/91fdb56b-54d5-4272-8319-505ff987fe9b.jpg?1783903215",
  normal:
    "https://cards.scryfall.io/normal/front/9/1/91fdb56b-54d5-4272-8319-505ff987fe9b.jpg?1783903215",
  large:
    "https://cards.scryfall.io/large/front/9/1/91fdb56b-54d5-4272-8319-505ff987fe9b.jpg?1783903215",
  png: "https://cards.scryfall.io/png/front/9/1/91fdb56b-54d5-4272-8319-505ff987fe9b.png?1783903215",
  art_crop:
    "https://cards.scryfall.io/art_crop/front/9/1/91fdb56b-54d5-4272-8319-505ff987fe9b.jpg?1783903215",
  border_crop:
    "https://cards.scryfall.io/border_crop/front/9/1/91fdb56b-54d5-4272-8319-505ff987fe9b.jpg?1783903215",
};

const llanowarElvesImages: CardImageUris = {
  small:
    "https://cards.scryfall.io/small/front/6/a/6a0b230b-d391-4998-a3f7-7b158a0ec2cd.jpg?1783909057",
  normal:
    "https://cards.scryfall.io/normal/front/6/a/6a0b230b-d391-4998-a3f7-7b158a0ec2cd.jpg?1783909057",
  large:
    "https://cards.scryfall.io/large/front/6/a/6a0b230b-d391-4998-a3f7-7b158a0ec2cd.jpg?1783909057",
  png: "https://cards.scryfall.io/png/front/6/a/6a0b230b-d391-4998-a3f7-7b158a0ec2cd.png?1783909057",
  art_crop:
    "https://cards.scryfall.io/art_crop/front/6/a/6a0b230b-d391-4998-a3f7-7b158a0ec2cd.jpg?1783909057",
  border_crop:
    "https://cards.scryfall.io/border_crop/front/6/a/6a0b230b-d391-4998-a3f7-7b158a0ec2cd.jpg?1783909057",
};

export const solRing: CardSearchResult = {
  oracle_id: "6ad8011d-3471-4369-9d68-b264cc027487",
  scryfall_id: "91fdb56b-54d5-4272-8319-505ff987fe9b",
  name: "Sol Ring",
  layout: "normal",
  mana_cost: "{1}",
  mana_value: 1,
  type_line: "Artifact",
  oracle_text: "{T}: Add {C}{C}.",
  colors: [],
  color_identity: [],
  image_uris: solRingImages,
  card_faces: [],
  set_code: "msc",
  set_name: "Marvel Super Heroes Commander",
  collector_number: "211",
  rarity: "uncommon",
  prices: {
    usd: "1.51",
    usd_foil: null,
    usd_etched: null,
    eur: "0.95",
    eur_foil: null,
    tix: "0.04",
  },
  legalities: {
    standard: "not_legal",
    future: "not_legal",
    historic: "not_legal",
    timeless: "not_legal",
    gladiator: "not_legal",
    pioneer: "not_legal",
    modern: "not_legal",
    legacy: "banned",
    pauper: "not_legal",
    vintage: "restricted",
    penny: "not_legal",
    commander: "legal",
    oathbreaker: "banned",
    standardbrawl: "not_legal",
    brawl: "not_legal",
    competitivebrawl: "not_legal",
    alchemy: "not_legal",
    paupercommander: "not_legal",
    duel: "banned",
    oldschool: "not_legal",
    premodern: "not_legal",
    predh: "legal",
    tlr: "banned",
  },
  finishes: ["nonfoil", "foil"],
  scryfall_url:
    "https://scryfall.com/card/msc/211/sol-ring?utm_source=api",
  cardmarket_url:
    "https://www.cardmarket.com/en/Magic/Products?idProduct=891691",
};

export const llanowarElves: CardSearchResult = {
  oracle_id: "68954295-54e3-4303-a6bc-fc4547a4e3a3",
  scryfall_id: "6a0b230b-d391-4998-a3f7-7b158a0ec2cd",
  name: "Llanowar Elves",
  layout: "normal",
  mana_cost: "{G}",
  mana_value: 1,
  type_line: "Creature — Elf Druid",
  oracle_text: "{T}: Add {G}.",
  colors: ["G"],
  color_identity: ["G"],
  image_uris: llanowarElvesImages,
  card_faces: [],
  set_code: "fdn",
  set_name: "Foundations",
  collector_number: "227",
  rarity: "common",
  prices: {
    usd: "0.30",
    usd_foil: "2.33",
    usd_etched: null,
    eur: "0.23",
    eur_foil: "0.57",
    tix: "0.03",
  },
  legalities: {
    standard: "legal",
    future: "legal",
    historic: "legal",
    timeless: "legal",
    gladiator: "legal",
    pioneer: "legal",
    modern: "legal",
    legacy: "legal",
    pauper: "legal",
    vintage: "legal",
    penny: "not_legal",
    commander: "legal",
    oathbreaker: "legal",
    standardbrawl: "legal",
    brawl: "legal",
    competitivebrawl: "legal",
    alchemy: "legal",
    paupercommander: "legal",
    duel: "legal",
    oldschool: "not_legal",
    premodern: "legal",
    predh: "legal",
    tlr: "legal",
  },
  finishes: ["nonfoil", "foil"],
  scryfall_url:
    "https://scryfall.com/card/fdn/227/llanowar-elves?utm_source=api",
  cardmarket_url:
    "https://www.cardmarket.com/en/Magic/Products?idProduct=795132",
};

export const ghalta: CardSearchResult = {
  ...llanowarElves,
  oracle_id: "2a2cd8d6-06f3-4e95-a658-4bf4bc09211b",
  scryfall_id: "16ce06fb-1bb7-4c93-b7f2-59a86e4979f6",
  name: "Ghalta, Primal Hunger",
  mana_cost: "{10}{G}{G}",
  mana_value: 12,
  type_line: "Legendary Creature — Elder Dinosaur",
  oracle_text:
    "This spell costs {X} less to cast, where X is the total power of creatures you control.\nTrample",
  set_code: "rix",
  set_name: "Rivals of Ixalan",
  collector_number: "130",
  rarity: "rare",
};

export const counterspell: CardSearchResult = {
  ...solRing,
  oracle_id: "de65d6ad-0405-4f73-85bb-3f57d6f1c9c1",
  scryfall_id: "f3f7a6f9-bc72-4d14-969d-d89d0e702d24",
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
};

export const gamble: CardSearchResult = {
  ...solRing,
  oracle_id: "41f9f4a2-77ea-4fe9-aec3-8f3b00cc75f3",
  scryfall_id: "7e52bdca-31bb-4f72-bb11-8d98c6c0b756",
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

export function searchPage(
  query: string,
  cards: CardSearchResult[] = [solRing, llanowarElves],
): CardSearchPage {
  return {
    query,
    page: 1,
    total_results: cards.length,
    has_more: false,
    cards,
    warnings: [],
    strategy: "exact",
    interpretation: "Exact card name",
    reranked: false,
    debug: null,
  };
}

export function searchDebugSummary(): SearchDebugSummary {
  const requestBody = {
    model: "google/gemini-3.5-flash-lite",
    messages: [
      {
        role: "system",
        content: "Rank Magic cards for the user's deck-building intent.",
      },
      {
        role: "user",
        content: JSON.stringify({
          intent: "blue ramp",
          cards: [{ scryfall_id: solRing.scryfall_id, name: solRing.name }],
        }),
      },
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
          content: JSON.stringify({
            ordered_scryfall_ids: [solRing.scryfall_id],
          }),
        },
      },
    ],
    usage: { total_tokens: 312, cost: 0.00042 },
  };

  return {
    trace_id: "f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f",
    log_path: "local-data/search-debug.jsonl",
    log_written: true,
    total_duration_ms: 918.4,
    stages: [
      {
        name: "Scryfall intent candidates",
        status: "ok",
        duration_ms: 112.1,
        input_count: null,
        output_count: 16,
      },
      {
        name: "Local semantic ranking",
        status: "ok",
        duration_ms: 308.7,
        input_count: 16,
        output_count: 16,
      },
      {
        name: "OpenRouter ranking",
        status: "ok",
        duration_ms: 497.6,
        input_count: 16,
        output_count: 16,
      },
    ],
    trace: {
      schema_version: 1,
      trace_id: "f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f",
      started_at: "2026-07-23T18:00:00Z",
      completed_at: "2026-07-23T18:00:00.918Z",
      total_duration_ms: 918.4,
      request: {
        query: "blue ramp",
        page: 1,
        debug: true,
        filters: {},
      },
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
          duration_ms: 112.1,
          output: {
            count: 16,
            top: [
              {
                rank: 1,
                scryfall_id: solRing.scryfall_id,
                name: solRing.name,
              },
            ],
          },
          details: {
            provider_query: '(o:"add" OR o:"put a land card") id<=u game:paper',
            provider_order: "edhrec",
            provider_total_results: 86,
          },
        },
        {
          name: "Local semantic ranking",
          status: "ok",
          duration_ms: 308.7,
          input: { count: 16, top: [] },
          output: { count: 16, top: [] },
          rank_changes: [
            {
              scryfall_id: solRing.scryfall_id,
              name: solRing.name,
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
          duration_ms: 497.6,
          input: { count: 16, top: [] },
          output: { count: 16, top: [] },
          rank_changes: [
            {
              scryfall_id: solRing.scryfall_id,
              name: solRing.name,
              before_rank: 2,
              after_rank: 1,
              delta: 1,
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
