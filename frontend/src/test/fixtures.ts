import type { CardSearchPage, CardSearchResult } from "../domain/card";

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
  query = 'name:"Sol Ring"',
): CardSearchPage {
  return {
    query,
    page: 1,
    total_results: cards.length,
    has_more: false,
    cards,
    warnings: [],
  };
}
