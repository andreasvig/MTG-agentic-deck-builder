import type { CardSearchResult } from "./card";
import type { Deck, DeckCardEntry, DeckSection } from "./deck";

/**
 * The deck's edit log: what changed, when, and whether the user or the agent did it.
 *
 * The whole module rests on one idea. Every mutation in `useDeck` already goes through a
 * single reducer action that holds the deck *before* and the deck *after*, so the diff is
 * derived from that pair rather than declared by the call site. No mutator has to describe
 * its own change, a mutator added next year is recorded automatically, and inverting an
 * edit is nothing but swapping `before` for `after` on every change it carries.
 *
 * That only holds while the diff models everything a `Deck` can differ by. It models
 * `cards[]` (quantity and section) and `name`. It deliberately excludes `id`, `format` and
 * `created_at`, which never change, and `updated_at`, which the reducer stamps on every
 * mutation — recording that would make every inversion fight the reducer over a field
 * neither of them means to restore.
 *
 * A stored entry written before custom groups were removed carries two fields this module
 * no longer models: `categories` inside a placement, and a `groups` array on the diff. Both
 * are ignored rather than rejected, so an old log stays readable and its card changes stay
 * replayable. Nothing writes either again.
 *
 * Nothing here reads the clock, generates an id, or touches `localStorage`. Times and ids
 * arrive as arguments so a test can pin a session boundary to the second, and persistence
 * belongs to the hook.
 */

export const DECK_HISTORY_STORAGE_KEY = "manabase.deck-history.v1";

/**
 * How long an editing stretch stays one session. An edit lands in the open session when
 * the gap since its last edit is at most this, so a whole afternoon of small changes reads
 * as one entry rather than forty.
 */
export const DECK_HISTORY_SESSION_WINDOW_SECONDS = 180;

/** Sessions retained for reading. This is *read* depth: it bounds what the agent can see. */
export const DECK_HISTORY_SESSION_CAP = 50;

/**
 * Edits whose card payloads stay pooled. This is *undo* depth, because replaying an edit
 * backwards needs the payload of any card it has to put back. It is deliberately a
 * separate, smaller number than the session cap: a pruned entry stays readable and only
 * stops being undoable.
 */
export const DECK_HISTORY_PAYLOAD_CAP = 50;

/** Who made an edit. It sits on the session, so every edit inside one shares it. */
export type DeckHistoryActor = "user" | "agent";

/**
 * Where one printing sat in the deck, on one side of a change.
 *
 * `index` is the position the entry held in `Deck.cards`. It is recorded so that undoing a
 * removal returns the card to where it was instead of to the end of the list, and it is
 * deliberately **not** part of change detection: cutting one card from a hundred shifts
 * ninety-nine indices, and treating that as ninety-nine changes would make every diff
 * unreadable and every summary wrong. No mutator reorders `cards` — display order comes
 * from `DeckBoard`'s sort — so position is a hint for faithful restoration, not an axis
 * the deck is edited along.
 */
export interface DeckCardPlacement {
  quantity: number;
  section: DeckSection;
  index: number;
}

/**
 * One printing that changed, with both sides of the change.
 *
 * `oracle_id` and `name` are denormalised so history reads without the catalog and without
 * the payload pool: a pruned entry can still name the card it touched and still link it by
 * gameplay identity, which is what `read_history` and the chat's card links need.
 */
export interface DeckCardChange {
  oracle_id: string;
  scryfall_id: string;
  name: string;
  /** `null` means the card was not in the deck. */
  before: DeckCardPlacement | null;
  /** `null` means it was removed. */
  after: DeckCardPlacement | null;
}

export interface DeckNameChange {
  before: string;
  after: string;
}

/**
 * Everything one edit changed. `deriveDeckDiff` produces this; the caller stamps identity
 * onto it to get a `DeckEditEntry`.
 *
 * `name` is omitted rather than left empty when the deck was not renamed, because history
 * shares `localStorage` with the deck library and a field per edit saying nothing happened
 * is quota spent on nothing.
 */
export interface DeckDiff {
  /** `+2 / −2` plus the names, for display. Recomputed when a diff is inverted. */
  summary: string;
  cards: DeckCardChange[];
  name?: DeckNameChange;
}

