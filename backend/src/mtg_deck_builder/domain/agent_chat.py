"""Strict contracts for the conversational deck agent."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from mtg_deck_builder.domain.cards import CardSearchResult

DeckAgentRole = Literal["user", "assistant", "tool"]
"""Who said one transcript message.

`tool` is the provider's own role for a tool result, and it is here because an
interrupted turn is replayed: the calls it made and the results it read are handed
back on the next turn as `assistant.tool_calls` plus one `tool` message each, which
is the only shape the provider accepts them in.
"""

DeckAgentActor = Literal["user", "agent"]
"""Who made one edit. The history is only worth an actor if both appear in it."""

MAX_MESSAGE_CHARS = 8_000
"""How much prose one transcript message may carry.

Bounds what a person types and what the model writes back, stripped and non-blank, as
`DeckAgentMessage.prose_stays_inside_the_prose_bound` applies it. A `tool` message is
not prose and is bounded by `MAX_TOOL_PAYLOAD_CHARS` instead.
"""

ShortLabel = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
]

DeckName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=80),
]
DeckDescription = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=2_000),
]

MAX_TOOL_PAYLOAD_CHARS = 24_000
"""How much of one tool call's arguments or result may travel, per payload.

Generous enough for a five-hundred-card `read_deck` listing, bounded so a reply
cannot grow without limit. Longer text is truncated with a visible marker rather
than silently cut, because a payload that lies about being complete is worse than
no payload — and this one is read back by the model on the next turn, not only by a
person.
"""

MAX_REPLAY_CHARS = 60_000
"""How much payload text one reply may carry across every tool call in the turn.

`MAX_TOOL_PAYLOAD_CHARS` bounds one payload and this bounds their sum, because a
fifteen-round turn otherwise multiplies that cap by thirty. The turn sheds oldest
call first and drops a `result` before its `arguments_json`: the newest lookup is the
one a replay is most likely to continue from, and a call that keeps its arguments and
loses its result is still replayable as framing — "interrupted after `read_deck()`" —
where a call dropped entirely is not.

Deliberately larger than two per-payload caps, so an ordinary two-tool turn is never
shed at all.
"""

ToolPayloadText = Annotated[str, StringConstraints(max_length=MAX_TOOL_PAYLOAD_CHARS)]
"""One tool call's arguments or result, going out in a reply or coming back in a replay.

Neither stripped nor required to be non-empty, because it is not prose: it is the text
the tool produced, and a replay has to hand the model back exactly what it read. The
same type on both directions on purpose — a payload the reply was allowed to carry that
the request then refuses is a bound the whole turn fails on rather than degrades to.
"""

ToolCallId = Annotated[str, StringConstraints(min_length=1, max_length=200)]
"""The provider's own identifier for one tool call.

Deliberately not `ShortLabel`: an id is matched, not read, so it must travel byte for
byte and must not be stripped of whitespace on the way through.
"""

DeckRevision = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=100),
]
"""When the deck a call read last changed, as the browser records it.

Compared, never parsed: the only question asked of it is whether it equals the
`updated_at` of the deck posted with this turn.
"""

MAX_REPLAY_CALLS = 50
"""How many tool calls one replayed assistant message may carry.

An interrupted turn's whole run of calls arrives as one message, and
`agent.tools.max_iterations` bounds that run at fifteen rounds, so this is generous
for the shape it has to hold and still bounds the message.
"""

DeckSection = Literal["command_zone", "mainboard"]

DeckEditZone = Literal["commander", "deck"]
"""Where an `edit_deck` change puts a card, in the words the model reads.

The only placement a deck has left. Custom groups were removed — the board groups by
card type, which is derived from the card and cannot be edited — so the one thing a
change can say about placement is whether the card is the commander.

Deliberately not `DeckSection`: `command_zone`/`mainboard` is the vocabulary of the
stored deck, and `read_deck` prints the heading `Commander`, so these are the words the
model has actually seen. `_section_for_zone` is the single place the two meet.
"""

CardToken = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
]
"""How the model names one card: its exact printed name, or a `read_deck` short id.

One type for every tool that takes a card, so `see_cards`, `search_cards` and
`edit_deck` cannot come to disagree about what naming a card means — they all
resolve a token through the same resolver against the same catalog.
"""

MAX_EDIT_CHANGES = 100
"""How many cards one `edit_deck` call may change.

