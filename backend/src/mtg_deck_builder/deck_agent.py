"""Conversational deck agent behind the right-hand chat panel.

The agent holds no server-side session: its entire input is the transcript the
browser posts back on every turn, together with the open deck and its recorded
history, plus whatever its tools look up while answering. So one turn is a bounded
loop — ask, run any tools the model asked for, ask again with the results — that
always ends in prose.

One tool changes something. `edit_deck` cannot mutate anything here either, because
the deck lives in the browser; it returns a resolved edit, which this loop emits as
its own stream event the moment the call finishes. Nothing has changed until the
browser applies it, which is why the edit travels beside the tool line rather than
with the finished answer.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from mtg_deck_builder.config import DeckAgentSettings
from mtg_deck_builder.deck_agent_tools import (
    DECK_DEPENDENT_TOOLS,
    STALE_REPLAY_RESULT,
    DeckAgentToolbox,
)
from mtg_deck_builder.domain import (
    DeckAgentCardLink,
    DeckAgentChatReply,
    DeckAgentChatRequest,
    DeckAgentMessage,
    DeckAgentReplayCall,
    DeckAgentToolCall,
)
from mtg_deck_builder.domain.agent_chat import (
    MAX_REPLAY_CHARS,
    MAX_TOOL_PAYLOAD_CHARS,
    DeckAgentDeckEdit,
    DeckAgentDeckEditEvent,
    DeckAgentDeckSnapshot,
    DeckAgentDeckTextEdit,
    DeckAgentDeckTextEditEvent,
    DeckAgentDoneEvent,
    DeckAgentStreamEvent,
    DeckAgentTextEvent,
    DeckAgentToolEvent,
)
from mtg_deck_builder.providers.openrouter import (
    OpenRouterClient,
    OpenRouterError,
    completion_cost_usd,
)

MAX_CARD_LINKS = 60
"""How many distinct braced names one answer may turn into links."""

# A braced run with no nesting and no newline: a card name, or a mana symbol the
# catalog will decline to recognise.
_BRACED_NAME = re.compile(r"\{([^{}\n]{1,200})\}")

TextEmitter = Callable[[str], Awaitable[None]]
ToolEmitter = Callable[[DeckAgentToolCall], Awaitable[None]]
EditEmitter = Callable[[DeckAgentDeckEdit], Awaitable[None]]
TextEditEmitter = Callable[[DeckAgentDeckTextEdit], Awaitable[None]]


class DeckAgentUnavailable(RuntimeError):
    """The deck agent could not produce a reply.

    `contract_error` separates a model that answered with something unusable from a
    model that could not be reached at all, because only the first is worth
    reporting to the user as a bad answer rather than as downtime.
    """

    def __init__(self, message: str = "", *, contract_error: bool = False) -> None:
        super().__init__(message or "The deck agent is unavailable.")
        self.contract_error = contract_error


class DeckAgentService:
    """Answer one chat turn, running the agent's tools as it asks for them."""

    def __init__(
        self,
        *,
        model_client: OpenRouterClient | None,
        settings: DeckAgentSettings,
        toolbox: DeckAgentToolbox | None = None,
    ) -> None:
        self._model_client = model_client
        self._settings = settings
        self._toolbox = toolbox

    @property
    def available(self) -> bool:
        """Report whether a turn can be attempted at all.

        The streaming route has to know this *before* it starts a response, because a
        status code cannot be revised once the first byte is out.
        """

        return self._settings.enabled and self._model_client is not None

    async def chat(self, request: DeckAgentChatRequest) -> DeckAgentChatReply:
        """Return the agent's next message for this transcript."""

        return await self._run(request, emit_text=None)

    async def stream(
        self,
        request: DeckAgentChatRequest,
    ) -> AsyncIterator[DeckAgentStreamEvent]:
        """Yield the turn as it happens: tool calls when they run, text as it is written.

        The same loop answers both routes. Only the transport differs — this one asks
        the provider to stream, so the answer can be shown while it is still being
        written — and both end in the identical `DeckAgentChatReply`, so nothing the
        interface stores depends on which route produced it.
        """

        events: asyncio.Queue[DeckAgentStreamEvent] = asyncio.Queue()

        async def emit_text(content: str) -> None:
            await events.put(DeckAgentTextEvent(content=content))

        async def emit_tool(call: DeckAgentToolCall) -> None:
            await events.put(DeckAgentToolEvent(call=call))

        async def emit_edit(edit: DeckAgentDeckEdit) -> None:
            await events.put(DeckAgentDeckEditEvent(edit=edit))

        async def emit_text_edit(edit: DeckAgentDeckTextEdit) -> None:
            await events.put(DeckAgentDeckTextEditEvent(edit=edit))

        turn = asyncio.create_task(
            self._run(
                request,
                emit_text=emit_text,
                emit_tool=emit_tool,
                emit_edit=emit_edit,
                emit_text_edit=emit_text_edit,
            )
        )
        try:
            while True:
                queued = asyncio.create_task(events.get())
                done, _ = await asyncio.wait({queued, turn}, return_when=asyncio.FIRST_COMPLETED)
                if queued in done:
                    yield queued.result()
                    continue
                # The turn finished. Drain whatever it emitted last, then report it.
                queued.cancel()
                while not events.empty():
                    yield events.get_nowait()
                yield DeckAgentDoneEvent(reply=turn.result())
                return
        finally:
            turn.cancel()

    async def _run(
        self,
        request: DeckAgentChatRequest,
        *,
        emit_text: TextEmitter | None,
        emit_tool: ToolEmitter | None = None,
        emit_edit: EditEmitter | None = None,
        emit_text_edit: TextEditEmitter | None = None,
    ) -> DeckAgentChatReply:
        """Answer one turn, reporting progress to whichever emitters were given."""

        if not self.available:
            raise DeckAgentUnavailable("The deck agent is not configured.")

        replayed = self._replayed_messages(request)
        conversation: list[dict[str, Any]] = [
            {"role": "system", "content": self._system_prompt(replayed)},
            *_provider_messages(replayed, deck=request.deck),
        ]
        toolbox = self._toolbox if self._toolbox and self._toolbox.enabled else None
        tools = toolbox.definitions() if toolbox else None

        performed: list[DeckAgentToolCall] = []
        costs: list[float | None] = []
        for _ in range(self._settings.tools.max_iterations):
            message, cost = await self._round(conversation, tools, emit_text)
            costs.append(cost)
            requests = _tool_call_requests(message) if toolbox else []
            if not requests:
                return await self._reply(
                    text=_reply_text(message),
                    replayed=replayed,
                    performed=performed,
                    costs=costs,
                )

            assert toolbox is not None  # implied by a non-empty request list
            conversation.append(_assistant_tool_message(message, requests))
            for call_id, name, arguments in requests:
                outcome = await toolbox.run(
                    name,
                    arguments,
                    deck=request.deck,
                    # Posted with the turn exactly as the deck is, and for the same
                    # reason: the backend holds neither.
                    history=request.history,
                )
                performed.append(
                    DeckAgentToolCall(
                        name=str(name),
                        signature=outcome.signature,
                        ok=outcome.ok,
                        detail=outcome.detail,
                        # The provider's own id, so the next turn can hand this call
                        # and its result back as a pair the provider accepts.
                        id=call_id,
                        # On every turn, not only a debug one: any turn may be the one
                        # the user interrupts, and the next turn replays it rather than
                        # paying for the same lookups again. Taken from what actually
                        # ran rather than re-rendered, so neither the panel nor the
                        # replay can show a call that differs from the one made.
                        arguments_json=_payload(_arguments_json(arguments)),
                        result=_payload(outcome.content),
                    )
                )
                if emit_tool is not None:
                    # Sent now rather than with the answer: the point of showing a
                    # call is knowing what the agent is doing while it does it.
                    await emit_tool(performed[-1])
                if outcome.ok and outcome.edit is not None and emit_edit is not None:
                    # After the tool line and before the next round, because the tool
                    # result the model is about to read says the edit has happened —
                    # and nothing has happened until the browser acts on this. A failed
                    # call carries no edit, so nothing is applied for one.
                    await emit_edit(outcome.edit)
                if outcome.ok and outcome.text_edit is not None and emit_text_edit is not None:
                    await emit_text_edit(outcome.text_edit)
                conversation.append(
                    {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": outcome.content,
                    }
                )

        # Out of tool rounds. This last pass advertises no tools at all, so a model
        # that would keep calling them forever still has to answer, and the turn ends
        # in prose rather than in nothing the user can read.
        #
        # Told so, as well as shown so. A conversation that ends in tool results with
        # no tools attached is not self-explanatory: the model is mid-task, its own
        # instructions require a lookup it can no longer make, and the observed result
        # is that it writes the call it wanted as prose. Saying it in words is what
        # turns an empty toolbox into an instruction to answer.
        message, cost = await self._round(
            [
                *conversation,
                {
                    "role": "system",
                    "content": self._settings.tools.final_pass_instruction,
                },
            ],
            None,
            emit_text,
        )
        costs.append(cost)
        return await self._reply(
            text=_reply_text(message),
            replayed=replayed,
            performed=performed,
            costs=costs,
        )

    async def _round(
        self,
        conversation: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        emit_text: TextEmitter | None,
    ) -> tuple[dict[str, Any], float | None]:
        """Run one completion, streaming its text out when anyone is listening.

        Both transports return the same assembled assistant message, so the loop
        around them cannot tell which one ran.
        """

        if emit_text is None:
            response = await self._complete(conversation, tools)
            return _response_message(response), completion_cost_usd(response)
        return await self._complete_streaming(conversation, tools, emit_text)

    async def _complete_streaming(
        self,
        conversation: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        emit_text: TextEmitter,
    ) -> tuple[dict[str, Any], float | None]:
        """Assemble one streamed completion, reporting each piece of text as it lands.

        Reasoning deltas are deliberately not emitted: at `xhigh` effort they are the
        bulk of the turn and are not an answer, so the panel says it is thinking
        instead of narrating.
        """

        if self._model_client is None:
            raise DeckAgentUnavailable("The deck agent is not configured.")
        content: list[str] = []
        fragments: dict[int, dict[str, Any]] = {}
        cost: float | None = None
        try:
            stream = self._model_client.stream_chat_completion(
                {**self._completion_payload(conversation, tools), "usage": {"include": True}}
            )
            async for chunk in stream:
                # Usage arrives on its own final chunk, so the last figure seen wins
                # rather than the first.
                chunk_cost = completion_cost_usd(chunk)
                if chunk_cost is not None:
                    cost = chunk_cost
                for delta in _stream_deltas(chunk):
                    text = delta.get("content")
                    if isinstance(text, str) and text:
                        content.append(text)
                        await emit_text(text)
                    _merge_tool_call_fragments(fragments, delta.get("tool_calls"))
        except OpenRouterError as exc:
            raise DeckAgentUnavailable(str(exc)) from exc

        message: dict[str, Any] = {"role": "assistant", "content": "".join(content)}
        if fragments:
            message["tool_calls"] = [fragments[index] for index in sorted(fragments)]
        return message, cost

    def _completion_payload(
        self,
        conversation: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self._settings.model,
            "messages": conversation,
            **self._temperature_payload(),
            "reasoning": {"effort": self._settings.reasoning_effort, "exclude": False},
            "provider": {"require_parameters": True},
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        return payload

    async def _complete(
        self,
        conversation: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        payload = self._completion_payload(conversation, tools)
        if self._model_client is None:
            raise DeckAgentUnavailable("The deck agent is not configured.")
        try:
            return await self._model_client.chat_completion(payload)
        except OpenRouterError as exc:
            raise DeckAgentUnavailable(str(exc)) from exc

    async def _reply(
        self,
        *,
        text: str,
        replayed: list[DeckAgentMessage],
        performed: list[DeckAgentToolCall],
        costs: list[float | None],
    ) -> DeckAgentChatReply:
        """Assemble the reply, totalling what every completion in the turn cost."""

        priced = [cost for cost in costs if cost is not None]
        return DeckAgentChatReply(
            message=DeckAgentMessage(role="assistant", content=text),
            model=self._settings.model,
            replayed_message_count=len(replayed),
            # A turn that used tools paid for several completions. Absent figures are
            # counted rather than treated as zero, so a part-priced turn cannot total
            # up silently low.
            cost_usd=round(sum(priced), 8) if priced else None,
            unpriced_call_count=len(costs) - len(priced),
            tool_calls=_within_replay_budget(performed),
            card_links=await self._card_links(text),
        )

    def _system_prompt(self, replayed: list[DeckAgentMessage]) -> str:
        """The system prompt, plus the replay note when there is a replay to note.

        Appended only when the window actually carries a `tool` message. A rule about
        interrupted turns on a turn that has none is a paragraph the model has to work
        out is irrelevant — the same reason the undone-edit marker is only explained
        when something is marked.
        """

        parts = [self._settings.system_prompt]
        instruction = self._settings.tools.replayed_call_instruction.strip()
        if instruction and any(message.role == "tool" for message in replayed):
            parts.append(instruction)
        return "\n\n".join(parts)

    async def _card_links(self, text: str) -> list[DeckAgentCardLink]:
        """Resolve the card names the answer braced, in the order it named them.

        Resolution happens here rather than in the browser because the catalog is the
        only thing that can say whether `{Sol Ring}` is a card: it is also how a mana
        symbol like `{T}` is told apart from a card name, and how the agent's casing is
        corrected to the printed one. A name that resolves to nothing yields no link
        and the chat renders it as the plain words it is.
        """

        names = _braced_names(text)
        if not names or self._toolbox is None:
            return []
        resolved = await self._toolbox.oracle_ids_for_names(names)
        return [
            DeckAgentCardLink(name=name, oracle_id=resolved[key])
            for name, key in ((name, name.casefold()) for name in names)
            if key in resolved
        ]

    def _replayed_messages(self, request: DeckAgentChatRequest) -> list[DeckAgentMessage]:
        """Keep the newest messages that fit the configured memory window.

        Trimming from the front rather than the back is what makes the window a
        memory limit instead of an amnesia bug: the current question always
        survives, and only the oldest context falls away.

        The cut then moves *backwards* to a group boundary, so it never lands inside a
        replayed tool group. A slice beginning with a `tool` message is the one thing
        the provider rejects outright, and losing the assistant message that asked for
        a result while keeping the result is worse than sending one message too many.
        Backwards rather than forwards on purpose: forwards would drop a whole
        interrupted turn's work, which is exactly what a replay exists to keep.

        A group can therefore push the slice past the window, by at most the group's
        own length. Nothing bounds a group but `MAX_REPLAY_CALLS`, and
        `agent.tools.max_iterations` bounds what a real turn can produce far below
        that, so the window is a floor on context rather than a ceiling.
        """

        messages = list(request.messages)
        window = self._settings.max_history_messages
        if len(messages) <= window:
            return messages
        return messages[_group_start(messages, len(messages) - window) :]

    def _temperature_payload(self) -> dict[str, float]:
        """Send `temperature` only when configured, since not every model accepts it.

        Reasoning models such as the GPT-5 series reject the parameter outright, and
        `provider.require_parameters` turns an unsupported parameter into a routing
        failure rather than a silently dropped field, so the key has to be absent.
        """

        if self._settings.temperature is None:
            return {}
        return {"temperature": self._settings.temperature}


def _group_start(messages: list[DeckAgentMessage], start: int) -> int:
    """Move a cut backwards until no kept `tool` message has lost its call.

    Run to a fixpoint rather than hopped once: the contract only requires an answer to
    come *later* than its call, not immediately after it, so pulling one group in can
    expose a `tool` message belonging to an older one. Answers can never be cut by this
    — the kept slice always runs to the end of the transcript, and an answer is always
    later than the call it answers — so only the opening edge is ever in question.
    """

    owners = {
        call.id: index for index, message in enumerate(messages) for call in message.tool_calls
    }
    kept = start
    while True:
        earliest = min(
            (
                owners[message.tool_call_id]
                for message in messages[kept:]
                if message.role == "tool" and message.tool_call_id in owners
            ),
            default=kept,
        )
        if earliest >= kept:
            return kept
        kept = earliest


def _provider_messages(
    messages: list[DeckAgentMessage],
    *,
    deck: DeckAgentDeckSnapshot | None,
) -> list[dict[str, Any]]:
    """Shape the transcript the way the completions API reads it.

    A replayed tool group has to arrive in the provider's own shape — an assistant
    message carrying `tool_calls`, then one `tool` message per call — because that is
    the only shape a tool result can be handed back in. It is built here rather than in
    the browser for the same reason `card_links` are resolved here: the wire format
    belongs to whichever side talks to the provider.
    """

    calls = {call.id: call for message in messages for call in message.tool_calls}
    shaped: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "tool":
            shaped.append(
                {
                    "role": "tool",
                    "tool_call_id": message.tool_call_id,
                    "content": _replayed_result(message, calls, deck=deck),
                }
            )
            continue
        if message.tool_calls:
            shaped.append(
                {
                    "role": "assistant",
                    # Empty rather than absent, exactly as an assistant tool-call turn
                    # made in this process is echoed back.
                    "content": message.content or "",
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": call.arguments_json,
                            },
                        }
                        for call in message.tool_calls
                    ],
                }
            )
            continue
        shaped.append({"role": message.role, "content": message.content})
    if deck is not None:
        # User-authored deck text stays at user trust. Putting it in the system message
        # would turn a description such as "ignore prior instructions" into an instruction.
        for index in range(len(shaped) - 1, -1, -1):
            if shaped[index]["role"] != "user":
                continue
            content = str(shaped[index].get("content") or "")
            shaped[index] = {
                **shaped[index],
                "content": f"{content}\n\n{_deck_brief_context(deck)}",
            }
            break
    return shaped