/** One recorded edit: a diff plus who-when-why. */
export interface DeckEditEntry extends DeckDiff {
  id: string;
  /** ISO time the edit happened. Also what the session rule measures its gap against. */
  at: string;
  /** Agent edits carry the model's one-liner; user edits have none. */
  reason?: string;
}

/** A stretch of edits by one actor, with no gap longer than the session window. */
export interface DeckSession {
  id: string;
  actor: DeckHistoryActor;
  started_at: string;
  ended_at: string;
  /** Oldest first. */
  edits: DeckEditEntry[];
}

/**
 * One deck's whole log.
 *
 * `cards` is the payload pool: **one `CardSearchResult` per printing, not per change.** A
 * payload is 2–4KB of JSON, and undoing a removal needs one to rebuild the entry's
 * `details` — without it the restored card loses its price, its mana value and the inputs
 * both validators read. Adding and cutting the same card ten times therefore stores it
 * once, and `pruneHistory` drops the ids no retained edit still needs.
 */
export interface DeckHistory {
  deck_id: string;
  /** Oldest first. */
  sessions: DeckSession[];
  /** Keyed by `scryfall_id`. */
  cards: Record<string, CardSearchResult>;
}

/**
 * What one derivation found: the diff, and the payloads the pool needs in order to be able
 * to replay it. They are returned together because the diff alone cannot rebuild a card it
 * puts back.
 */
export interface DeckDiffDerivation {
  diff: DeckDiff;
  payloads: Record<string, CardSearchResult>;
}

/** The arguments `appendToHistory` needs beyond the history itself. */
export interface DeckHistoryAppend {
  entry: DeckEditEntry;
  /** Merged into the pool. Usually straight from `deriveDeckDiff`. */
  payloads: Record<string, CardSearchResult>;
  actor: DeckHistoryActor;
  /** Used only when the edit cannot join the open session. Passed in so tests can pin it. */
  newSessionId: string;
}

/** The one way applying a diff can fail: a card to restore whose payload was pruned. */
export type DeckDiffApplyProblem = "missing_payload";

export interface DeckDiffApplyFailure {
  ok: false;
  problem: DeckDiffApplyProblem;
  /** The printings it could not rebuild. */
  scryfall_ids: string[];
  /** Ready to announce. It can name the cards because the change denormalises the name. */
  message: string;
}

/**
 * A typed result rather than a throw, because the caller is a reducer. An undo that cannot
 * find a payload has to leave the deck alone and say so; an exception there would strand
 * the reducer mid-action.
 */
export type DeckDiffApplyResult = { ok: true; deck: Deck } | DeckDiffApplyFailure;

export function createDeckHistory(deckId: string): DeckHistory {
  return { deck_id: deckId, sessions: [], cards: {} };
}

/**
 * Compare two states of one deck and describe the difference.
 *
 * Complete by construction: it walks the union of both card lists and compares the deck
 * name, so a change no call site remembered to declare is still recorded. A card whose
 * quantity and section both match is not a change, however far its position moved.
 */
export function deriveDeckDiff(before: Deck, after: Deck): DeckDiffDerivation {
  const beforeCards = indexEntriesByPrinting(before.cards);
  const afterCards = indexEntriesByPrinting(after.cards);
  const payloads: Record<string, CardSearchResult> = {};
  const cards: DeckCardChange[] = [];

  for (const scryfallId of unionKeys(beforeCards, afterCards)) {
    const beforeEntry = beforeCards.get(scryfallId);
    const afterEntry = afterCards.get(scryfallId);
    const beforePlacement = beforeEntry
      ? cardPlacement(beforeEntry.entry, beforeEntry.index)
      : null;
    const afterPlacement = afterEntry
      ? cardPlacement(afterEntry.entry, afterEntry.index)
      : null;
    if (cardPlacementsMatch(beforePlacement, afterPlacement)) {
      continue;
    }

    const reference = (afterEntry ?? beforeEntry)?.entry.card;
    cards.push({
      oracle_id: reference?.oracle_id ?? "",
      scryfall_id: scryfallId,
      name: reference?.name ?? scryfallId,
      before: beforePlacement,
      after: afterPlacement,
    });

    // A card that stays in the deck keeps its own `CardReference`, so only one that enters
    // or leaves it can ever need rebuilding from the pool. Pooling the rest would spend
    // quota on payloads no replay reads.
    if (beforePlacement === null || afterPlacement === null) {
      const details =
        afterEntry?.entry.card.details ?? beforeEntry?.entry.card.details;
      if (details) {
        payloads[scryfallId] = details;
      }
    }
  }

  const name =
    before.name === after.name
      ? undefined
      : { before: before.name, after: after.name };

  return {
    diff: {
      summary: summariseDeckDiff(cards, name),
      cards,
      ...(name ? { name } : {}),
    },
    payloads,
  };
}