A hundred is a whole deck replaced at once, which is the largest edit that is not a
mistake, and it bounds both the emitted event and the history entry it becomes.
"""

MAX_HISTORY_EDIT_CARDS = 250
"""How many card changes one *recorded* edit may carry.

Deliberately looser than `MAX_EDIT_CHANGES`, which bounds what the agent may ask for.
The browser records what actually happened, and replacing a whole deck in one step is
a hundred cards out and a hundred in — a bound of a hundred here would fail the whole
chat turn over a history entry the user made legitimately.
"""

MAX_HISTORY_SESSIONS = 50
MAX_HISTORY_EDITS = 500
"""How much recorded history one turn may post.

Both bounds are needed: fifty sessions of ten edits each is a request body worth
carrying, and fifty sessions of five hundred edits each is not. The browser prunes
oldest-first to stay inside them, keeping identity, counts and reasons for what it
drops the payload of.
"""

CardDetail = Literal[
    "rules",
    "prices",
    "tags",
    "similar",
    "inclusion",
    "themes",
    "legality",
]
"""What `see_cards` may report per card.

Every value is backed by data this application already holds locally or fetches
on demand; there is deliberately no value the tool would have to invent.
"""

DeckExtraInfo = Literal["mana", "price"]
"""What `read_deck` may add to a bare deck listing, per card and in a summary.

