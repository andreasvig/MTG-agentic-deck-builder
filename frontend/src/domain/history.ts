import type { CardSearchResult } from "./card";
import type { Deck, DeckCardEntry, DeckSection } from "./deck";
import { sectionLabel } from "./deck";

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
 * `cards[]` (quantity and section), `name` and `description`. It deliberately excludes `id`, `format` and
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

export interface DeckDescriptionChange {
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
  description?: DeckDescriptionChange;
}

/** One recorded edit: a diff plus who-when-why. */
export interface DeckEditEntry extends DeckDiff {
  id: string;
  /** ISO time the edit happened. Also what the session rule measures its gap against. */
  at: string;
  /** Agent edits carry the model's one-liner; user edits have none. */
  reason?: string;
}

/** One recorded edit with the session facts a reader needs, flattened out of its session. */
export interface DeckHistoryEntry {
  entry: DeckEditEntry;
  actor: DeckHistoryActor;
  sessionId: string;
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
  /**
   * The id of the newest edit the deck currently has applied, or `null` when the deck
   * stands before every edit in the log.
   *
   * This is what makes a forward step possible. Undo used to *pop* the log, which left
   * nothing to replay: the record of the edit was gone the moment it was reversed. Now the
   * log is the whole past and this is a position in it, so everything after the cursor is
   * an edit that happened, was stepped back past, and can be stepped into again.
   *
   * A log written before this field existed has no cursor. `parseDeckHistory` reads absent
   * as the newest edit rather than as `null`, because those decks have every recorded edit
   * applied — reading it as `null` would tell the user their whole deck is undone.
   */
  at: string | null;
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
export type DeckDiffApplyResult =
  { ok: true; deck: Deck } | DeckDiffApplyFailure;

/**
 * Where the deck should stand afterwards.
 *
 * One step in either direction, or a named edit — which is how the history panel moves the
 * deck several edits at once. `{ editId: null }` is the state before the first recorded
 * edit, which is reachable and is not the same as "no history".
 */
export type DeckHistoryDestination =
  "back" | "forward" | { editId: string | null };

/**
 * A journey the deck can actually make: the deck it lands on, and the cursor to record.
 *
 * `steps` and `direction` describe what was travelled, so the caller can say so without
 * counting anything a second time.
 */
export interface DeckHistoryTravel {
  ok: true;
  deck: Deck;
  at: string | null;
  steps: number;
  direction: "back" | "forward";
}

/**
 * What travelling would do: a journey, a refusal, or `null` for nowhere to go.
 *
 * `null` is not a failure — it is the deck already standing where it was asked to stand,
 * which is what a disabled Back button at the start of history means. It is distinct from a
 * refusal, which is an edit that cannot be replayed and must be announced.
 */
export type DeckHistoryTravelResult =
  DeckHistoryTravel | DeckDiffApplyFailure | null;

export function createDeckHistory(deckId: string): DeckHistory {
  return { deck_id: deckId, sessions: [], cards: {}, at: null };
}

/**
 * Every recorded edit, oldest first, each still carrying who made it.
 *
 * Travel is along one line of edits; sessions are how that line is *read*. Keeping the two
 * apart is what lets a jump cross a session boundary without knowing there was one — but the
 * actor sits on the session, so it is carried down here rather than left behind. Anything
 * rendering an edit needs it, and the alternative is inferring the actor from something else
 * on the entry: a reason is present on every agent edit *so far*, which makes it a proxy that
 * works until a user edit is given one.
 */
export function historyEntries(history: DeckHistory): DeckHistoryEntry[] {
  return history.sessions.flatMap((session) =>
    session.edits.map((entry) => ({
      entry,
      actor: session.actor,
      sessionId: session.id,
    })),
  );
}

/** The same line of edits without the reading apparatus, which is what travel walks. */
export function historyEdits(history: DeckHistory): DeckEditEntry[] {
  return historyEntries(history).map((held) => held.entry);
}

/**
 * How many of the recorded edits the deck currently has applied.
 *
 * The cursor names an edit and this counts to it, so it is the *number of applied edits*
 * and therefore also the index of the first undone one. `null` is zero applied.
 *
 * A cursor naming an edit the log no longer holds also counts zero. That can only happen if
 * pruning dropped the session the cursor was in, and pruning drops the oldest — so every
 * retained edit is newer than the cursor and none of them is applied. Reading it as the tip
 * instead would offer to step back through edits the deck never had.
 */
export function appliedEditCount(history: DeckHistory): number {
  if (history.at === null) {
    return 0;
  }
  const index = historyEdits(history).findIndex(
    (edit) => edit.id === history.at,
  );
  return index < 0 ? 0 : index + 1;
}

/** The edits stepped back past: recorded, not applied, and replayable forward again. */
export function undoneEdits(history: DeckHistory): DeckEditEntry[] {
  return historyEdits(history).slice(appliedEditCount(history));
}

/**
 * Work out what travelling to a destination would do to the deck.
 *
 * Every movement goes through here — one step back, one step forward, and a jump of any
 * length from the history panel — so a jump cannot come to disagree with the steps it is
 * made of. It is also what `canGoBack` and `canGoForward` are computed from, which is why
 * it plans rather than acts: a button that offered a step the reducer then refused would be
 * lying, and the only way to know is to try the replay.
 *
 * Refused **whole**. A jump of six edits that fails on the fourth leaves the deck exactly
 * where it was, because landing halfway would put the deck in a state no recorded edit
 * describes and the cursor would then name the wrong one.
 */
export function planHistoryTravel(
  deck: Deck,
  history: DeckHistory,
  destination: DeckHistoryDestination,
): DeckHistoryTravelResult {
  const edits = historyEdits(history);
  const from = appliedEditCount(history);
  const to = destinationIndex(edits, from, destination);
  if (to === null || to === from) {
    return null;
  }

  // Backwards, the entries are replayed inverted and newest first; forwards, as recorded and
  // oldest first. Both walk the same list, which is what keeps a six-step jump identical to
  // six single steps.
  const backwards = to < from;
  const travelled = backwards
    ? edits.slice(to, from).reverse()
    : edits.slice(from, to);

  let current = deck;
  for (const entry of travelled) {
    const applied = applyDeckDiff(
      current,
      backwards ? invertDeckDiff(entry) : entry,
      history.cards,
    );
    if (!applied.ok) {
      return applied;
    }
    current = applied.deck;
  }

  return {
    ok: true,
    deck: current,
    at: to === 0 ? null : (edits[to - 1]?.id ?? null),
    steps: travelled.length,
    direction: backwards ? "back" : "forward",
  };
}

/** The number of applied edits a destination asks for, or `null` when it names none. */
function destinationIndex(
  edits: DeckEditEntry[],
  from: number,
  destination: DeckHistoryDestination,
): number | null {
  if (destination === "back") {
    return from > 0 ? from - 1 : null;
  }
  if (destination === "forward") {
    return from < edits.length ? from + 1 : null;
  }
  if (destination.editId === null) {
    return 0;
  }
  const index = edits.findIndex((edit) => edit.id === destination.editId);
  return index < 0 ? null : index + 1;
}

/**
 * Compare two states of one deck and describe the difference.
 *
 * Complete by construction: it walks the union of both card lists and compares the deck
 * name and description, so a change no call site remembered to declare is still recorded. A card whose
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
  const description =
    before.description === after.description
      ? undefined
      : { before: before.description, after: after.description };

  return {
    diff: {
      summary: summariseDeckDiff(cards, name, description),
      cards,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    },
    payloads,
  };
}

/** True when a derivation found nothing. `appendToHistory` refuses these. */
export function isEmptyDeckDiff(diff: DeckDiff): boolean {
  return (
    diff.cards.length === 0 &&
    diff.name === undefined &&
    diff.description === undefined
  );
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
  const description = entry.description
    ? { before: entry.description.after, after: entry.description.before }
    : undefined;

  return {
    ...entry,
    cards,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    summary: summariseDeckDiff(cards, name, description),
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
      description: diff.description ? diff.description.after : deck.description,
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
 *
 * An edit made while the cursor is behind the tip **discards everything after it** first.
 * Those edits described a future the deck has stepped out of, and once it has been changed
 * from here they describe nothing that can be replayed: the deck they applied to no longer
 * exists. Dropping them is also what keeps this function's own invariant — the cursor is the
 * newest edit in the log — true by construction, which is what every other reader relies on.
 */
export function appendToHistory(
  history: DeckHistory,
  append: DeckHistoryAppend,
): DeckHistory {
  const { entry, payloads, actor, newSessionId } = append;
  if (isEmptyDeckDiff(entry)) {
    return history;
  }

  const applied = truncateUndoneEdits(history);
  const open = applied.sessions.at(-1);
  const sessions =
    open && canJoinSession(open, actor, entry.at)
      ? [
          ...applied.sessions.slice(0, -1),
          {
            ...open,
            ended_at: laterOf(open.ended_at, entry.at),
            edits: [...open.edits, entry],
          },
        ]
      : [
          ...applied.sessions,
          {
            id: newSessionId,
            actor,
            started_at: entry.at,
            ended_at: entry.at,
            edits: [entry],
          },
        ];

  return {
    ...applied,
    sessions,
    cards: { ...applied.cards, ...payloads },
    at: entry.id,
  };
}

/**
 * Drop every edit after the cursor, so the log is exactly what the deck has applied.
 *
 * A session emptied by this is dropped with its edits: a stretch of editing with nothing
 * left in it reads as a gap in the record rather than as a session. Pruning is left to
 * `pruneHistory`, which the caller runs anyway — this returns the history it was given when
 * there is nothing to drop, so `appendToHistory` can tell the ordinary case cheaply.
 */
export function truncateUndoneEdits(history: DeckHistory): DeckHistory {
  const applied = appliedEditCount(history);
  if (applied === historyEdits(history).length) {
    return history;
  }

  let remaining = applied;
  const sessions: DeckSession[] = [];
  for (const session of history.sessions) {
    if (remaining <= 0) {
      break;
    }
    const edits = session.edits.slice(0, remaining);
    remaining -= edits.length;
    sessions.push({
      ...session,
      ended_at: edits[edits.length - 1]?.at ?? session.ended_at,
      edits,
    });
  }
  return { ...history, sessions };
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
    pooledEdits.flatMap((edit) =>
      edit.cards.map((change) => change.scryfall_id),
    ),
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
  const sessions = value.sessions as DeckSession[];
  return {
    deck_id: value.deck_id,
    sessions,
    cards: value.cards as Record<string, CardSearchResult>,
    // Absent is not `null`. A log written before the cursor existed has every recorded edit
    // applied, so absent reads as the newest edit; `null` is the deck deliberately stepped
    // back before all of them, and a stored `null` has to survive the round trip or a reload
    // would silently reapply everything the user stepped out of.
    at:
      value.at === null
        ? null
        : typeof value.at === "string"
          ? value.at
          : (sessions.at(-1)?.edits.at(-1)?.id ?? null),
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

/**
 * One card change in words, in the one place that words one.
 *
 * Both the summary stored on an entry and the history panel that renders the entry read
 * this, so a diff cannot be described two ways — the stored line and the line on screen are
 * the same sentence about the same change.
 */
export function describeDeckCardChange(change: DeckCardChange): string {
  const before = change.before?.quantity ?? 0;
  const after = change.after?.quantity ?? 0;
  if (change.before === null) {
    return `+${change.name}`;
  }
  if (change.after === null) {
    return `−${change.name}`;
  }
  if (after !== before) {
    return `${change.name} ×${before} → ×${after}`;
  }
  // Where it went, not just that it went. A derivation records a card only when something
  // about it changed, so an unchanged count means the section changed — and "moved" alone
  // left the one axis a move can have unsaid. `read_history` names the destination for the
  // agent for the same reason.
  return change.after
    ? `${change.name} → ${sectionLabel(change.after.section)}`
    : `${change.name} moved`;
}

function summariseDeckDiff(
  cards: DeckCardChange[],
  name: DeckNameChange | undefined,
  description: DeckDescriptionChange | undefined,
): string {
  let added = 0;
  let removed = 0;
  const parts: string[] = [];

  for (const change of cards) {
    const beforeQuantity = change.before?.quantity ?? 0;
    const afterQuantity = change.after?.quantity ?? 0;
    added += Math.max(0, afterQuantity - beforeQuantity);
    removed += Math.max(0, beforeQuantity - afterQuantity);
    parts.push(describeDeckCardChange(change));
  }

  if (name) {
    parts.push(`renamed to ${name.after}`);
  }
  if (description) {
    parts.push(
      description.after
        ? "updated deck description"
        : "cleared deck description",
    );
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
  return before.quantity === after.quantity && before.section === after.section;
}

function sortedByIndex<T extends { placement: { index: number } }>(
  values: T[],
): T[] {
  return [...values].sort(
    (left, right) => left.placement.index - right.placement.index,
  );
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
