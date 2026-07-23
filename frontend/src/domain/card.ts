export type MagicColor = "W" | "U" | "B" | "R" | "G";
export type CardLegality = "legal" | "not_legal" | "restricted" | "banned";
export type CardFinish = "nonfoil" | "foil" | "etched";
export type ColorMatchMode = "subset" | "exact";
export type SearchStrategy = "exact" | "fuzzy" | "intent" | "syntax";
export type SearchDebugStageStatus = "ok" | "skipped" | "error";

export interface CardSearchFilters {
  colors: MagicColor[];
  includeColorless: boolean;
  colorMode: ColorMatchMode;
  manaValueMin: number | null;
  manaValueMax: number | null;
  priceEurMin: number | null;
  priceEurMax: number | null;
}

export const EMPTY_CARD_SEARCH_FILTERS: CardSearchFilters = {
  colors: [],
  includeColorless: false,
  colorMode: "subset",
  manaValueMin: null,
  manaValueMax: null,
  priceEurMin: null,
  priceEurMax: null,
};

export interface CardImageUris {
  small: string | null;
  normal: string | null;
  large: string | null;
  png: string | null;
  art_crop: string | null;
  border_crop: string | null;
}

export interface CardFace {
  name: string;
  mana_cost: string | null;
  type_line: string | null;
  oracle_text: string | null;
  colors: MagicColor[];
  image_uris: CardImageUris | null;
}

export interface CardPrices {
  usd: string | null;
  usd_foil: string | null;
  usd_etched: string | null;
  eur: string | null;
  eur_foil: string | null;
  tix: string | null;
}

export interface CardSearchResult {
  oracle_id: string;
  scryfall_id: string;
  name: string;
  layout: string;
  mana_cost: string | null;
  mana_value: number;
  type_line: string;
  oracle_text: string | null;
  colors: MagicColor[];
  color_identity: MagicColor[];
  image_uris: CardImageUris | null;
  card_faces: CardFace[];
  set_code: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  prices: CardPrices;
  legalities: Record<string, CardLegality>;
  finishes: CardFinish[];
  scryfall_url: string;
  cardmarket_url: string | null;
}

export interface CardSearchPage {
  query: string;
  page: number;
  total_results: number;
  has_more: boolean;
  cards: CardSearchResult[];
  warnings: string[];
  strategy: SearchStrategy;
  interpretation: string | null;
  reranked: boolean;
  debug: SearchDebugSummary | null;
}

export interface SearchDebugStage {
  name: string;
  status: SearchDebugStageStatus;
  duration_ms: number;
  input_count: number | null;
  output_count: number | null;
}

export interface SearchDebugSummary {
  trace_id: string;
  log_path: string;
  log_written: boolean;
  total_duration_ms: number;
  stages: SearchDebugStage[];
}

export function getCardImage(
  card: CardSearchResult,
  size: "small" | "normal" | "large" = "normal",
): string | null {
  return (
    card.image_uris?.[size] ??
    card.card_faces[0]?.image_uris?.[size] ??
    card.image_uris?.normal ??
    card.card_faces[0]?.image_uris?.normal ??
    null
  );
}

export function getCardPrice(card: CardSearchResult): number {
  const parsed = Number.parseFloat(card.prices.eur ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatEuro(value: number, empty = "No estimate"): string {
  if (value <= 0) {
    return empty;
  }
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(value);
}

export function isBasicLand(card: CardSearchResult | undefined): boolean {
  const supertypesAndTypes = card?.type_line.split("—", 1)[0] ?? "";
  return (
    /\bBasic\b/.test(supertypesAndTypes) &&
    /\bLand\b/.test(supertypesAndTypes)
  );
}

export function primaryCardType(card: CardSearchResult | undefined): string {
  const typeLine = card?.type_line ?? "";
  const types = [
    "Land",
    "Creature",
    "Instant",
    "Sorcery",
    "Artifact",
    "Enchantment",
    "Planeswalker",
    "Battle",
  ];
  return types.find((type) => typeLine.includes(type)) ?? "Other";
}