/** True when a derivation found nothing. `appendToHistory` refuses these. */
export function isEmptyDeckDiff(diff: DeckDiff): boolean {
  return diff.cards.length === 0 && diff.name === undefined;
}

/**
 * Turn an edit into the edit that reverses it, by swapping both sides of every change.
 *
 * This is the entire undo mechanism, which is why the derivation has to be complete: there
 * is no per-mutation inverse to write, and therefore none to forget. Identity is preserved
 * — `id`, `at` and `reason` come through untouched — so the caller decides whether an undo
 * is a new entry in the log or the removal of an old one. Only `summary` is recomputed,
 * since a reversed edit no longer adds what the original added.
 */
export function invertDeckDiff(entry: DeckEditEntry): DeckEditEntry {
  const cards = entry.cards.map((change) => ({
    ...change,
    before: change.after,
    after: change.before,
  }));
  const name = entry.name
    ? { before: entry.name.after, after: entry.name.before }
    : undefined;

  return {
    ...entry,
    cards,
    ...(name ? { name } : {}),
    summary: summariseDeckDiff(cards, name),
  };
}

/**
 * Write a diff's `after` side onto a deck.
 *
 * Declarative, not transactional: it states what each mentioned card should look like
 * afterwards and never checks the `before` side against what it finds. That makes
 * applying idempotent — the same diff twice is the same deck — which matters because an
 * auto-applying agent edit may be retried, and because a replay must not fail merely
 * because the user dragged something in between.
 *
 * `payloads` is the history's card pool. A card the diff puts back that is not already in
 * the deck has to be rebuilt from it, so a pruned payload is a refusal rather than a
 * silently detail-less entry: an entry without `details` prices at zero and disappears from
 * both the colour-identity and command-zone checks, which is worse than not undoing.
 */
export function applyDeckDiff(
  deck: Deck,
  diff: DeckDiff,
  payloads: Record<string, CardSearchResult>,
): DeckDiffApplyResult {
  const present = new Set(deck.cards.map((entry) => entry.card.scryfall_id));

  const removals = new Set<string>();
  const updates = new Map<string, DeckCardPlacement>();
  const insertions: { change: DeckCardChange; placement: DeckCardPlacement }[] =
    [];
  const unrestorable: DeckCardChange[] = [];
  for (const change of diff.cards) {
    if (change.after === null) {
      removals.add(change.scryfall_id);
    } else if (present.has(change.scryfall_id)) {
      updates.set(change.scryfall_id, change.after);
    } else if (payloads[change.scryfall_id]) {
      insertions.push({ change, placement: change.after });
    } else {
      unrestorable.push(change);
    }
  }

  if (unrestorable.length > 0) {
    const names = unrestorable.map((change) => change.name).join(", ");
    return {
      ok: false,
      problem: "missing_payload",
      scryfall_ids: unrestorable.map((change) => change.scryfall_id),
      // Says what is true without asserting why. Two causes reach here — the payload was
      // pruned to stay inside the storage budget, or the card never had details to pool in the
      // first place (a deck written by an older build hydrates that way) — and this function
      // cannot tell them apart, so claiming "pruned" is wrong half the time.
      message: `This change cannot be replayed: history holds no card details for ${names}.`,
    };
  }

  // Removals first, so that an insertion index means a position in the list the diff
  // describes rather than one in the list it started from.
  const cards = deck.cards
    .filter((entry) => !removals.has(entry.card.scryfall_id))
    .map((entry) => {
      const placement = updates.get(entry.card.scryfall_id);
      return placement ? withCardPlacement(entry, placement) : entry;
    });
  for (const { change, placement } of sortedByIndex(insertions)) {
    cards.splice(clampIndex(placement.index, cards.length), 0, {
      card: {
        oracle_id: change.oracle_id,
        scryfall_id: change.scryfall_id,
        name: change.name,
        details: payloads[change.scryfall_id],
      },
      quantity: placement.quantity,
      section: placement.section,
    });
  }

  return {
    ok: true,
    deck: {
      ...deck,
      name: diff.name ? diff.name.after : deck.name,
      cards,
    },
  };
}

