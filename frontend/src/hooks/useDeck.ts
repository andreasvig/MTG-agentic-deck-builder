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
  getCommandZoneProblem,
  getCommanderColorIdentity,
  groupIdForEntry,
  parseStoredDeck,
  parseStoredDeckLibrary,
  placementForGroup,
  UNASSIGNED_GROUP_ID,
  validateCommandZoneAddition,
} from "../domain/deck";
import type {
  DeckDiffApplyResult,
  DeckEditEntry,
  DeckHistory,
  DeckHistoryActor,
} from "../domain/history";
import {
  appendToHistory,
  applyDeckDiff,
  createDeckHistory,
  DECK_HISTORY_PAYLOAD_CAP,
  DECK_HISTORY_SESSION_CAP,
  DECK_HISTORY_STORAGE_KEY,
  deriveDeckDiff,
  invertDeckDiff,
  parseDeckHistory,
  pruneHistory,
} from "../domain/history";

/** The most copies of one printing an edit may ask for, matching the tool's schema bound. */
const MAX_EDIT_COPIES = 99;

interface DeckMutationResult {
  deck: Deck;
  announcement: string;
}

interface DeckMutationRejection {
  error: string;
}

type DeckMutation = (
  current: Deck,
) => DeckMutationResult | DeckMutationRejection | null;

/**
 * One card's state after an edit, stated as the copy count wanted **afterwards** rather than
 * as an operation. `quantity: 0` removes, and a change the deck already satisfies is a no-op
 * — which is what makes a retried agent edit safe to apply a second time.
 */
export interface DeckEditChange {
  /**
   * The resolved printing. An edit is allowed to add a card the browser has never seen, and
   * `validateCommandZoneAddition` and the colour-identity checks read the card's own fields,
   * so the payload has to travel with the change rather than being looked up.
   */
  card: CardSearchResult;
  quantity: number;
  /** Where the card should sit afterwards. Omit to leave an existing card's placement alone. */
  groupId?: string;
}

/** A whole edit: one intent, applied as one undo step and recorded as one history entry. */
export interface DeckEdit {
  changes: DeckEditChange[];
  /** The one-liner history records. Agent edits carry the model's; a user edit needs none. */
  reason?: string;
}

/**
 * What the deck did with an edit it was handed.
 *
 * The validators live here and only here, so the deck is the only thing that knows whether
 * an edit happened — and a caller that assumed it did would describe an intention. The
 * refusal travels back carrying the *same* sentence the announcement carries, because two
 * places wording why an edit failed is two places to disagree.
 */
export type DeckEditOutcome =
  | { applied: true }
  | { applied: false; reason: string };

interface DeletedDeckSnapshot {
  deck: Deck;
  index: number;
  /** Archived with the deck, restored with the deck. Otherwise a restored deck has no past. */
  history: DeckHistory;
  replacementDeckId: string | null;
}

interface DeckState {
  library: DeckLibrary;
  /** One edit log per deck, keyed by deck id. */
  editLogs: Record<string, DeckHistory>;
  announcement: string;
  announcementTone: "status" | "error";
  deletedDeck: DeletedDeckSnapshot | null;
}

type DeckAction =
  | { type: "mutate"; mutation: DeckMutation }
  | { type: "apply_edit"; edit: DeckEdit; actor: DeckHistoryActor }
  | { type: "undo" }
  | { type: "create_deck" }
  | { type: "select_deck"; deckId: string }
  | { type: "delete_deck"; deckId: string }
  | { type: "restore_deleted_deck" }
  | { type: "clear_announcement" };

