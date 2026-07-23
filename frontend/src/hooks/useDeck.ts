import { useCallback, useEffect, useMemo, useReducer } from "react";

import type { CardSearchResult } from "../domain/card";
import { getCardPrice, isBasicLand } from "../domain/card";
import type { Deck, DeckCategory, DeckCardEntry } from "../domain/deck";
import {
  DECK_STORAGE_KEY,
  parseStoredDeck,
  placementForCategory,
} from "../domain/deck";

const MAX_UNDO_STEPS = 30;

interface DeckMutationResult {
  deck: Deck;
  announcement: string;
}

interface DeckState {
  deck: Deck;
  history: Deck[];
  announcement: string;
}

type DeckAction =
  | {
      type: "mutate";
      mutation: (current: Deck) => DeckMutationResult | null;
    }
  | { type: "undo" };

export function useDeck() {
  const [state, dispatch] = useReducer(deckReducer, undefined, createInitialState);
  const { deck, history, announcement } = state;

  useEffect(() => {
    try {
      const storage = getLocalStorage();
      storage?.setItem(DECK_STORAGE_KEY, JSON.stringify(deck));
    } catch {
      // The deck remains usable when storage is disabled or full.
    }
  }, [deck]);

  const mutate = useCallback(
    (mutation: (current: Deck) => DeckMutationResult | null) => {
      dispatch({ type: "mutate", mutation });
    },
    [],
  );

  const addCard = useCallback(
    (card: CardSearchResult, target?: DeckCategory, quantity = 1) => {
      const category = target ?? suggestedCategory(card);
      mutate((current) => {
        const existingIndex = current.cards.findIndex(
          (entry) => entry.card.scryfall_id === card.scryfall_id,
        );
        if (existingIndex >= 0) {
          const cards = current.cards.map((entry, index) =>
            index === existingIndex
              ? { ...entry, quantity: entry.quantity + quantity }
              : entry,
          );
          return {
            deck: { ...current, cards },
            announcement: `${card.name} quantity increased to ${
              cards[existingIndex]?.quantity ?? quantity
            }.`,
          };
        }

        const placement = placementForCategory(category);
        return {
          deck: {
            ...current,
            cards: [
              ...current.cards,
              {
                card: {
                  oracle_id: card.oracle_id,
                  scryfall_id: card.scryfall_id,
                  name: card.name,
                  details: card,
                },
                quantity,
                ...placement,
              },
            ],
          },
          announcement: `${card.name} added to ${category.replaceAll("_", " ")}.`,
        };
      });
    },
    [mutate],
  );

  const setQuantity = useCallback(
    (scryfallId: string, quantity: number) => {
      mutate((current) => {
        const entry = current.cards.find(
          (candidate) => candidate.card.scryfall_id === scryfallId,
        );
        if (!entry) {
          return null;
        }
        if (quantity <= 0) {
          return {
            deck: {
              ...current,
              cards: current.cards.filter(
                (candidate) => candidate.card.scryfall_id !== scryfallId,
              ),
            },
            announcement: `${entry.card.name} removed from the deck.`,
          };
        }
        if (entry.quantity === quantity) {
          return null;
        }
        return {
          deck: {
            ...current,
            cards: current.cards.map((candidate) =>
              candidate.card.scryfall_id === scryfallId
                ? { ...candidate, quantity }
                : candidate,
            ),
          },
          announcement: `${entry.card.name} quantity set to ${quantity}.`,
        };
      });
    },
    [mutate],
  );

  const removeCard = useCallback(
    (scryfallId: string) => setQuantity(scryfallId, 0),
    [setQuantity],
  );

  const moveCard = useCallback(
    (scryfallId: string, category: DeckCategory) => {
      mutate((current) => {
        const entry = current.cards.find(
          (candidate) => candidate.card.scryfall_id === scryfallId,
        );
        if (!entry) {
          return null;
        }
        const placement = placementForCategory(category);
        return {
          deck: {
            ...current,
            cards: current.cards.map((candidate) =>
              candidate.card.scryfall_id === scryfallId
                ? { ...candidate, ...placement }
                : candidate,
            ),
          },
          announcement: `${entry.card.name} moved to ${category.replaceAll("_", " ")}.`,
        };
      });
    },
    [mutate],
  );

  const undo = useCallback(() => {
    dispatch({ type: "undo" });
  }, []);

  const statistics = useMemo(() => {
    const activeEntries = deck.cards.filter(
      (entry) => entry.section !== "maybeboard",
    );
    const cardCount = activeEntries.reduce(
      (total, entry) => total + entry.quantity,
      0,
    );
    const price = activeEntries.reduce(
      (total, entry) =>
        total + getCardPrice(entry.card.details as CardSearchResult) * entry.quantity,
      0,
    );
    const manaCards = activeEntries.filter(
      (entry) =>
        entry.section !== "command_zone" &&
        entry.card.details &&
        !entry.card.details.type_line.includes("Land"),
    );
    const manaTotal = manaCards.reduce(
      (total, entry) =>
        total + (entry.card.details?.mana_value ?? 0) * entry.quantity,
      0,
    );
    const manaQuantity = manaCards.reduce(
      (total, entry) => total + entry.quantity,
      0,
    );
    const commanderCount = activeEntries
      .filter((entry) => entry.section === "command_zone")
      .reduce((total, entry) => total + entry.quantity, 0);
    const singletonWarnings = getSingletonWarnings(activeEntries);
    return {
      cardCount,
      price,
      averageMana: manaQuantity > 0 ? manaTotal / manaQuantity : 0,
      commanderCount,
      singletonWarnings,
      legality:
        singletonWarnings.size > 0
          ? ("warning" as const)
          : commanderCount === 0 || cardCount !== 100
            ? ("building" as const)
            : ("legal" as const),
    };
  }, [deck]);

  return {
    deck,
    announcement,
    canUndo: history.length > 0,
    statistics,
    addCard,
    setQuantity,
    removeCard,
    moveCard,
    undo,
  };
}

