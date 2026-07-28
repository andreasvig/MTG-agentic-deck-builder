import type {
  CardImageUris,
  CardSearchPage,
  CardSearchResult,
  SearchDebugSummary,
} from "../../frontend/src/domain/card";

const solRingImages: CardImageUris = {
  small:
    "https://cards.scryfall.io/small/front/9/1/91fdb56b-54d5-4272-8319-505ff987fe9b.jpg",
  normal:
    "https://cards.scryfall.io/normal/front/9/1/91fdb56b-54d5-4272-8319-505ff987fe9b.jpg",
  large: null,
  png: null,
  art_crop: null,
  border_crop: null,
};

const baseCard: CardSearchResult = {
  oracle_id: "6ad8011d-3471-4369-9d68-b264cc027487",
  scryfall_id: "91fdb56b-54d5-4272-8319-505ff987fe9b",
  name: "Sol Ring",
  layout: "normal",
  mana_cost: "{1}",
  mana_value: 1,
  type_line: "Artifact",
  oracle_text: "{T}: Add {C}{C}.",
  power: null,
  toughness: null,
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
  legalities: { commander: "legal" },
  finishes: ["nonfoil", "foil"],
  scryfall_url: "https://scryfall.com/card/msc/211/sol-ring",
  cardmarket_url: "https://www.cardmarket.com/sol-ring",
};

export const solRing = baseCard;

export const llanowarElves: CardSearchResult = {
  ...baseCard,
  oracle_id: "68954295-54e3-4303-a6bc-fc4547a4e3a3",
  scryfall_id: "6a0b230b-d391-4998-a3f7-7b158a0ec2cd",
  name: "Llanowar Elves",
  mana_cost: "{G}",
  type_line: "Creature — Elf Druid",
  oracle_text: "{T}: Add {G}.",
  power: "1",
  toughness: "1",
  colors: ["G"],
  color_identity: ["G"],
  set_code: "fdn",
  set_name: "Foundations",
  collector_number: "227",
  rarity: "common",
  prices: { ...baseCard.prices, eur: "0.23" },
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
  power: "12",
  toughness: "12",
  set_code: "rix",
  set_name: "Rivals of Ixalan",
  collector_number: "130",
  rarity: "rare",
};

export const counterspell: CardSearchResult = {
  ...baseCard,
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
  ...baseCard,
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
    name_match_scores: {},
    title_confidence_scores: {},
    warnings: [],
    strategy: "fuzzy",
    interpretation: "Titles ranked locally by fuzzy similarity",
    reranked: false,
    agentic_required: false,
    search_session_id: null,
    debug: null,
  };
}

export function searchDebugSummary(): SearchDebugSummary {
  return {
    trace_id: "f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f",
    log_path: "local-data/search-debug.jsonl",
    log_written: true,
    total_duration_ms: 83.2,
    stages: [
      {
        name: "Local fuzzy title ranking",
        status: "ok",
        duration_ms: 83.2,
        input_count: null,
        output_count: 1,
      },
    ],
    trace: {
      schema_version: 1,
      trace_id: "f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f",
      started_at: "2026-07-27T12:00:00Z",
      completed_at: "2026-07-27T12:00:00.083Z",
      total_duration_ms: 83.2,
      request: {
        query: "sol rng",
        page: 1,
        debug: true,
        filters: {},
      },
      configuration: {
        algorithm: "rapidfuzz.WRatio",
        catalog: "local-data/cards.sqlite3",
        minimum_score: null,
        page_size: 6,
      },
      decision: {
        input_kind: "card_title",
        strategy: "fuzzy",
        source: "local_sqlite_catalog",
        top_score: 0.933333,
        page_start: 0,
        page_end: 1,
      },
      stages: [
        {
          name: "Local fuzzy title ranking",
          status: "ok",
          duration_ms: 83.2,
          output: {
            count: 1,
            top: [
              {
                rank: 1,
                scryfall_id: solRing.scryfall_id,
                name: solRing.name,
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
      ],
      result: { status: "ok", strategy: "fuzzy" },
    },
  };
}