def _deck_brief_context(deck: DeckAgentDeckSnapshot | None) -> str:
    """Give every turn the durable intent without requiring a paid read first."""

    if deck is None:
        return ""
    description = deck.description or "(empty)"
    return (
        "<open_deck_context>\n"
        f'Name: "{deck.name}"\n'
        f"Description:\n{description}\n"
        "</open_deck_context>"
    )


def _replayed_result(
    message: DeckAgentMessage,
    calls: dict[str, DeckAgentReplayCall],
    *,
    deck: DeckAgentDeckSnapshot | None,
) -> str:
    """Replay one tool result, or say why it is not being replayed.

    Only a deck-dependent result can go stale, and it is stale whenever the revision it
    was read against is not the revision posted now. A missing revision on either side
    counts as different, because "the browser could not say" is not "unchanged" — and
    an unverifiable read of the deck is exactly the one worth refusing.
    """

    call = calls.get(message.tool_call_id or "")
    if call is None or call.name not in DECK_DEPENDENT_TOOLS:
        return message.content or ""
    posted = deck.updated_at if deck is not None else None
    if call.deck_revision == posted:
        return message.content or ""
    return STALE_REPLAY_RESULT


def _within_replay_budget(calls: list[DeckAgentToolCall]) -> list[DeckAgentToolCall]:
    """Fit one turn's whole payload text inside `MAX_REPLAY_CHARS`.

    Oldest call first, and a `result` before its own `arguments_json`: the newest lookup
    is the one a replay is most likely to continue from, and a call that kept only its
    arguments still replays as framing — "interrupted after `read_deck()`" — where a
    call dropped whole leaves the model unable to tell it ever ran.

    Shedding rather than refusing, because which turn gets interrupted is not knowable
    in advance: a bounded replay of the newest calls beats an unbounded reply nothing
    can store.
    """

    shed = list(calls)
    # Results oldest-first, then arguments oldest-first. Taking a call's arguments while
    # a later call still has its result would trade the cheaper loss for the dearer one.
    for field in ("result", "arguments_json"):
        for index, call in enumerate(shed):
            if _payload_chars(shed) <= MAX_REPLAY_CHARS:
                return shed
            if getattr(call, field) is not None:
                shed[index] = call.model_copy(update={field: None})
    return shed


