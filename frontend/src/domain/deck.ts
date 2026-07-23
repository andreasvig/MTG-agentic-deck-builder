export interface CardReference {
  oracle_id: string;
  scryfall_id: string;
  name: string;
}

export type DeckSection = "command_zone" | "mainboard" | "maybeboard";

export interface DeckCardEntry {
  card: CardReference;
  quantity: number;
  section: DeckSection;
  categories: string[];
}

export interface Deck {
  id: string;
  name: string;
  format: "commander";
  cards: DeckCardEntry[];
  created_at: string;
  updated_at: string;
}