/**
 * Record an edit, extending the open session or opening a new one.
 *
 * The rule is one condition: join the last session when its actor matches **and** the gap
 * since its `ended_at` is at most `DECK_HISTORY_SESSION_WINDOW_SECONDS`. An agent edit
 * therefore never joins a user session and a user edit never joins an agent's, because the
 * actors differ — that is the whole of it, and there is no special case for the mixed pair.
 *
 * An edit that changed nothing is refused and the history is returned unchanged, so the log
 * never carries an entry with no changes in it.
 */
export function appendToHistory(
  history: DeckHistory,
  append: DeckHistoryAppend,
): DeckHistory {
  const { entry, payloads, actor, newSessionId } = append;
  if (isEmptyDeckDiff(entry)) {
    return history;
  }

  const open = history.sessions.at(-1);
  const sessions =
    open && canJoinSession(open, actor, entry.at)
      ? [
          ...history.sessions.slice(0, -1),
          {
            ...open,
            ended_at: laterOf(open.ended_at, entry.at),
            edits: [...open.edits, entry],
          },
        ]
      : [
          ...history.sessions,
          {
            id: newSessionId,
            actor,
            started_at: entry.at,
            ended_at: entry.at,
            edits: [entry],
          },
        ];

  return { ...history, sessions, cards: { ...history.cards, ...payloads } };
}

/**
 * Bound the log, oldest first, at two independent depths.
 *
 * `sessionCap` bounds what can be read: whole sessions fall off the front. `payloadCap`
 * bounds what can be undone: only the newest that many edits keep their pooled card
 * payloads, and every pooled id no retained edit still references is garbage-collected.
 *
 * An edit surviving `sessionCap` but not `payloadCap` keeps its identity, names, counts,
 * time, actor and reason and loses only the payload. It stays readable and stops being
 * undoable. That is the design, not a defect — reading needs the names, and only replaying
 * needs the 3KB.
 */
export function pruneHistory(
  history: DeckHistory,
  sessionCap: number,
  payloadCap: number,
): DeckHistory {
  const sessions = sessionCap > 0 ? history.sessions.slice(-sessionCap) : [];
  const retainedEdits = sessions.flatMap((session) => session.edits);
  const pooledEdits = payloadCap > 0 ? retainedEdits.slice(-payloadCap) : [];
  const referenced = new Set(
    pooledEdits.flatMap((edit) => edit.cards.map((change) => change.scryfall_id)),
  );

  const cards: Record<string, CardSearchResult> = {};
  for (const [scryfallId, details] of Object.entries(history.cards)) {
    if (referenced.has(scryfallId)) {
      cards[scryfallId] = details;
    }
  }

  return { ...history, sessions, cards };
}

/**
 * Validate one stored history, falling back whole rather than in part.
 *
 * Takes a parsed value rather than a JSON string so the hook stays free to choose its
 * storage envelope. Card payloads are trusted once their container is the right shape, the
 * same way `parseStoredDeck` trusts a stored `details`: they were written by this
 * application, and re-validating a 3KB card on every load would cost more than it protects.
 */
export function parseDeckHistory(
  value: unknown,
  fallback: DeckHistory,
): DeckHistory {
  if (
    !isRecord(value) ||
    typeof value.deck_id !== "string" ||
    !Array.isArray(value.sessions) ||
    !value.sessions.every(isSession) ||
    !isRecord(value.cards)
  ) {
    return fallback;
  }
  return {
    deck_id: value.deck_id,
    sessions: value.sessions,
    cards: value.cards as Record<string, CardSearchResult>,
  };
}