Each value is one figure carried down the whole listing and totalled at the bottom,
not a separate report: `mana` puts every card's cost on its own line and the curve
under the deck, `price` puts every card's estimate on its line and a total under each
heading. Both are off by default, because the listing exists to be the cheap tool.
"""


class DeckAgentModel(BaseModel):
    """Strict base model for the deck-agent chat contract."""

    model_config = ConfigDict(extra="forbid")


class DeckAgentReplayCall(DeckAgentModel):
    """One tool call being handed back to the model, exactly as it was made.

    The turn that made it was interrupted, so no answer was ever written from it. What
    the model gets back is the call and its result rather than a summary of either,
    because `search_web` and `read_page` are paid and non-deterministic and re-running
    one is not the same as replaying it.
    """

    id: ToolCallId
    name: ShortLabel
    arguments_json: ToolPayloadText
    # The deck's `updated_at` when this call ran, for the deck-dependent tools only.
    # Absent means the browser could not say, which is not the same as unchanged — see
    # `_DECK_DEPENDENT_TOOLS` in `deck_agent_tools.py`.
    deck_revision: DeckRevision | None = None


class DeckAgentMessage(DeckAgentModel):
    """One turn of the conversation, in the order it was said."""

    role: DeckAgentRole
    # Optional now: an assistant message that only carries tool calls has no prose,
    # which is the provider's own shape for one.
    #
    # Typed to `ToolPayloadText` because one field carries two different things: prose
    # from a person or the model, and a replayed tool result. Which bound applies is
    # decided by the role below — prose keeps `MAX_MESSAGE_CHARS`, while a tool result
    # may be as long as the reply was allowed to carry and is neither stripped nor
    # required to say anything, because the model has to read back exactly what it read
    # the first time. A `read_deck` listing runs to three times the prose bound, so
    # sharing that bound would have made the largest decks the ones a replay 422s on.
    content: ToolPayloadText | None = None
    tool_calls: Annotated[
        list[DeckAgentReplayCall],
        Field(max_length=MAX_REPLAY_CALLS),
    ] = Field(default_factory=list)
    # Which call this message answers. Only a `tool` message has one, and it must.
    tool_call_id: ToolCallId | None = None

    @model_validator(mode="after")
    def a_message_must_say_something(self) -> "DeckAgentMessage":
        if self.content is None and not self.tool_calls:
            raise ValueError("a chat message must carry content, tool calls, or both")
        return self

    @model_validator(mode="after")
    def prose_stays_inside_the_prose_bound(self) -> "DeckAgentMessage":
        """Hold everything that is not a tool result to `MessageText`'s own rules.

        The field is typed to the payload bound so a replayed result fits, which would
        otherwise let a user message carry three times the prose it used to. So the
        prose bound is applied here instead, per role: stripped, non-blank, and 8,000
        characters at the most, exactly as before.
        """

        if self.role == "tool" or self.content is None:
            return self
        text = self.content.strip()
        if not text:
            raise ValueError("a message must carry more than whitespace")
        if len(text) > MAX_MESSAGE_CHARS:
            raise ValueError(f"a message must be at most {MAX_MESSAGE_CHARS} characters")
        self.content = text
        return self

    @model_validator(mode="after")
    def each_field_belongs_to_one_role(self) -> "DeckAgentMessage":
        """Keep the two new fields on the roles the provider allows them on.

        A `tool_calls` list on a user message and a `tool_call_id` on an assistant one
        are both rejected by the provider rather than ignored, so they are rejected
        here, where the client is told which field it put where.
        """

        if self.tool_calls and self.role != "assistant":
            raise ValueError("only an assistant message may carry tool calls")
        if self.role == "tool" and self.tool_call_id is None:
            raise ValueError("a tool message must name the call it answers")
        if self.role != "tool" and self.tool_call_id is not None:
            raise ValueError("only a tool message may name a call it answers")
        return self


class DeckAgentDeckCard(DeckAgentModel):
    """One deck entry, identified by printing.

    Only the identity and placement travel: the name, type line and everything
    else is resolved from the local catalog, so the agent cannot be told the deck
    contains a card that the catalog disagrees about.
    """

    scryfall_id: UUID
    quantity: Annotated[int, Field(ge=1, le=99)]
    section: DeckSection


class DeckAgentDeckSnapshot(DeckAgentModel):
    """The open deck as the browser holds it, at the moment of one chat turn.

    The backend keeps no deck, so this is posted with each turn exactly as the
    transcript is. It is a snapshot rather than a subscription: the agent sees the
    deck as it was when the question was asked.
    """

    name: DeckName
    description: DeckDescription = ""
    cards: Annotated[list[DeckAgentDeckCard], Field(max_length=500)] = Field(default_factory=list)
    # When this deck last changed, so a replayed call's `deck_revision` can be compared
    # against it. Optional because an older client posts no revision at all, and a deck
    # whose revision is unknown is one whose replayed reads cannot be trusted — which
    # the comparison already says, since absent differs from anything.
    updated_at: DeckRevision | None = None


class DeckEditChange(DeckAgentModel):
    """One card the model wants the deck to hold differently.

    Declarative on purpose: it states the copy count it wants *afterwards* rather
    than an operation to perform. Add is `quantity: 1`, cut is `quantity: 0`, a move
    is the same quantity with a new zone, and a swap is two of these. That collapses
    the four verbs a discriminated union would need — along with their conditionally
    required fields, which is the shape a model malforms — and it makes the call
    idempotent, which matters because the edit applies itself and a retry must not
    double-add.

    `quantity` is required and `0` is meaningful, so absent is impossible. That is
    deliberate: coercing a missing quantity to zero would delete a card.
    """

    card: CardToken
    quantity: Annotated[int, Field(ge=0, le=99)]
    # Where the card should sit. Absent leaves placement alone, which is what an
    # ordinary add or cut wants; naming a zone is how a commander is set or unset.
    # Absent must not be read as `deck` anywhere downstream: the same field carries a
    # plain quantity change on a card that happens to be the commander.
    zone: DeckEditZone | None = None


class EditDeckArguments(DeckAgentModel):
    """One edit to the open deck: what it should hold, and why."""

    changes: Annotated[
        list[DeckEditChange],
        Field(min_length=1, max_length=MAX_EDIT_CHANGES),
    ]
    # Per call rather than per card, because one intent usually covers a whole swap.
    # It is the field that makes the history worth reading a week later.
    reason: ShortLabel


class EditDeckTextArguments(DeckAgentModel):
    """Full replacements for the deck's name and intent, applied as one edit."""

    name: DeckName | None = None
    description: DeckDescription | None = None
    reason: ShortLabel

    @model_validator(mode="after")
    def at_least_one_text_field_changes(self) -> "EditDeckTextArguments":
        if self.name is None and self.description is None:
            raise ValueError("name or description is required")
        return self


class ReadHistoryArguments(DeckAgentModel):
    """How much of the deck's recorded past to read, newest first."""

    # Absent means the configured default, exactly as `search_cards.max_results`
    # does: the number lives in `config.yaml` beside the tool description that
    # advertises it, so the two cannot disagree.
    limit: Annotated[int, Field(ge=1, le=MAX_HISTORY_SESSIONS)] | None = None


