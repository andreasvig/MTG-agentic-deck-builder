import { useCallback, useEffect, useMemo, useReducer } from "react";

import type { CardSearchResult } from "../domain/card";
import { getCardPrice, isBasicLand } from "../domain/card";
import type { Deck, DeckCardEntry, DeckLibrary } from "../domain/deck";
import {
  COMMAND_ZONE_GROUP_ID,
  createDeckLibrary,
  createEmptyDeck,
  DECK_LIBRARY_STORAGE_KEY,
  DECK_STORAGE_KEY,
  getColorIdentityWarnings,
  getCommanderColorIdentity,
  parseStoredDeck,
  parseStoredDeckLibrary,
  placementForGroup,
  UNASSIGNED_GROUP_ID,
} from "../domain/deck";

const MAX_UNDO_STEPS = 30;

interface DeckMutationResult {
  deck: Deck;
  announcement: string;
}

interface DeckState {
  library: DeckLibrary;
  historyByDeck: Record<string, Deck[]>;
  announcement: string;
}

type DeckAction =
  | {
      type: "mutate";
      mutation: (current: Deck) => DeckMutationResult | null;
    }
  | { type: "undo" }
  | { type: "create_deck" }
  | { type: "select_deck"; deckId: string };

export function useDeck() {
  const [state, dispatch] = useReducer(deckReducer, undefined, createInitialState);
  const deck = activeDeck(state.library);
  const history = state.historyByDeck[deck.id] ?? [];

  useEffect(() => {
    try {
      getLocalStorage()?.setItem(
        DECK_LIBRARY_STORAGE_KEY,
        JSON.stringify(state.library),
      );
    } catch {
      // The library remains usable when storage is disabled or full.
    }
  }, [state.library]);

  const mutate = useCallback(
    (mutation: (current: Deck) => DeckMutationResult | null) => {
      dispatch({ type: "mutate", mutation });
    },
    [],
  );

  const addCard = useCallback(
    (card: CardSearchResult, targetGroupId?: string, quantity = 1) => {
      const groupId = targetGroupId ?? UNASSIGNED_GROUP_ID;
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

        const placement = placementForGroup(groupId);
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
          announcement: `${card.name} added to the deck.`,
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
    (scryfallId: string, groupId: string) => {
      mutate((current) => {
        const entry = current.cards.find(
          (candidate) => candidate.card.scryfall_id === scryfallId,
        );
        const validGroup =
          groupId === COMMAND_ZONE_GROUP_ID ||
          groupId === UNASSIGNED_GROUP_ID ||
          current.custom_groups.some((group) => group.id === groupId);
        if (!entry || !validGroup) {
          return null;
        }
        return {
          deck: {
            ...current,
            cards: current.cards.map((candidate) =>
              candidate.card.scryfall_id === scryfallId
                ? { ...candidate, ...placementForGroup(groupId) }
                : candidate,
            ),
          },
          announcement: `${entry.card.name} moved to a custom group.`,
        };
      });
    },
    [mutate],
  );

  const addCustomGroup = useCallback(
    (name: string, moveScryfallId?: string) => {
      const normalizedName = name.trim();
      if (!normalizedName) {
        return;
      }
      const groupId = createLocalId("group");
      mutate((current) => {
        if (
          current.custom_groups.some(
            (group) =>
              group.name.toLocaleLowerCase() ===
              normalizedName.toLocaleLowerCase(),
          )
        ) {
          return null;
        }
        const entryToMove = moveScryfallId
          ? current.cards.find(
              (entry) => entry.card.scryfall_id === moveScryfallId,
            )
          : undefined;
        return {
          deck: {
            ...current,
            custom_groups: [
              ...current.custom_groups,
              { id: groupId, name: normalizedName },
            ],
            cards: entryToMove
              ? current.cards.map((entry) =>
                  entry.card.scryfall_id === moveScryfallId
                    ? { ...entry, ...placementForGroup(groupId) }
                    : entry,
                )
              : current.cards,
          },
          announcement: entryToMove
            ? `${normalizedName} group created and ${entryToMove.card.name} moved to it.`
            : `${normalizedName} group created.`,
        };
      });
    },
    [mutate],
  );

  const renameDeck = useCallback(
    (name: string) => {
      const normalizedName = name.trim();
      if (!normalizedName) {
        return;
      }
      mutate((current) =>
        current.name === normalizedName
          ? null
          : {
              deck: { ...current, name: normalizedName },
              announcement: `Deck renamed to ${normalizedName}.`,
            },
      );
    },
    [mutate],
  );

  const createDeck = useCallback(() => {
    dispatch({ type: "create_deck" });
  }, []);

  const selectDeck = useCallback((deckId: string) => {
    dispatch({ type: "select_deck", deckId });
  }, []);

  const undo = useCallback(() => {
    dispatch({ type: "undo" });
  }, []);

  const statistics = useMemo(() => {
    const cardCount = deck.cards.reduce(
      (total, entry) => total + entry.quantity,
      0,
    );
    const price = deck.cards.reduce(
      (total, entry) =>
        total + getCardPrice(entry.card.details as CardSearchResult) * entry.quantity,
      0,
    );
    const manaCards = deck.cards.filter(
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
    const commanderCount = deck.cards
      .filter((entry) => entry.section === "command_zone")
      .reduce((total, entry) => total + entry.quantity, 0);
    const singletonWarnings = getSingletonWarnings(deck.cards);
    const colorIdentityWarnings = getColorIdentityWarnings(deck.cards);
    const commanderColorIdentity = getCommanderColorIdentity(deck.cards);
    return {
      cardCount,
      price,
      averageMana: manaQuantity > 0 ? manaTotal / manaQuantity : 0,
      commanderCount,
      singletonWarnings,
      colorIdentityWarnings,
      commanderColorIdentity,
      legality:
        singletonWarnings.size > 0 || colorIdentityWarnings.size > 0
          ? ("warning" as const)
          : commanderCount === 0 || cardCount !== 100
            ? ("building" as const)
            : ("legal" as const),
    };
  }, [deck]);

  return {
    deck,
    decks: state.library.decks,
    announcement: state.announcement,
    canUndo: history.length > 0,
    statistics,
    addCard,
    setQuantity,
    removeCard,
    moveCard,
    addCustomGroup,
    renameDeck,
    createDeck,
    selectDeck,
    undo,
  };
}

function createInitialState(): DeckState {
  let storedLibrary: string | null = null;
  let legacyDeck: string | null = null;
  try {
    const storage = getLocalStorage();
    storedLibrary = storage?.getItem(DECK_LIBRARY_STORAGE_KEY) ?? null;
    legacyDeck = storage?.getItem(DECK_STORAGE_KEY) ?? null;
  } catch {
    // Treat blocked or malformed browser storage as an empty library.
  }

  const migrationFallback = legacyDeck
    ? createDeckLibrary(parseStoredDeck(legacyDeck))
    : createDeckLibrary();
  return {
    library: parseStoredDeckLibrary(storedLibrary, migrationFallback),
    historyByDeck: {},
    announcement: "Deck ready.",
  };
}

function deckReducer(state: DeckState, action: DeckAction): DeckState {
  const current = activeDeck(state.library);

  if (action.type === "select_deck") {
    if (!state.library.decks.some((deck) => deck.id === action.deckId)) {
      return state;
    }
    return {
      ...state,
      library: { ...state.library, active_deck_id: action.deckId },
      announcement: "Deck selected.",
    };
  }

  if (action.type === "create_deck") {
    const deck = createEmptyDeck(new Date(), nextDeckName(state.library.decks));
    return {
      ...state,
      library: {
        active_deck_id: deck.id,
        decks: [...state.library.decks, deck],
      },
      announcement: `${deck.name} created.`,
    };
  }

  if (action.type === "undo") {
    const history = state.historyByDeck[current.id] ?? [];
    const previous = history.at(-1);
    if (!previous) {
      return { ...state, announcement: "Nothing to undo." };
    }
    return {
      library: replaceDeck(state.library, previous),
      historyByDeck: {
        ...state.historyByDeck,
        [current.id]: history.slice(0, -1),
      },
      announcement: "Last deck change undone.",
    };
  }

  const result = action.mutation(current);
  if (!result) {
    return state;
  }
  const updatedDeck = {
    ...result.deck,
    updated_at: new Date().toISOString(),
  };
  const history = state.historyByDeck[current.id] ?? [];
  return {
    library: replaceDeck(state.library, updatedDeck),
    historyByDeck: {
      ...state.historyByDeck,
      [current.id]: [
        ...history.slice(-(MAX_UNDO_STEPS - 1)),
        current,
      ],
    },
    announcement: result.announcement,
  };
}

function activeDeck(library: DeckLibrary): Deck {
  return (
    library.decks.find((deck) => deck.id === library.active_deck_id) ??
    library.decks[0]!
  );
}

function replaceDeck(library: DeckLibrary, replacement: Deck): DeckLibrary {
  return {
    ...library,
    decks: library.decks.map((deck) =>
      deck.id === replacement.id ? replacement : deck,
    ),
  };
}

function nextDeckName(decks: Deck[]): string {
  const base = "Untitled Commander";
  if (!decks.some((deck) => deck.name === base)) {
    return base;
  }
  let suffix = 2;
  while (decks.some((deck) => deck.name === `${base} ${suffix}`)) {
    suffix += 1;
  }
  return `${base} ${suffix}`;
}

function createLocalId(prefix: string): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
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