function canJoinSession(
  session: DeckSession,
  actor: DeckHistoryActor,
  at: string,
): boolean {
  if (session.actor !== actor) {
    return false;
  }
  const gapSeconds = (Date.parse(at) - Date.parse(session.ended_at)) / 1000;
  return (
    Number.isFinite(gapSeconds) &&
    gapSeconds <= DECK_HISTORY_SESSION_WINDOW_SECONDS
  );
}

function summariseDeckDiff(
  cards: DeckCardChange[],
  name: DeckNameChange | undefined,
): string {
  let added = 0;
  let removed = 0;
  const parts: string[] = [];

  for (const change of cards) {
    const beforeQuantity = change.before?.quantity ?? 0;
    const afterQuantity = change.after?.quantity ?? 0;
    added += Math.max(0, afterQuantity - beforeQuantity);
    removed += Math.max(0, beforeQuantity - afterQuantity);
    if (change.before === null) {
      parts.push(`+${change.name}`);
    } else if (change.after === null) {
      parts.push(`−${change.name}`);
    } else if (afterQuantity !== beforeQuantity) {
      parts.push(`${change.name} ×${beforeQuantity} → ×${afterQuantity}`);
    } else {
      parts.push(`${change.name} moved`);
    }
  }

  if (name) {
    parts.push(`renamed to ${name.after}`);
  }

  const counts = [
    added > 0 ? `+${added}` : "",
    removed > 0 ? `−${removed}` : "",
  ].filter((part) => part.length > 0);
  return [counts.join(" / "), ...parts]
    .filter((part) => part.length > 0)
    .join(" · ");
}

/**
 * One entry per printing. `useDeck` finds and updates entries by `scryfall_id`, so a deck
 * holds at most one entry per printing; the first wins here to mirror what `find` would
 * have returned had that invariant ever been broken.
 */
function indexEntriesByPrinting(
  entries: DeckCardEntry[],
): Map<string, { entry: DeckCardEntry; index: number }> {
  const byPrinting = new Map<string, { entry: DeckCardEntry; index: number }>();
  entries.forEach((entry, index) => {
    if (!byPrinting.has(entry.card.scryfall_id)) {
      byPrinting.set(entry.card.scryfall_id, { entry, index });
    }
  });
  return byPrinting;
}

function unionKeys(
  first: Map<string, unknown>,
  second: Map<string, unknown>,
): string[] {
  return [...new Set([...first.keys(), ...second.keys()])];
}

function cardPlacement(entry: DeckCardEntry, index: number): DeckCardPlacement {
  return { quantity: entry.quantity, section: entry.section, index };
}

function withCardPlacement(
  entry: DeckCardEntry,
  placement: DeckCardPlacement,
): DeckCardEntry {
  return {
    ...entry,
    quantity: placement.quantity,
    section: placement.section,
  };
}

/** `index` is excluded on purpose; see `DeckCardPlacement`. */
function cardPlacementsMatch(
  before: DeckCardPlacement | null,
  after: DeckCardPlacement | null,
): boolean {
  if (before === null || after === null) {
    return before === after;
  }
  return (
    before.quantity === after.quantity && before.section === after.section
  );
}

function sortedByIndex<T extends { placement: { index: number } }>(
  values: T[],
): T[] {
  return [...values].sort((left, right) => left.placement.index - right.placement.index);
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) {
    return length;
  }
  return Math.min(Math.max(Math.trunc(index), 0), length);
}

/** A clock that jumped backwards must not make a session end before it started. */
function laterOf(left: string, right: string): string {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return right;
  }
  return rightTime >= leftTime ? right : left;
}

function isSession(value: unknown): value is DeckSession {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.actor === "user" || value.actor === "agent") &&
    typeof value.started_at === "string" &&
    typeof value.ended_at === "string" &&
    Array.isArray(value.edits) &&
    value.edits.every(isEditEntry)
  );
}

function isEditEntry(value: unknown): value is DeckEditEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.at === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.cards) &&
    value.cards.every(isCardChange)
  );
}

function isCardChange(value: unknown): value is DeckCardChange {
  return (
    isRecord(value) &&
    typeof value.scryfall_id === "string" &&
    typeof value.name === "string" &&
    (value.before === null || isRecord(value.before)) &&
    (value.after === null || isRecord(value.after))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