class DeckAgentDeckPlacement(DeckAgentModel):
    """Where one card sat, and how many copies, at one moment."""

    quantity: Annotated[int, Field(ge=0, le=99)]
    section: DeckSection


class DeckAgentDeckHistoryChange(DeckAgentModel):
    """What one recorded edit did to one card.

    The name travels denormalised so history reads without the catalog: an edit made
    a month ago must still be readable after a card has been renamed or a printing
    has left the local data.
    """

    name: ShortLabel
    # `None` on the left means the card was not in the deck; `None` on the right
    # means it was removed. Both absent would record nothing at all.
    before: DeckAgentDeckPlacement | None = None
    after: DeckAgentDeckPlacement | None = None

    @model_validator(mode="after")
    def a_change_must_change_something(self) -> "DeckAgentDeckHistoryChange":
        if self.before is None and self.after is None:
            raise ValueError("a history change must carry a before, an after, or both")
        return self


class DeckAgentDeckHistoryEdit(DeckAgentModel):
    """One recorded edit: when it happened, why, and what it moved."""

    at: datetime
    # Only an agent edit has one — a card dragged across the board states no intent.
    reason: ShortLabel | None = None
    # Allowed to be empty rather than required: the browser also records deck renames,
    # and an edit that carried neither a card change nor a reason must not fail a whole
    # chat turn over a field this tool does not read.
    cards: Annotated[
        list[DeckAgentDeckHistoryChange],
        Field(max_length=MAX_HISTORY_EDIT_CARDS),
    ] = Field(default_factory=list)
    # Whether the user has stepped back past this edit. It happened, it is recorded, and
    # the deck does not currently have it. Posted rather than filtered out because "put
    # that back" is the question an undone edit answers; defaults to false so a client
    # that does not track a position posts an ordinary applied history.
    undone: bool = False


class DeckAgentDeckSession(DeckAgentModel):
    """A stretch of editing by one actor, as the browser grouped it.

    `actor` sits on the session rather than on the edit, so an agent edit can never
    join a user's session and the question "who did this" has one answer per block.
    """

    actor: DeckAgentActor
    started_at: datetime
    ended_at: datetime
    edits: Annotated[
        list[DeckAgentDeckHistoryEdit],
        Field(max_length=MAX_HISTORY_EDITS),
    ] = Field(default_factory=list)


class DeckAgentDeckHistory(DeckAgentModel):
    """The open deck's recorded past, oldest session first.

    Posted with the turn exactly as the deck snapshot is, and for the same reason:
    the backend holds no deck and therefore no history of one. It costs request body
    on every turn and model context only when `read_history` runs.
    """

    sessions: Annotated[
        list[DeckAgentDeckSession],
        Field(max_length=MAX_HISTORY_SESSIONS),
    ] = Field(default_factory=list)

    @model_validator(mode="after")
    def edits_must_stay_inside_the_budget(self) -> "DeckAgentDeckHistory":
        total = sum(len(session.edits) for session in self.sessions)
        if total > MAX_HISTORY_EDITS:
            raise ValueError(f"history must carry at most {MAX_HISTORY_EDITS} edits in total")
        return self