def _payload_chars(calls: list[DeckAgentToolCall]) -> int:
    """Count the payload text one reply is carrying."""

    return sum(len(call.arguments_json or "") + len(call.result or "") for call in calls)


def _response_message(response: dict[str, Any]) -> dict[str, Any]:
    """Read the one message out of a chat completion."""

    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise DeckAgentUnavailable(
            "The deck agent returned no choices.",
            contract_error=True,
        )
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        raise DeckAgentUnavailable(
            "The deck agent returned no message.",
            contract_error=True,
        )
    return message


def _braced_names(text: str) -> list[str]:
    """Pull the braced names out of an answer, first mention first, each once.

    Deliberately not filtered here: whether `{T}` is a card is the catalog's question,
    not a regex's. The cap only stops a runaway answer from turning into a runaway
    query — an answer naming sixty distinct cards has other problems.
    """

    seen: set[str] = set()
    names: list[str] = []
    for match in _BRACED_NAME.finditer(text):
        name = match.group(1).strip()
        key = name.casefold()
        if not name or key in seen:
            continue
        seen.add(key)
        names.append(name)
        if len(names) == MAX_CARD_LINKS:
            break
    return names


def _reply_text(message: dict[str, Any]) -> str:
    """Read the assistant text out of one completion's message.

    A reasoning model can spend its whole budget thinking and return empty content
    with a populated `reasoning` field, which validates as a successful response but
    has nothing to show. That counts as a contract error, not as an answer.

    So does an answer that is a tool call written out as prose. Both are the same
    failure wearing different clothes: a completion that satisfies the schema and is
    not something a person can read.
    """

    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise DeckAgentUnavailable(
            "The deck agent returned an empty message.",
            contract_error=True,
        )
    text = content.strip()
    if _LEAKED_TOOL_CALL.search(text):
        raise DeckAgentUnavailable(
            "The deck agent tried to call a tool instead of answering.",
            contract_error=True,
        )
    return text


