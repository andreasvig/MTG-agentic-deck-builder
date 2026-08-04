"""Deck agent chat API."""

from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from mtg_deck_builder.api.errors import PublicError, PublicErrorResponse
from mtg_deck_builder.deck_agent import DeckAgentService, DeckAgentUnavailable
from mtg_deck_builder.domain import DeckAgentChatReply, DeckAgentChatRequest
from mtg_deck_builder.domain.agent_chat import DeckAgentErrorEvent, DeckAgentStreamEvent

router = APIRouter(prefix="/agent", tags=["agent"])

# One wording for each failure, so the streamed event and the HTTP error cannot
# drift into telling the user two different things about the same fault.
CONTRACT_ERROR = PublicError(
    code="deck_agent_contract_error",
    message="The deck agent did not answer. Please try again.",
)
UNAVAILABLE_ERROR = PublicError(
    code="deck_agent_unavailable",
    message="The deck agent is temporarily unavailable.",
)


def get_deck_agent(request: Request) -> DeckAgentService:
    """Resolve the conversational deck agent for this application process."""

    return request.app.state.deck_agent


@router.post(
    "/chat",
    response_model=DeckAgentChatReply,
    responses={
        status.HTTP_502_BAD_GATEWAY: {
            "description": "The deck agent returned an unusable reply.",
            "model": PublicErrorResponse,
        },
        status.HTTP_503_SERVICE_UNAVAILABLE: {
            "description": "The deck agent is temporarily unavailable.",
            "model": PublicErrorResponse,
        },
    },
)
async def chat_with_deck_agent(
    request_body: DeckAgentChatRequest,
    request: Request,
) -> DeckAgentChatReply:
    """Answer one chat turn from the transcript the client holds."""

    agent = get_deck_agent(request)
    try:
        return await agent.chat(request_body)
    except DeckAgentUnavailable as exc:
        raise _http_error(exc) from None


@router.post(
    "/chat/stream",
    response_class=StreamingResponse,
    responses={
        status.HTTP_200_OK: {
            "description": (
                "Server-sent events: `text` as the answer is written, `tool` as each "
                "call finishes, `deck_edit` or `deck_text_edit` when a turn changed "
                "the deck — carrying the "
                "resolved change for the browser to apply, since the server holds no "
                "deck — then one `done` carrying the same reply `POST /agent/chat` "
                "returns, or one `error` if the turn failed after the response had "
                "begun."
            ),
            "content": {"text/event-stream": {}},
        },
        status.HTTP_503_SERVICE_UNAVAILABLE: {
            "description": "The deck agent is not configured or cannot be reached.",
            "model": PublicErrorResponse,
        },
    },
)
async def stream_chat_with_deck_agent(
    request_body: DeckAgentChatRequest,
    request: Request,
) -> StreamingResponse:
    """Answer one chat turn as it happens, rather than only when it is finished."""

    agent = get_deck_agent(request)
    # Checked before the response starts: a status code cannot be taken back once
    # the first byte has gone out, so an agent that is switched off has to fail here
    # as an ordinary HTTP error rather than as a stream carrying one event.
    if not agent.available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=UNAVAILABLE_ERROR.model_dump(mode="json", exclude_none=True),
        )

    return StreamingResponse(
        _sse_events(agent, request_body),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            # Nothing between here and the browser may hold the turn back until it
            # is complete, which would defeat the point of streaming it.
            "X-Accel-Buffering": "no",
        },
    )


async def _sse_events(
    agent: DeckAgentService,
    request_body: DeckAgentChatRequest,
) -> AsyncIterator[str]:
    """Render the turn's events as server-sent events, failures included."""

    try:
        async for event in agent.stream(request_body):
            yield _sse(event)
    except DeckAgentUnavailable as exc:
        error = CONTRACT_ERROR if exc.contract_error else UNAVAILABLE_ERROR
        yield _sse(DeckAgentErrorEvent(code=error.code, message=error.message))


def _sse(event: DeckAgentStreamEvent) -> str:
    """Frame one event.

    Serialized without `exclude_none`, so a streamed reply has exactly the shape the
    JSON route's reply has — an absent cost stays visible as `null` rather than
    disappearing into a field the client has to guess about.
    """

    return f"data: {event.model_dump_json()}\n\n"


def _http_error(exc: DeckAgentUnavailable) -> HTTPException:
    """Map an agent failure onto the public error the client expects."""

    if exc.contract_error:
        return HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=CONTRACT_ERROR.model_dump(mode="json", exclude_none=True),
        )
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=UNAVAILABLE_ERROR.model_dump(mode="json", exclude_none=True),
    )