class DeckAgentChatRequest(DeckAgentModel):
    """One chat turn, carrying the whole transcript the browser holds.

    The agent keeps no server-side session: this list *is* its memory, which is why
    the newest message has to be the user's. `agent.max_history_messages` then
    decides how much of it reaches the model.
    """

    messages: Annotated[list[DeckAgentMessage], Field(min_length=1, max_length=1_000)]
    # Optional so a client that has no deck open — or an older one — still chats.
    # The tools report the absence rather than pretending the deck is empty.
    deck: DeckAgentDeckSnapshot | None = None
    # The same deal as the deck: optional, because a client that records no history —
    # or an older one — still chats. `read_history` reports which of the two it is,
    # since "no history was posted" and "this deck has never been edited" send the
    # agent somewhere different.
    history: DeckAgentDeckHistory | None = None
    # Whether the user has debug mode on, which the browser uses to decide how much of
    # a turn it shows. It no longer decides what the reply carries: every turn returns
    # each call's arguments and result, because any turn may be the one the user
    # interrupts and the next turn replays. Read by nothing on this side.
    debug: bool = False

    @model_validator(mode="after")
    def transcript_must_end_with_the_user(self) -> "DeckAgentChatRequest":
        if self.messages[-1].role != "user":
            raise ValueError("the last chat message must be the user's")
        return self

    @model_validator(mode="after")
    def every_tool_call_is_paired_with_its_answer(self) -> "DeckAgentChatRequest":
        """Reject a transcript the provider would reject, naming the call that broke it.

        This mirrors the provider's own rule: an `assistant.tool_calls` entry with no
        answering `tool` message, or a `tool` message answering nothing, fails the whole
        completion. An unanswered call is exactly what an interrupted turn produces, so
        this is where a client's mistake will land — and a 422 naming the id is a far
        better answer than a 502 from the model host.

        Ids are matched, not counted, and the match is one to one. A transcript with one
        call and one answer that do not refer to each other is the same error as a
        missing answer, and two answers to one call is the same error again — the
        provider refuses all three, and counting would notice none of them.
        """

        calls: dict[str, int] = {}
        answered: set[str] = set()
        for index, message in enumerate(self.messages):
            if message.role == "tool":
                # `tool_call_id` is required on a tool message by the message's own
                # validator, so absent cannot reach here.
                identifier = message.tool_call_id or ""
                if identifier not in calls:
                    raise ValueError(
                        f"the tool message at position {index} answers call "
                        f"{identifier!r}, which no earlier message asked for"
                    )
                if identifier in answered:
                    raise ValueError(
                        f"tool call {identifier!r} is answered twice, and the provider "
                        "accepts one answer per call"
                    )
                answered.add(identifier)
            for call in message.tool_calls:
                if call.id in calls:
                    raise ValueError(
                        f"tool call {call.id!r} is asked for twice, so its answer "
                        "cannot be matched to either"
                    )
                calls[call.id] = index
        unanswered = [identifier for identifier in calls if identifier not in answered]
        if unanswered:
            raise ValueError(f"tool call {unanswered[0]!r} has no answering tool message")
        return self


class DeckAgentToolCall(DeckAgentModel):
    """One tool the agent ran while answering, as the chat displays it.

    `signature` is what the user sees — `read_deck()` — so the interface never has
    to reconstruct a call from its arguments and get it subtly wrong.
    """

    name: ShortLabel
    signature: ShortLabel
    ok: bool = True
    # Why the call failed, short enough to sit on one line in the transcript.
    detail: ShortLabel | None = None
    # The provider's own id for this call, so a later turn can hand the pair back as
    # `assistant.tool_calls` plus a `tool` message. `None` only for a call the provider
    # gave no id.
    id: ToolCallId | None = None
    # What the model asked for, as JSON text, and the exact result it read back. On
    # every turn, not only one that asked for `debug`: whichever turn the user
    # interrupts is replayed on the next one, and which turn that will be is not
    # knowable in advance.
    #
    # Absent means the payload was shed to fit `MAX_REPLAY_CHARS`, not that the call had
    # no arguments or returned nothing. A call that lost its result is still replayable
    # as framing.
    arguments_json: ToolPayloadText | None = None
    result: ToolPayloadText | None = None


class DeckAgentCardLink(DeckAgentModel):
    """One card the answer named, resolved to something the interface can open.

    The agent writes card names in braces and the backend resolves them here, against
    the same catalog `see_cards` reads. Resolving server-side is what lets the chat
    open the card the user is actually looking at rather than a name that merely looks
    like one — and a brace the catalog does not recognise simply produces no link.
    """

    name: ShortLabel
    oracle_id: UUID


class DeckAgentChatReply(DeckAgentModel):
    """The agent's answer to one chat turn."""

    message: DeckAgentMessage
    model: str
    replayed_message_count: Annotated[int, Field(ge=1)]
    # What this whole turn cost in USD, summed over every completion it took —
    # a turn that used tools pays for more than one. `None` means no figure came
    # back at all, so a running total must not read it as free.
    cost_usd: Annotated[float, Field(ge=0)] | None = None
    # How many completions in this turn reported no price. A turn that is part
    # priced would otherwise total up silently low.
    unpriced_call_count: Annotated[int, Field(ge=0)] = 0
    tool_calls: list[DeckAgentToolCall] = Field(default_factory=list)
    # Every card name the answer wrapped in braces that the catalog recognised, so
    # the chat can make it hoverable and openable without guessing what is a card.
    card_links: list[DeckAgentCardLink] = Field(default_factory=list)