#: A tool call the model wrote into its answer rather than making.
#:
#: Both halves are shapes that cannot occur in prose, which is the whole test — a
#: looser rule would reject real answers, and an answer wrongly rejected is worse than
#: this failure, which the final-pass instruction already prevents.
#:
#: `to=<name>` at the start of a line is the model's own routing syntax with its
#: special tokens stripped by the provider; U+FFFC is the object-replacement character
#: those tokens are replaced *with*, so it is a direct sighting of the same event. Both
#: were observed in the wild on 2026-08-02 before the instruction was added.
_LEAKED_TOOL_CALL = re.compile(r"^\s*to=\S|￼", re.MULTILINE)


def _tool_call_requests(
    message: dict[str, Any],
) -> list[tuple[str, object, object]]:
    """Read the tool calls a message asked for, keeping unusable ones.

    Malformed arguments are passed through rather than dropped: the toolbox turns
    them into a failed call the model can see and correct, which is far better than
    a silently ignored request it will make again.
    """

    raw_calls = message.get("tool_calls")
    if not isinstance(raw_calls, list):
        return []
    requests: list[tuple[str, object, object]] = []
    for raw_call in raw_calls:
        if not isinstance(raw_call, dict):
            continue
        function = raw_call.get("function")
        call_id = raw_call.get("id")
        if not isinstance(function, dict) or not isinstance(call_id, str):
            continue
        raw_arguments = function.get("arguments")
        arguments: object
        if isinstance(raw_arguments, dict):
            # Not every provider serializes the arguments to a string.
            arguments = raw_arguments
        elif isinstance(raw_arguments, str):
            try:
                arguments = json.loads(raw_arguments or "{}")
            except json.JSONDecodeError:
                arguments = raw_arguments
        else:
            arguments = None
        requests.append((call_id, function.get("name"), arguments))
    return requests


