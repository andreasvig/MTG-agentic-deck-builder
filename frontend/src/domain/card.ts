export type MagicColor = "W" | "U" | "B" | "R" | "G";
export type CardLegality = "legal" | "not_legal" | "restricted" | "banned";
export type CardFinish = "nonfoil" | "foil" | "etched";
export type ColorMatchMode = "subset" | "exact";
export type SearchStrategy = "fuzzy" | "agentic";
export type SearchDebugStageStatus = "ok" | "skipped" | "error";
export type EdhrecEnhancementStatus =
  | "not_requested"
  | "applied"
  | "unavailable";

export interface CardSearchFilters {
  colors: MagicColor[];
  includeColorless: boolean;
  colorMode: ColorMatchMode;
  includeNonCommanderLegal: boolean;
  includeOutsideCommanderColorIdentity: boolean;
  commanderColorIdentity: MagicColor[] | null;
  tags: CardTagFilter[];
  cardTypes: string[];
  subtypes: string[];
  manaValueMin: number | null;
  manaValueMax: number | null;
  priceEurMin: number | null;
  priceEurMax: number | null;
}

export const EMPTY_CARD_SEARCH_FILTERS: CardSearchFilters = {
  colors: [],
  includeColorless: false,
  colorMode: "subset",
  includeNonCommanderLegal: false,
  includeOutsideCommanderColorIdentity: false,
  commanderColorIdentity: null,
  tags: [],
  cardTypes: [],
  subtypes: [],
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
  power: string | null;
  toughness: string | null;
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
  power: string | null;
  toughness: string | null;
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

export interface CardTag {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

export interface CardTagMatch extends CardTag {
  match_score: number;
}

export interface CardTagFilter {
  id: string;
  name: string;
}

export interface CardSubtypeMatch {
  name: string;
  match_score: number;
}

export interface RelatedOracleCard {
  oracle_id: string;
  name: string;
}

/**
 * Every list describes the *other* card from the highlighted card's point of view,
 * so `upgrades` are the cards Tagger considers strictly better than this one.
 */
export interface CardEnrichment {
  oracle_id: string;
  tags: CardTag[];
  similar_cards: RelatedOracleCard[];
  references: RelatedOracleCard[];
  referenced_by: RelatedOracleCard[];
  upgrades: RelatedOracleCard[];
  downgrades: RelatedOracleCard[];
  variants: RelatedOracleCard[];
  creature_versions: RelatedOracleCard[];
  spell_versions: RelatedOracleCard[];
  related_cards: RelatedOracleCard[];
}

/** One EDHREC similar-card name; `oracle_id` is null when it matched no local card. */
export interface EdhrecSimilarCard {
  rank: number;
  name: string;
  oracle_id: string | null;
}

export interface EdhrecSimilarCards {
  status: "not_requested" | "applied" | "unavailable";
  source: "cache" | "network" | null;
  oracle_id: string;
  cards: EdhrecSimilarCard[];
  message: string | null;
}

export interface CardSearchPage {
  query: string;
  page: number;
  total_results: number;
  has_more: boolean;
  cards: CardSearchResult[];
  name_match_scores: Record<string, number>;
  title_confidence_scores: Record<string, number>;
  warnings: string[];
  strategy: SearchStrategy;
  interpretation: string | null;
  reranked: boolean;
  agentic_required: boolean;
  search_session_id: string | null;
  edhrec: EdhrecSearchEnhancement;
  debug: SearchDebugSummary | null;
  debug_runs: SearchDebugSummary[];
}

export interface EdhrecSearchEnhancement {
  status: EdhrecEnhancementStatus;
  source: "cache" | "network" | null;
  message: string | null;
}

export interface EdhrecDeckTheme {
  slug: string;
  name: string;
  deck_count: number;
}

export interface EdhrecCommanderContext {
  status: EdhrecEnhancementStatus;
  source: "cache" | "network" | null;
  commander_oracle_id: string;
  commander_name: string | null;
  themes: EdhrecDeckTheme[];
  message: string | null;
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
  /** USD the model calls in this run cost, or null when none was reported. */
  total_cost_usd: number | null;
  stages: SearchDebugStage[];
  trace: SearchDebugTrace;
}

export interface SearchDebugCardReference {
  rank: number;
  scryfall_id: string;
  name: string;
}

export interface SearchDebugCardSnapshot {
  count: number;
  top: SearchDebugCardReference[];
}

export interface SearchDebugRankChange {
  scryfall_id: string;
  name: string;
  before_rank: number | null;
  after_rank: number;
  delta: number | null;
}

export interface SearchDebugTraceStage {
  name: string;
  status: SearchDebugStageStatus;
  duration_ms: number;
  input?: SearchDebugCardSnapshot;
  output?: SearchDebugCardSnapshot;
  rank_changes?: SearchDebugRankChange[];
  details?: Record<string, unknown>;
}

export interface SearchDebugTrace {
  schema_version: number;
  trace_id: string;
  started_at: string;
  completed_at: string;
  total_duration_ms: number;
  request: Record<string, unknown>;
  configuration: Record<string, unknown>;
  decision: Record<string, unknown>;
  stages: SearchDebugTraceStage[];
  result: Record<string, unknown>;
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
