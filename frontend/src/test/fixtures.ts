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
