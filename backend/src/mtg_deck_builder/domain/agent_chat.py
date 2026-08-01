"""Strict contracts for the conversational deck agent."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

DeckAgentRole = Literal["user", "assistant"]

MessageText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=8_000),
]

ShortLabel = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
]

MAX_TOOL_PAYLOAD_CHARS = 24_000
"""How much of one tool call's arguments or result a debug turn may carry back.

Generous enough for a five-hundred-card `read_deck` listing, bounded so a reply
cannot grow without limit. Longer text is truncated with a visible marker rather
than silently cut, because a diagnostic that lies about being complete is worse
than no diagnostic.
"""

ToolPayloadText = Annotated[str, StringConstraints(max_length=MAX_TOOL_PAYLOAD_CHARS)]

DeckSection = Literal["command_zone", "mainboard"]

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


class DeckAgentModel(BaseModel):
    """Strict base model for the deck-agent chat contract."""

    model_config = ConfigDict(extra="forbid")


class DeckAgentMessage(DeckAgentModel):
    """One turn of the conversation, in the order it was said."""

    role: DeckAgentRole
    content: MessageText


class DeckAgentDeckCard(DeckAgentModel):
    """One deck entry, identified by printing.

    Only the identity and placement travel: the name, type line and everything
    else is resolved from the local catalog, so the agent cannot be told the deck
    contains a card that the catalog disagrees about.
    """

    scryfall_id: UUID
    quantity: Annotated[int, Field(ge=1, le=99)]
    section: DeckSection
    # The custom group the card sits in on screen, so the agent can talk about the
    # deck the way it is actually laid out. Absent means it is unassigned.
    group: ShortLabel | None = None


class DeckAgentDeckSnapshot(DeckAgentModel):
    """The open deck as the browser holds it, at the moment of one chat turn.

    The backend keeps no deck, so this is posted with each turn exactly as the
    transcript is. It is a snapshot rather than a subscription: the agent sees the
    deck as it was when the question was asked.
    """

    name: ShortLabel
    cards: Annotated[list[DeckAgentDeckCard], Field(max_length=500)] = Field(
        default_factory=list
    )


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
    # Ask for each tool call's arguments and result alongside the answer, for the
    # expandable view in the chat. Off by default: a `read_deck` result is kilobytes
    # of text nobody is looking at unless debug mode is on.
    debug: bool = False

    @model_validator(mode="after")
    def transcript_must_end_with_the_user(self) -> "DeckAgentChatRequest":
        if self.messages[-1].role != "user":
            raise ValueError("the last chat message must be the user's")
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
    # What the model asked for, as JSON text, and the exact result it read back.
    # Both are present only for a turn that asked for `debug`, so absent means "not
    # requested" rather than "the call had no arguments" or "it returned nothing".
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
    DeckAgentTextEvent | DeckAgentToolEvent | DeckAgentDoneEvent | DeckAgentErrorEvent
)
