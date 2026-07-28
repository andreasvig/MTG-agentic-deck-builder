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
  power: null,
  toughness: null,
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
  power: "12",
  toughness: "12",
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