export function useDeck() {
  const [state, dispatch] = useReducer(deckReducer, undefined, createInitialState);
  const deck = activeDeck(state.library);

  useEffect(() => {
    try {
      getLocalStorage()?.setItem(
        DECK_LIBRARY_STORAGE_KEY,
        JSON.stringify(state.library),
      );
    } catch {
      // The library remains usable when storage is disabled or full.
    }
    // Written second and in its own attempt, because the two share one quota: a history
    // write that fails costs undo depth after a reload, while a library write that was
    // skipped to make room for it would cost a deck edit.
    try {
      getLocalStorage()?.setItem(
        DECK_HISTORY_STORAGE_KEY,
        JSON.stringify(state.editLogs),
      );
    } catch {
      // Undo stays available for this session even when history cannot be stored.
    }
  }, [state.library, state.editLogs]);

  const mutate = useCallback((mutation: DeckMutation) => {
    dispatch({ type: "mutate", mutation });
  }, []);

  const addCard = useCallback(
    (card: CardSearchResult, targetGroupId?: string, quantity = 1) => {
      const groupId = targetGroupId ?? UNASSIGNED_GROUP_ID;
      mutate((current) => {
        const existingIndex = current.cards.findIndex(
          (entry) => entry.card.scryfall_id === card.scryfall_id,
        );
        if (groupId === COMMAND_ZONE_GROUP_ID) {
          if (quantity !== 1) {
            return {
              error: "Command-zone cards must be added one copy at a time.",
            };
          }
          if (existingIndex >= 0) {
            const existing = current.cards[existingIndex];
            if (existing.section === "command_zone") {
              return {
                error: `${card.name} is already in the command zone. Commanders may only have one copy.`,
              };
            }
            if (existing.quantity !== 1) {
              return {
                error: `${card.name} has ${existing.quantity} copies in the deck. Reduce it to one before moving it to the command zone.`,
              };
            }
          }
          const validation = validateCommandZoneAddition(
            current.cards,
            card,
          );
          if (!validation.allowed) {
            return {
              error:
                validation.reason ??
                `${card.name} cannot be added to the command zone.`,
            };
          }
          if (existingIndex >= 0) {
            return {
              deck: {
                ...current,
                cards: current.cards.map((entry, index) =>
                  index === existingIndex
                    ? {
                        ...entry,
                        ...placementForGroup(COMMAND_ZONE_GROUP_ID),
                      }
                    : entry,
                ),
              },
              announcement: `${card.name} moved to the command zone.`,
            };
          }
        }
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
        if (entry.section === "command_zone" && quantity > 1) {
          return {
            error:
              "A commander may only have one copy in the command zone.",
          };
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
        if (
          groupId === COMMAND_ZONE_GROUP_ID &&
          entry.section !== "command_zone"
        ) {
          if (entry.quantity !== 1) {
            return {
              error: `${entry.card.name} has ${entry.quantity} copies in the deck. Reduce it to one before moving it to the command zone.`,
            };
          }
          if (!entry.card.details) {
            return {
              error: `${entry.card.name} is missing card details, so its command-zone eligibility cannot be checked.`,
            };
          }
          const validation = validateCommandZoneAddition(
            current.cards,
            entry.card.details,
          );
          if (!validation.allowed) {
            return {
              error:
                validation.reason ??
                `${entry.card.name} cannot be moved to the command zone.`,
            };
          }
        }
        if (
          groupId === COMMAND_ZONE_GROUP_ID &&
          entry.section === "command_zone"
        ) {
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
          announcement:
            groupId === COMMAND_ZONE_GROUP_ID
              ? `${entry.card.name} moved to the command zone.`
              : `${entry.card.name} moved to a custom group.`,
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

  /**
   * Apply a whole resolved edit as one change, and report what became of it. It runs the
   * same validators the drag path runs, refuses entirely rather than in part, and lands as a
   * single undo step and a single history entry under the given actor.
   *
   * The verdict is reached here as well as in the reducer because `dispatch` cannot answer
   * its caller: the reducer runs later and yields state, not a verdict. Both run the very
   * same pure closure over the very same deck, so what is reported is what the reducer
   * reaches — the reducer stays the authority on the deck, and this is only its report. The
   * caller needs it because a refused edit that nobody was told about becomes a durable
   * claim somewhere else that the edit happened.
   */
  const applyEdit = useCallback(
    (edit: DeckEdit, actor: DeckHistoryActor): DeckEditOutcome => {
      const result = deckEditMutation(edit)(deck);
      dispatch({ type: "apply_edit", edit, actor });
      return result && "error" in result
        ? { applied: false, reason: result.error }
        : { applied: true };
    },
    [deck],
  );

  const createDeck = useCallback(() => {
    dispatch({ type: "create_deck" });
  }, []);

  const selectDeck = useCallback((deckId: string) => {
    dispatch({ type: "select_deck", deckId });
  }, []);

  const deleteDeck = useCallback((deckId: string) => {
    dispatch({ type: "delete_deck", deckId });
  }, []);

  const restoreDeletedDeck = useCallback(() => {
    dispatch({ type: "restore_deleted_deck" });
  }, []);

  const clearAnnouncement = useCallback(() => {
    dispatch({ type: "clear_announcement" });
  }, []);

  const undo = useCallback(() => {
    dispatch({ type: "undo" });
  }, []);

  /**
   * Whether the last recorded edit can actually be replayed backwards, established by
   * planning the undo rather than by counting entries. An entry whose pooled card payloads
   * have been pruned is readable but not replayable, so counting would light the button up
   * for an undo the reducer then refuses.
   */
  const canUndo = useMemo(
    () => planUndo(deck, editLogFor(state.editLogs, deck.id))?.ok === true,
    [deck, state.editLogs],
  );

  const statistics = useMemo(() => {
    const cardCount = deck.cards.reduce(
      (total, entry) => total + entry.quantity,
      0,
    );
    // An entry may legitimately hold no `details`: `isDeckEntry` does not require one, so a
    // deck written by an older build hydrates without it. `getCardPrice` reads `prices`
    // unguarded, and the cast that used to stand here hid that from the type checker, so a
    // single such entry took the whole board down inside this memo. Skipping it is what
    // `getColorIdentityWarnings` already does. The total then under-reports, which is the
    // behaviour an unpriced card has had all along.
    const price = deck.cards.reduce(
      (total, entry) =>
        entry.card.details
          ? total + getCardPrice(entry.card.details) * entry.quantity
          : total,
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
    const commandZoneProblem = getCommandZoneProblem(deck.cards);
    return {
      cardCount,
      price,
      averageMana: manaQuantity > 0 ? manaTotal / manaQuantity : 0,
      commanderCount,
      singletonWarnings,
      colorIdentityWarnings,
      commanderColorIdentity,
      commandZoneProblem,
      legality:
        singletonWarnings.size > 0 ||
        colorIdentityWarnings.size > 0 ||
        commandZoneProblem !== null
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
    announcementTone: state.announcementTone,
    canUndo,
    deletedDeckName: state.deletedDeck?.deck.name ?? null,
    statistics,
    addCard,
    applyEdit,
    setQuantity,
    removeCard,
    moveCard,
    addCustomGroup,
    renameDeck,
    createDeck,
    selectDeck,
    deleteDeck,
    restoreDeletedDeck,
    clearAnnouncement,
    undo,
  };
}

function createInitialState(): DeckState {
  let storedLibrary: string | null = null;
  let legacyDeck: string | null = null;
  let storedLogs: string | null = null;
  try {
    const storage = getLocalStorage();
    storedLibrary = storage?.getItem(DECK_LIBRARY_STORAGE_KEY) ?? null;
    legacyDeck = storage?.getItem(DECK_STORAGE_KEY) ?? null;
    storedLogs = storage?.getItem(DECK_HISTORY_STORAGE_KEY) ?? null;
  } catch {
    // Treat blocked or malformed browser storage as an empty library.
  }

  const migrationFallback = legacyDeck
    ? createDeckLibrary(parseStoredDeck(legacyDeck))
    : createDeckLibrary();
  const library = parseStoredDeckLibrary(storedLibrary, migrationFallback);
  return {
    library,
    editLogs: parseStoredEditLogs(storedLogs, library.decks),
    announcement: "Deck ready.",
    announcementTone: "status",
    deletedDeck: null,
  };
}

/**
 * Rebuild one log per deck from the single stored envelope.
 *
 * Each log is validated on its own, so one corrupt log costs that deck its undo depth rather
 * than the whole library's. Only decks still in the library are hydrated: a log whose deck
 * was deleted in an earlier session can never be reached again, and history shares the deck's
 * storage quota. The envelope key is the authority on which deck a log belongs to, so a
 * stored `deck_id` that disagrees with it is corrected rather than carried forward.
 */
function parseStoredEditLogs(
  rawValue: string | null,
  decks: Deck[],
): Record<string, DeckHistory> {
  let stored: unknown = null;
  try {
    stored = rawValue === null ? null : JSON.parse(rawValue);
  } catch {
    // A malformed history costs undo depth, never the deck.
  }

  const byDeck = isRecord(stored) ? stored : {};
  const logs: Record<string, DeckHistory> = {};
  for (const deck of decks) {
    const candidate = byDeck[deck.id];
    // The payload pool has to be a keyed object. An array would satisfy a container check and
    // then index to nothing, giving a log whose every restoration refuses, so a pool of the
    // wrong shape is turned away here rather than hydrated.
    const pool = isRecord(candidate) ? candidate.cards : undefined;
    const usable = isRecord(pool) && !Array.isArray(pool);
    const parsed = parseDeckHistory(
      usable ? candidate : null,
      createDeckHistory(deck.id),
    );
    if (parsed.sessions.length > 0) {
      logs[deck.id] = { ...parsed, deck_id: deck.id };
    }
  }
  return logs;
}

function deckReducer(state: DeckState, action: DeckAction): DeckState {
  const current = activeDeck(state.library);

  if (action.type === "clear_announcement") {
    return {
      ...state,
      announcement: "",
      announcementTone: "status",
    };
  }

  if (action.type === "select_deck") {
    if (!state.library.decks.some((deck) => deck.id === action.deckId)) {
      return state;
    }
    return {
      ...state,
      library: { ...state.library, active_deck_id: action.deckId },
      announcement: "Deck selected.",
      announcementTone: "status",
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
      announcementTone: "status",
    };
  }

  if (action.type === "delete_deck") {
    const deletedIndex = state.library.decks.findIndex(
      (deck) => deck.id === action.deckId,
    );
    if (deletedIndex < 0) {
      return state;
    }
    const deleted = state.library.decks[deletedIndex];
    let remaining = state.library.decks.filter(
      (deck) => deck.id !== action.deckId,
    );
    let replacementDeckId: string | null = null;
    if (remaining.length === 0) {
      const replacement = createEmptyDeck();
      remaining = [replacement];
      replacementDeckId = replacement.id;
    }
    const nextActive =
      state.library.active_deck_id === action.deckId
        ? (remaining[Math.min(deletedIndex, remaining.length - 1)]?.id ??
          remaining[0].id)
        : state.library.active_deck_id;
    const { [action.deckId]: deletedLog, ...remainingLogs } = state.editLogs;
    return {
      library: {
        active_deck_id: nextActive,
        decks: remaining,
      },
      editLogs: remainingLogs,
      announcement: `${deleted.name} deleted.`,
      announcementTone: "status",
      deletedDeck: {
        deck: deleted,
        index: deletedIndex,
        history: deletedLog ?? createDeckHistory(action.deckId),
        replacementDeckId,
      },
    };
  }

  if (action.type === "restore_deleted_deck") {
    const snapshot = state.deletedDeck;
    if (
      !snapshot ||
      state.library.decks.some((deck) => deck.id === snapshot.deck.id)
    ) {
      return state;
    }
    const withoutUnusedReplacement = snapshot.replacementDeckId
      ? state.library.decks.filter(
          (deck) =>
            deck.id !== snapshot.replacementDeckId ||
            !isUntouchedEmptyDeck(deck),
        )
      : state.library.decks;
    const restoredDecks = [...withoutUnusedReplacement];
    restoredDecks.splice(
      Math.min(snapshot.index, restoredDecks.length),
      0,
      snapshot.deck,
    );
    return {
      library: {
        active_deck_id: snapshot.deck.id,
        decks: restoredDecks,
      },
      editLogs: {
        ...state.editLogs,
        [snapshot.deck.id]: snapshot.history,
      },
      announcement: `${snapshot.deck.name} restored.`,
      announcementTone: "status",
      deletedDeck: null,
    };
  }

  if (action.type === "undo") {
    const log = editLogFor(state.editLogs, current.id);
    const undone = planUndo(current, log);
    if (undone === null) {
      return {
        ...state,
        announcement: "Nothing to undo.",
        announcementTone: "status",
      };
    }
    if (!undone.ok) {
      // A refusal is announced rather than thrown, and the deck is left exactly as it was.
      // Undoing halfway would be worse than not undoing.
      return {
        ...state,
        announcement: undone.message,
        announcementTone: "error",
      };
    }
    return {
      ...state,
      library: replaceDeck(state.library, {
        ...undone.deck,
        updated_at: new Date().toISOString(),
      }),
      editLogs: { ...state.editLogs, [current.id]: withoutLastEdit(log) },
      announcement: "Last deck change undone.",
      announcementTone: "status",
    };
  }

  // An edit becomes the same kind of closure every mutator produces, so both arrive at the
  // one derivation below and a whole edit is one entry in the log and one step of undo.
  const mutation =
    action.type === "apply_edit"
      ? deckEditMutation(action.edit)
      : action.mutation;
  const result = mutation(current);
  if (!result) {
    return state;
  }
  if ("error" in result) {
    return {
      ...state,
      announcement: result.error,
      announcementTone: "error",
    };
  }
  const updatedDeck = {
    ...result.deck,
    updated_at: new Date().toISOString(),
  };

  // The one place the deck is diffed, for every mutation there is. The reducer already holds
  // the deck before and the deck after, so the change is derived from what actually happened
  // rather than from what a call site remembered to declare: the record is complete by
  // construction, and a mutator added next year is recorded with no extra wiring at all.
  const { diff, payloads } = deriveDeckDiff(current, updatedDeck);
  const log = editLogFor(state.editLogs, current.id);
  const entry: DeckEditEntry = {
    id: createLocalId("edit"),
    // The reducer's own stamp, so the edit's time and the deck's `updated_at` cannot disagree.
    at: updatedDeck.updated_at,
    ...diff,
    ...(action.type === "apply_edit" && action.edit.reason
      ? { reason: action.edit.reason }
      : {}),
  };
  const appended = appendToHistory(log, {
    entry,
    payloads,
    actor: action.type === "apply_edit" ? action.actor : "user",
    newSessionId: createLocalId("session"),
  });
  // `appendToHistory` hands back the very object it was given when the diff was empty, so
  // reference identity is how a mutation that changed nothing but `updated_at` is recognised
  // — no second derivation and no empty entry in the log.
  return {
    ...state,
    library: replaceDeck(state.library, updatedDeck),
    editLogs:
      appended === log
        ? state.editLogs
        : {
            ...state.editLogs,
            [current.id]: pruneHistory(
              appended,
              DECK_HISTORY_SESSION_CAP,
              DECK_HISTORY_PAYLOAD_CAP,
            ),
          },
    announcement: result.announcement,
    announcementTone: "status",
  };
}

function editLogFor(
  logs: Record<string, DeckHistory>,
  deckId: string,
): DeckHistory {
  return logs[deckId] ?? createDeckHistory(deckId);
}

/**
 * What undoing the last recorded edit would do, or `null` when nothing is recorded.
 *
 * `canUndo` and the `undo` action both come through here, so the button cannot promise an
 * undo the reducer then refuses. There are two ways an entry stops being replayable and both
 * arrive as the same refusal: its pooled payload was pruned, or the card it has to put back
 * never had a `details` payload to pool in the first place.
 */
function planUndo(
  deck: Deck,
  log: DeckHistory,
): DeckDiffApplyResult | null {
  const entry = log.sessions.at(-1)?.edits.at(-1);
  return entry ? applyDeckDiff(deck, invertDeckDiff(entry), log.cards) : null;
}

/**
 * Drop the last recorded edit, because an undo pops the log rather than appending its inverse.
 *
 * The alternative would make undo itself undoable, and would leave the log describing an edit
 * the deck no longer contains. The agent reads this log to decide what to do next, so a log
 * that disagrees with the deck is the same class of error as a half-applied edit.
 */
function withoutLastEdit(log: DeckHistory): DeckHistory {
  const open = log.sessions.at(-1);
  if (!open) {
    return log;
  }
  const edits = open.edits.slice(0, -1);
  const sessions =
    edits.length > 0
      ? [
          ...log.sessions.slice(0, -1),
          // `ended_at` rewinds with the pop, or the next edit would join a session by a gap
          // measured against an edit that is no longer in it.
          { ...open, ended_at: edits[edits.length - 1].at, edits },
        ]
      : log.sessions.slice(0, -1);
  // Pruning here is the garbage collection: the popped edit may have been the only reason a
  // pooled payload was still worth keeping.
  return pruneHistory(
    { ...log, sessions },
    DECK_HISTORY_SESSION_CAP,
    DECK_HISTORY_PAYLOAD_CAP,
  );
}

/** What applying one change did, so the announcement can name counts the applier is sure of. */
interface DeckEditChangeResult {
  deck: Deck;
  added: number;
  removed: number;
  moved: number;
}

/**
 * Turn a resolved edit into the closure the reducer already knows how to run.
 *
 * Changes are folded onto a working deck in order and the whole edit is refused the moment
 * one of them is, so the working deck is discarded and the real one is never touched. A
 * half-applied edit is the worst outcome available here, because history would then record an
 * intent that did not happen. Folding in order is also what makes a swap expressible: the
 * incoming commander is validated against the deck the outgoing one has already left.
 */
function deckEditMutation(edit: DeckEdit): DeckMutation {
  return (current) => {
    if (edit.changes.length === 0) {
      return null;
    }

    let deck = current;
    let added = 0;
    let removed = 0;
    let moved = 0;
    for (const change of edit.changes) {
      const applied = applyEditChange(deck, change);
      if ("error" in applied) {
        return applied;
      }
      deck = applied.deck;
      added += applied.added;
      removed += applied.removed;
      moved += applied.moved;
    }

    const parts = [
      added > 0 ? `${added} added` : "",
      removed > 0 ? `${removed} removed` : "",
      moved > 0 ? `${moved} moved` : "",
    ].filter((part) => part.length > 0);
    if (parts.length === 0) {
      return {
        deck,
        announcement: "The deck already matched that edit, so nothing changed.",
      };
    }
    const cardCount = deck.cards.reduce(
      (total, entry) => total + entry.quantity,
      0,
    );
    return {
      deck,
      announcement: `Edit applied: ${parts.join(", ")}, ${cardCount} cards now.`,
    };
  };
}

/**
 * Apply one declared card state, running the validators the drag path runs.
 *
 * The one guard deliberately not carried over is `addCard`'s refusal to move a card holding
 * several copies into the command zone. That guard exists because dragging cannot say what
 * the quantity should become; a change states the count it wants, so declaring one copy in the
 * command zone is a complete instruction rather than an ambiguous one. Commander legality and
 * the one-copy rule are enforced exactly as they are for a drag, and colour identity stays a
 * warning here as it is there.
 */
function applyEditChange(
  deck: Deck,
  change: DeckEditChange,
): DeckEditChangeResult | DeckMutationRejection {
  const { card, quantity } = change;
  // Rejected, never coerced: `Number(undefined)` is `NaN` and `Number(null)` is 0, and a
  // quantity that silently became 0 deletes a card the edit meant to keep.
  if (
    !Number.isInteger(quantity) ||
    quantity < 0 ||
    quantity > MAX_EDIT_COPIES
  ) {
    return {
      error: `${card.name} cannot be set to ${quantity} copies. A quantity must be a whole number from 0 to ${MAX_EDIT_COPIES}.`,
    };
  }

  const existingIndex = deck.cards.findIndex(
    (entry) => entry.card.scryfall_id === card.scryfall_id,
  );
  const existing = existingIndex >= 0 ? deck.cards[existingIndex] : undefined;

  if (quantity === 0) {
    if (!existing) {
      // Already absent. Cutting a card twice is the same deck, which is what lets a retried
      // edit be safe.
      return { deck, added: 0, removed: 0, moved: 0 };
    }
    return {
      deck: {
        ...deck,
        cards: deck.cards.filter((_, index) => index !== existingIndex),
      },
      added: 0,
      removed: existing.quantity,
      moved: 0,
    };
  }

  const groupId =
    change.groupId ??
    (existing ? groupIdForEntry(existing, deck.custom_groups) : UNASSIGNED_GROUP_ID);
  if (
    groupId !== COMMAND_ZONE_GROUP_ID &&
    groupId !== UNASSIGNED_GROUP_ID &&
    !deck.custom_groups.some((group) => group.id === groupId)
  ) {
    return {
      error: `${card.name} cannot be placed in a group this deck does not have. Create the group first.`,
    };
  }

  if (groupId === COMMAND_ZONE_GROUP_ID) {
    if (quantity !== 1) {
      return {
        error: `${card.name} is a commander, so it may only have one copy in the command zone.`,
      };
    }
    // A card already in the command zone is not a new addition, and asking whether it may
    // join would refuse it for being there already.
    if (existing?.section !== "command_zone") {
      const validation = validateCommandZoneAddition(deck.cards, card);
      if (!validation.allowed) {
        return {
          error:
            validation.reason ??
            `${card.name} cannot be added to the command zone.`,
        };
      }
    }
  }

  const placement = placementForGroup(groupId);
  if (!existing) {
    return {
      deck: {
        ...deck,
        cards: [
          ...deck.cards,
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
      added: quantity,
      removed: 0,
      moved: 0,
    };
  }

  const relocated =
    existing.section !== placement.section ||
    existing.categories[0] !== placement.categories[0];
  if (existing.quantity === quantity && !relocated) {
    return { deck, added: 0, removed: 0, moved: 0 };
  }
  return {
    deck: {
      ...deck,
      cards: deck.cards.map((entry, index) =>
        index === existingIndex ? { ...entry, quantity, ...placement } : entry,
      ),
    },
    added: Math.max(0, quantity - existing.quantity),
    removed: Math.max(0, existing.quantity - quantity),
    moved: relocated ? 1 : 0,
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

function isUntouchedEmptyDeck(deck: Deck): boolean {
  return (
    deck.name === "Untitled Commander" &&
    deck.cards.length === 0 &&
    deck.custom_groups.length === 0 &&
    deck.created_at === deck.updated_at
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