def _stream_deltas(chunk: dict[str, Any]) -> list[dict[str, Any]]:
    """Read the delta out of every choice in one streamed chunk."""

    choices = chunk.get("choices")
    if not isinstance(choices, list):
        return []
    deltas: list[dict[str, Any]] = []
    for choice in choices:
        delta = choice.get("delta") if isinstance(choice, dict) else None
        if isinstance(delta, dict):
            deltas.append(delta)
    return deltas


def _merge_tool_call_fragments(
    fragments: dict[int, dict[str, Any]],
    raw_fragments: object,
) -> None:
    """Rebuild whole tool calls from the pieces a stream sends them in.

    A streamed tool call arrives as an id and a name in one chunk and its arguments
    a few characters at a time across the next several, keyed only by `index`. The
    assembled call has to look exactly like a non-streamed one, because the loop and
    the echo back to the provider both read it that way.
    """

    if not isinstance(raw_fragments, list):
        return
    for raw in raw_fragments:
        if not isinstance(raw, dict):
            continue
        index = raw.get("index")
        if not isinstance(index, int):
            # Without an index there is no way to tell which call a piece belongs to.
            index = len(fragments)
        call = fragments.setdefault(
            index,
            {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
        )
        identifier = raw.get("id")
        if isinstance(identifier, str) and identifier:
            call["id"] = identifier
        function = raw.get("function")
        if not isinstance(function, dict):
            continue
        name = function.get("name")
        if isinstance(name, str) and name:
            call["function"]["name"] = name
        arguments = function.get("arguments")
        if isinstance(arguments, str):
            call["function"]["arguments"] += arguments


def _arguments_json(arguments: object) -> str:
    """Render whatever the model sent as JSON text, for the panel and for the replay.

    Arguments that were not valid JSON are shown as they arrived rather than
    discarded — a malformed call is exactly the one worth being able to read, and it is
    also the one the model may want handed back so it can see what it got wrong.
    """

    if isinstance(arguments, str):
        return arguments
    try:
        return json.dumps(arguments, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return repr(arguments)


def _payload(text: str) -> str:
    """Fit one payload inside the per-payload cap, saying so when it did not fit.

    `MAX_REPLAY_CHARS` then bounds their sum over the whole turn, so a payload that
    fits here can still be shed later; see `_within_replay_budget`.
    """

    if len(text) <= MAX_TOOL_PAYLOAD_CHARS:
        return text
    marker = f"\n… truncated, {len(text) - MAX_TOOL_PAYLOAD_CHARS:,} characters more"
    return text[: MAX_TOOL_PAYLOAD_CHARS - len(marker)] + marker


def _assistant_tool_message(
    message: dict[str, Any],
    requests: list[tuple[str, object, object]],
) -> dict[str, Any]:
    """Echo the assistant's tool-call turn back, as the completions API requires.

    Only the calls that were actually run are echoed, because every `tool_calls`
    entry must be answered by a matching `tool` message or the next request is
    rejected as an incomplete conversation.
    """

    answered = {call_id for call_id, _, _ in requests}
    raw_calls = message.get("tool_calls")
    calls = [
        raw_call
        for raw_call in (raw_calls if isinstance(raw_calls, list) else [])
        if isinstance(raw_call, dict) and raw_call.get("id") in answered
    ]
    content = message.get("content")
    return {
        "role": "assistant",
        "content": content if isinstance(content, str) else "",
        "tool_calls": calls,
    }