class DeckAgentTextEvent(DeckAgentModel):
    """A piece of the answer as the model writes it.

    Text from a round that then calls tools is preamble rather than the answer, so
    the interface supersedes it when the next tool event arrives. What streams
    therefore converges on exactly the message the `done` event commits.
    """

    type: Literal["text"] = "text"
    content: str


class DeckAgentToolEvent(DeckAgentModel):
    """One tool call, sent the moment it finishes rather than at the end."""

    type: Literal["tool"] = "tool"
    call: DeckAgentToolCall


class DeckAgentDeckEditChange(DeckAgentModel):
    """One card change, resolved against the deck the browser posted.

    This is the applied form of a `DeckEditChange`: the token is now a printing, the
    count the deck held is stated beside the count it should hold, and a card being
    added arrives with the catalog entry the browser could not have built. Only
    changes that actually change something are here — a `quantity` the deck already
    holds is dropped before the edit is emitted, so a retried call cannot double-add.
    """

    scryfall_id: UUID
    name: ShortLabel
    # The count the deck should hold afterwards, and the count it held when the turn
    # started. `quantity: 0` removes the card.
    quantity: Annotated[int, Field(ge=0, le=99)]
    previous_quantity: Annotated[int, Field(ge=0, le=99)]
    # The browser's own vocabulary rather than the model's `zone`, because this is read
    # by code and not by a model. Absent leaves the card where it is.
    section: DeckSection | None = None
    # Present exactly when this change adds copies, because `addCard` needs the whole
    # card — its colours and type line are what the identity and command-zone
    # validators read — and the browser has never seen a card it does not hold.
    card: CardSearchResult | None = None

    @model_validator(mode="after")
    def an_added_card_must_carry_its_payload(self) -> "DeckAgentDeckEditChange":
        if self.quantity > self.previous_quantity and self.card is None:
            raise ValueError("a change that adds copies must carry the card it adds")
        return self


class DeckAgentDeckEdit(DeckAgentModel):
    """An edit the agent made, resolved and ready for the browser to apply.

    The backend holds no deck, so this is the whole of what `edit_deck` produces: it
    computed the change against the posted snapshot and the browser applies it as one
    undo step. The same shape `card_links` already uses — the backend resolves, the
    frontend acts.
    """

    deck_name: ShortLabel
    reason: ShortLabel
    changes: Annotated[
        list[DeckAgentDeckEditChange],
        Field(min_length=1, max_length=MAX_EDIT_CHANGES),
    ]


class DeckAgentDeckEditEvent(DeckAgentModel):
    """An edit the agent just made, sent the moment the tool finished.

    Nothing has changed in the browser until it acts on this, which is why the tool
    result the model reads and this event have to travel together.
    """

    type: Literal["deck_edit"] = "deck_edit"
    edit: DeckAgentDeckEdit


class DeckAgentDeckTextEdit(DeckAgentModel):
    """A name/description replacement resolved against the posted deck."""

    deck_name: DeckName
    reason: ShortLabel
    name: DeckName | None = None
    description: DeckDescription | None = None


class DeckAgentDeckTextEditEvent(DeckAgentModel):
    """A text edit for the browser to apply to the turn's deck."""

    type: Literal["deck_text_edit"] = "deck_text_edit"
    edit: DeckAgentDeckTextEdit


class DeckAgentDoneEvent(DeckAgentModel):
    """The finished turn, carrying the same reply the plain JSON route returns."""

    type: Literal["done"] = "done"
    reply: DeckAgentChatReply


class DeckAgentErrorEvent(DeckAgentModel):
    """A failure that happened after the response had already begun.

    Once a stream is open its status code is spent, so an error has to travel as an
    event. The message is the same text the JSON route would have returned.
    """

    type: Literal["error"] = "error"
    code: str
    message: str


DeckAgentStreamEvent = (
    DeckAgentTextEvent
    | DeckAgentToolEvent
    | DeckAgentDeckEditEvent
    | DeckAgentDeckTextEditEvent
    | DeckAgentDoneEvent
    | DeckAgentErrorEvent
)