function createInitialState(): DeckState {
  let storedValue: string | null = null;
  try {
    storedValue = getLocalStorage()?.getItem(DECK_STORAGE_KEY) ?? null;
  } catch {
    // Treat blocked or malformed browser storage as an empty local deck.
  }

  return {
    deck: parseStoredDeck(storedValue),
    history: [],
    announcement: "Deck ready.",
  };
}

function deckReducer(state: DeckState, action: DeckAction): DeckState {
  if (action.type === "undo") {
    const previous = state.history.at(-1);
    if (!previous) {
      return { ...state, announcement: "Nothing to undo." };
    }
    return {
      deck: previous,
      history: state.history.slice(0, -1),
      announcement: "Last deck change undone.",
    };
  }

  const result = action.mutation(state.deck);
  if (!result) {
    return state;
  }
  return {
    deck: {
      ...result.deck,
      updated_at: new Date().toISOString(),
    },
    history: [
      ...state.history.slice(-(MAX_UNDO_STEPS - 1)),
      state.deck,
    ],
    announcement: result.announcement,
  };
}

function getLocalStorage(): Storage | null {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.getItem !== "function" ||
    typeof window.localStorage?.setItem !== "function"
  ) {
    return null;
  }
  return window.localStorage;
}

function suggestedCategory(card: CardSearchResult): DeckCategory {
  if (card.type_line.includes("Land")) {
    return "lands";
  }
  if (card.type_line.includes("Creature")) {
    return "creatures";
  }
  return "other_spells";
}

function getSingletonWarnings(entries: DeckCardEntry[]): Set<string> {
  const oracleQuantities = new Map<string, number>();
  for (const entry of entries) {
    if (isBasicLand(entry.card.details)) {
      continue;
    }
    oracleQuantities.set(
      entry.card.oracle_id,
      (oracleQuantities.get(entry.card.oracle_id) ?? 0) + entry.quantity,
    );
  }
  return new Set(
    [...oracleQuantities.entries()]
      .filter(([, quantity]) => quantity > 1)
      .map(([oracleId]) => oracleId),
  );
}
