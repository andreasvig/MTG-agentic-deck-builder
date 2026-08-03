import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from mtg_deck_builder.config import DeckAgentSettings, Settings
from mtg_deck_builder.deck_agent import (
    MAX_CARD_LINKS,
    DeckAgentService,
    DeckAgentUnavailable,
)
from mtg_deck_builder.deck_agent_tools import DECK_DEPENDENT_TOOLS, STALE_REPLAY_RESULT, ToolOutcome
from mtg_deck_builder.domain import (
    DeckAgentChatRequest,
    DeckAgentDeckSnapshot,
    DeckAgentMessage,
    DeckAgentReplayCall,
    DeckAgentToolCall,
)
from mtg_deck_builder.domain.agent_chat import (
    MAX_HISTORY_EDITS,
    MAX_HISTORY_SESSIONS,
    MAX_MESSAGE_CHARS,
    MAX_REPLAY_CHARS,
    MAX_TOOL_PAYLOAD_CHARS,
    DeckAgentDeckEdit,
    DeckAgentDeckEditChange,
    DeckAgentDeckHistory,
    DeckAgentDeckHistoryChange,
    DeckAgentDeckHistoryEdit,
    DeckAgentDeckPlacement,
    DeckAgentDeckSession,
)
from mtg_deck_builder.main import create_app
from mtg_deck_builder.providers.openrouter import OpenRouterClient, OpenRouterError


class StubModelClient:
    """Record the payload and answer with a fixed completion."""

    def __init__(self, responses: list[dict[str, Any]] | None = None) -> None:
        self.payloads: list[dict[str, Any]] = []
        self._responses = responses or [
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "  Sol Ring, every time.  ",
                        }
                    }
                ],
                "usage": {"prompt_tokens": 24, "completion_tokens": 33, "cost": 0.000222},
            }
        ]

    async def chat_completion(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.payloads.append(payload)
        return self._responses[min(len(self.payloads) - 1, len(self._responses) - 1)]


class FailingModelClient:
    def __init__(self, error: Exception) -> None:
        self._error = error

    async def chat_completion(self, payload: dict[str, Any]) -> dict[str, Any]:
        raise self._error


def _settings(**overrides: Any) -> DeckAgentSettings:
    values: dict[str, Any] = {
        "system_prompt": "You are the deck assistant.",
        "model": "openai/gpt-5.6-luna",
        "reasoning_effort": "xhigh",
    }
    values.update(overrides)
    return DeckAgentSettings(**values)


def _request(*contents: str) -> DeckAgentChatRequest:
    """Build an alternating transcript that ends on the user.

    Roles are assigned backwards from the newest message, because the contract
    requires the last one to be the user's whatever the length.
    """

    roles = ("user", "assistant")
    last = len(contents) - 1
    return DeckAgentChatRequest(
        messages=[
            DeckAgentMessage(role=roles[(last - index) % 2], content=content)
            for index, content in enumerate(contents)
        ]
    )


def test_service_sends_the_system_prompt_and_the_whole_transcript() -> None:
    client = StubModelClient()
    service = DeckAgentService(model_client=client, settings=_settings())

    reply = asyncio.run(
        service.chat(_request("What ramp should I run?", "Sol Ring.", "And after that?"))
    )

    assert reply.message.role == "assistant"
    assert reply.message.content == "Sol Ring, every time."
    assert reply.model == "openai/gpt-5.6-luna"
    assert reply.replayed_message_count == 3
    payload = client.payloads[0]
    assert payload["messages"] == [
        {"role": "system", "content": "You are the deck assistant."},
        {"role": "user", "content": "What ramp should I run?"},
        {"role": "assistant", "content": "Sol Ring."},
        {"role": "user", "content": "And after that?"},
    ]
    assert payload["reasoning"] == {"effort": "xhigh", "exclude": False}
    assert payload["provider"] == {"require_parameters": True}
    assert payload["model"] == "openai/gpt-5.6-luna"


def test_service_omits_temperature_unless_configured() -> None:
    without = StubModelClient()
    with_temperature = StubModelClient()

    asyncio.run(
        DeckAgentService(model_client=without, settings=_settings()).chat(_request("Hello"))
    )
    asyncio.run(
        DeckAgentService(
            model_client=with_temperature,
            settings=_settings(temperature=0.4),
        ).chat(_request("Hello"))
    )

    # `provider.require_parameters` turns an unsupported parameter into a routing
    # failure, so the key has to be absent rather than null for the GPT-5 series.
    assert "temperature" not in without.payloads[0]
    assert with_temperature.payloads[0]["temperature"] == 0.4


def test_service_replays_only_the_configured_memory_window() -> None:
    client = StubModelClient()
    service = DeckAgentService(
        model_client=client,
        settings=_settings(max_history_messages=2),
    )

    reply = asyncio.run(service.chat(_request("first", "second", "third", "fourth")))

    # Trimming drops the oldest context and always keeps the current question.
    assert reply.replayed_message_count == 2
    assert client.payloads[0]["messages"] == [
        {"role": "system", "content": "You are the deck assistant."},
        {"role": "assistant", "content": "third"},
        {"role": "user", "content": "fourth"},
    ]


def test_service_rejects_an_empty_reply_as_a_contract_error() -> None:
    # A reasoning model can spend its whole budget thinking and answer with empty
    # content, which is a successful HTTP response with nothing to show.
    client = StubModelClient(
        [
            {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "reasoning": "Thought at length about mana rocks.",
                        }
                    }
                ]
            }
        ]
    )
    service = DeckAgentService(model_client=client, settings=_settings())

    with pytest.raises(DeckAgentUnavailable) as error:
        asyncio.run(service.chat(_request("Hello")))

    assert error.value.contract_error is True


def test_service_reports_a_transport_failure_as_downtime() -> None:
    service = DeckAgentService(
        model_client=FailingModelClient(OpenRouterError("OpenRouter could not be reached")),
        settings=_settings(),
    )

    with pytest.raises(DeckAgentUnavailable) as error:
        asyncio.run(service.chat(_request("Hello")))

    assert error.value.contract_error is False


def test_service_without_a_key_or_disabled_is_unavailable() -> None:
    no_key = DeckAgentService(model_client=None, settings=_settings())
    disabled = DeckAgentService(model_client=StubModelClient(), settings=_settings(enabled=False))

    for service in (no_key, disabled):
        with pytest.raises(DeckAgentUnavailable) as error:
            asyncio.run(service.chat(_request("Hello")))
        assert error.value.contract_error is False


def test_transcript_must_end_with_the_user() -> None:
    with pytest.raises(ValidationError):
        DeckAgentChatRequest(
            messages=[
                DeckAgentMessage(role="user", content="Hello"),
                DeckAgentMessage(role="assistant", content="Hi"),
            ]
        )
    with pytest.raises(ValidationError):
        DeckAgentChatRequest(messages=[])


def test_blank_message_content_is_rejected() -> None:
    with pytest.raises(ValidationError):
        DeckAgentMessage(role="user", content="   ")


def test_chat_route_returns_the_agent_reply() -> None:
    with TestClient(create_app()) as client:
        client.app.state.deck_agent = DeckAgentService(
            model_client=StubModelClient(),
            settings=_settings(),
        )
        response = client.post(
            "/api/v1/agent/chat",
            json={"messages": [{"role": "user", "content": "What ramp should I run?"}]},
        )

    assert response.status_code == 200
    assert response.json() == {
        # The two replay fields are serialized on every message rather than only on one
        # that uses them, for the same reason `card_links` always appears: a client must
        # not have to tell absent from empty.
        "message": {
            "role": "assistant",
            "content": "Sol Ring, every time.",
            "tool_calls": [],
            "tool_call_id": None,
        },
        "model": "openai/gpt-5.6-luna",
        "replayed_message_count": 1,
        "cost_usd": 0.000222,
        "unpriced_call_count": 0,
        "tool_calls": [],
        # No toolbox, so nothing can resolve a name — but the field is always present,
        # because a client reading `card_links` must not have to tell absent from empty.
        "card_links": [],
    }


def test_service_reports_what_the_turn_cost_and_distinguishes_no_figure() -> None:
    priced = StubModelClient()
    unpriced = StubModelClient(
        [
            {
                "choices": [{"message": {"role": "assistant", "content": "Sol Ring."}}],
                "usage": {"prompt_tokens": 24, "completion_tokens": 33},
            }
        ]
    )

    with_cost = asyncio.run(
        DeckAgentService(model_client=priced, settings=_settings()).chat(_request("Hello"))
    )
    without_cost = asyncio.run(
        DeckAgentService(model_client=unpriced, settings=_settings()).chat(_request("Hello"))
    )

    assert with_cost.cost_usd == 0.000222
    # An unreported price must not read as a free turn in a running total.
    assert without_cost.cost_usd is None


def test_chat_route_separates_downtime_from_a_bad_answer() -> None:
    with TestClient(create_app()) as client:
        client.app.state.deck_agent = DeckAgentService(
            model_client=None,
            settings=_settings(),
        )
        unavailable = client.post(
            "/api/v1/agent/chat",
            json={"messages": [{"role": "user", "content": "Hello"}]},
        )
        client.app.state.deck_agent = DeckAgentService(
            model_client=StubModelClient([{"choices": []}]),
            settings=_settings(),
        )
        contract_error = client.post(
            "/api/v1/agent/chat",
            json={"messages": [{"role": "user", "content": "Hello"}]},
        )
        invalid = client.post(
            "/api/v1/agent/chat",
            json={"messages": [{"role": "assistant", "content": "Hello"}]},
        )

    assert unavailable.status_code == 503
    assert unavailable.json()["detail"]["code"] == "deck_agent_unavailable"
    assert contract_error.status_code == 502
    assert contract_error.json()["detail"]["code"] == "deck_agent_contract_error"
    assert invalid.status_code == 422


def test_settings_load_the_repository_agent_yaml() -> None:
    settings = Settings()

    assert settings.agent.enabled is True
    assert settings.agent.provider == "openrouter"
    assert settings.agent.model == "openai/gpt-5.6-luna"
    # Verified live: OpenRouter rejects an effort this model does not accept with a
    # 400 naming the accepted values, so a wrong value here fails loudly.
    assert settings.agent.reasoning_effort == "xhigh"
    assert settings.agent.temperature is None
    # A single xhigh reply outlives the search agent's whole 20-second budget.
    assert settings.agent.timeout_seconds > settings.search.agentic.timeout_seconds
    assert settings.agent.max_history_messages >= 2
    for heading in ("# Task", "# Using the tools", "# Output", "# Guidelines"):
        assert heading in settings.agent.system_prompt
    # The prompt has to name both tools, or the model will not know it can read the
    # deck and will fall back to asking the user what is in it.
    prompt = settings.agent.system_prompt.casefold()
    assert "read_deck" in prompt
    assert "see_cards" in prompt
    assert "commander" in prompt
    # The tool descriptions are prompt text and live in the same file.
    assert "no card text" in settings.agent.tools.read_deck_description.casefold()
    # Both extras are advertised in the description and named in the prompt. A figure
    # the model is not told it can ask for is a figure it never asks for, which is how
    # the placement field went unused until its description was fixed.
    assert "extra_info" in prompt
    for extra in ("`mana`", "`price`"):
        assert extra in settings.agent.tools.read_deck_description
    for detail in ("rules", "prices", "tags", "similar", "inclusion", "legality"):
        assert detail in settings.agent.tools.see_cards_description


def test_the_prompt_keeps_the_web_on_the_other_side_of_the_catalog() -> None:
    """The web tools are the only ones whose results are not authoritative.

    The rule that guards this used to read "never recommend a card you have not seen
    in a tool result this turn", which `search_web` quietly satisfies — its results
    are tool results. If that sentence stops naming the local tools, the loophole is
    back and the agent may recommend a card that only ever existed in a summary.
    """

    settings = Settings()
    prompt = settings.agent.system_prompt

    assert "# Using the web" in prompt
    # The block scalar strips the indentation this file writes, so a heading in the
    # loaded prompt is flush left. Splitting on the indented form matched nothing and
    # silently made `section` the whole rest of the prompt.
    section = prompt.split("# Using the web", 1)[1].split("\n# ", 1)[0]
    assert 0 < len(section) < len(prompt) / 2
    # The identifier failure is what the section exists for: names and numbers.
    assert "see_cards` or `search_cards`" in section
    assert "Never repeat a number from a *summary* as a fact." in section

    # ADR 0041 carved out one exception: a `read_page` result rendered from a site's
    # own database holds that site's real figures. The carve-out is only safe while it
    # keys on the marker the model can actually see, and while it stops at numbers —
    # a database's spelling of a card is still not the catalog's. Both halves are
    # asserted on the sentence that grants it, not on the section around it.
    granting = [line for line in section.splitlines() if '"Read from ' in line]
    assert len(granting) == 1
    assert "see_cards" in granting[0]

    recommendation = next(
        line for line in prompt.splitlines() if "Never recommend a card" in line
    )
    for local in ("read_deck", "see_cards", "search_cards"):
        assert local in recommendation
    assert "search_web" in recommendation

    for tool in ("search_web", "read_page"):
        assert tool in prompt
    web = settings.agent.tools
    assert "see_cards" in web.search_web_description
    assert "JavaScript" in web.read_page_description


def test_the_configured_sonar_tier_is_the_one_the_bake_off_chose() -> None:
    """`sonar` was measured against every tier OpenRouter carries, in ADR 0040.

    Pinned because the alternatives are not interchangeable: `sonar-pro-search` costs
    roughly ten times as much per call, and `sonar-reasoning-pro` returned empty or
    truncated bodies on about a third of calls. Either would be a real regression
    arriving as a one-word config edit.
    """

    web = Settings().agent.tools.web

    assert web.model == "perplexity/sonar"
    assert web.enabled is True
    assert web.max_sources >= 5
    # The reader has to be able to fill its character budget from one fetch.
    assert web.page_max_bytes > web.page_max_characters
    prompt = web.system_prompt.casefold()
    assert "cite" in prompt
    assert "never state a deck count" in prompt


def test_the_prompt_teaches_the_three_rules_that_make_editing_safe() -> None:
    settings = Settings()
    prompt = settings.agent.system_prompt

    assert "# Editing the deck" in prompt
    section = prompt.split("# Editing the deck", 1)[1].split("\n# ", 1)[0]
    # Declarative, not imperative: the count you want, never the operation. Stated
    # bare on purpose — a reason the model can satisfy while still breaking the rule
    # reads as permission, and that is how one search_cards rule doubled its calls.
    assert "State the count you want, not the operation." in section
    # Read in the same turn, stated bare for the same reason as the rule above. The
    # first draft justified it with the user having had the board in front of them
    # since — which the model can judge false ("they only typed a reply, so my
    # snapshot is current") while still skipping the read, and a reason that does not
    # apply is permission. Enforcing it in code was considered and rejected: a change
    # states the count it wants, so an unread edit is redundant rather than wrong, and
    # enforcement would spend one of four tool iterations on every editing turn.
    assert "in the same turn before you edit" in section
    assert "Every turn, without exception" in section
    # And no defeasible reason crept back in. These are the words of the two dodges the
    # first draft licensed.
    assert "snapshot of an earlier deck" not in section
    assert "two turns ago" not in section
    # An auto-applying tool has two ways to lie about when it acted.
    assert "already happened when the result comes back" in section
    assert "the user cannot see the tool result" in section


def test_every_new_field_of_edit_deck_has_a_worked_example() -> None:
    description = Settings().agent.tools.edit_deck_description
    # Unwrapped, because the prose is hard-wrapped in the YAML and a sentence a test
    # cares about straddles two lines of it.
    prose = " ".join(description.split())

    # A field with no example reads as dead: `edhrec_theme` was built correctly and
    # went unused until the prompt showed one.
    assert '"changes": [{"card": "Sol Ring", "quantity": 1}]' in description
    # The cut, which is the whole reason `quantity` is required and 0 is meaningful.
    assert '{"card": "Wayfarer\'s Bauble", "quantity": 0}' in description
    # `zone`, which is otherwise invisible: it is the only way to set a commander, and
    # the agent could not set one at all while the prose described this field as a custom
    # group that "has to be one that already exists" — an empty command zone is not one.
    assert '"zone": "commander"' in description
    assert '"zone": "deck"' in description
    # The value the model must not have to guess at. `zone` is an enum in the schema, so a
    # third word is a rejected call rather than a silent mainboard.
    assert "`commander` to put the card in the command zone" in prose
    # And the swap, because one intent is one call rather than two.
    assert description.count('"reason"') >= 5
    assert "`0` removes the card entirely" in prose
    tools = Settings().agent.tools
    for setting in ("limit", "1 to 50"):
        assert setting in tools.read_history_description
    # The advertised default has to be the live one. `limit` is deliberately `None` in the
    # schema so the config setting stays in charge, which means this prose is the only place
    # the model can learn the number — and nothing else compares the two, so changing the
    # setting would leave the description lying to the model with the suite still green.
    assert (
        f"defaults to {tools.read_history_default_sessions}"
        in tools.read_history_description
    )
    # The marker the tool renders has to be the marker the description explains, or the
    # model reads `(undone)` in a result and has been told nothing about what it means.
    assert "`(undone)`" in tools.read_history_description
    assert "the deck does not have it now" in " ".join(
        tools.read_history_description.split()
    )


def test_agent_settings_reject_a_blank_prompt_and_an_unknown_effort() -> None:
    with pytest.raises(ValidationError):
        DeckAgentSettings(system_prompt="   ")
    with pytest.raises(ValidationError):
        DeckAgentSettings(reasoning_effort="ultrahigh")
    with pytest.raises(ValidationError):
        DeckAgentSettings(unknown_option=True)


class StubToolbox:
    """Answer every tool call with fixed text, recording what was asked."""

    def __init__(
        self,
        *,
        enabled: bool = True,
        content: str | None = None,
        edit: DeckAgentDeckEdit | None = None,
        ok: bool = True,
    ) -> None:
        self.enabled = enabled
        self.content = content
        self.calls: list[tuple[object, object]] = []
        self.decks: list[Any] = []
        self.histories: list[Any] = []
        self.resolved_names: list[list[str]] = []
        self._edit = edit
        self._ok = ok

    def definitions(self) -> list[dict[str, Any]]:
        return [
            {"type": "function", "function": {"name": "read_deck", "parameters": {}}},
            {"type": "function", "function": {"name": "see_cards", "parameters": {}}},
        ]

    async def run(
        self,
        name: object,
        arguments: object,
        *,
        deck: Any,
        history: Any = None,
    ) -> Any:
        self.calls.append((name, arguments))
        self.decks.append(deck)
        self.histories.append(history)
        return ToolOutcome(
            signature=f"{name}()",
            content=self.content if self.content is not None else f"{name} said something.",
            ok=self._ok,
            edit=self._edit,
        )

    async def oracle_ids_for_names(self, names: list[str]) -> dict[str, UUID]:
        self.resolved_names.append(list(names))
        # A stand-in catalog: it knows two cards and, like the real one, has never
        # heard of a mana symbol.
        known = {
            "sol ring": UUID("22222222-2222-4222-8222-222222222222"),
            "ghalta, primal hunger": UUID("11111111-1111-4111-8111-111111111111"),
        }
        return {
            name.casefold(): known[name.casefold()]
            for name in names
            if name.casefold() in known
        }


def _tool_call_response(
    name: str,
    arguments: str = "{}",
    *,
    cost: float | None = None,
    call_id: str = "call-1",
) -> dict[str, Any]:
    usage: dict[str, Any] = {"prompt_tokens": 10, "completion_tokens": 5}
    if cost is not None:
        usage["cost"] = cost
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": arguments},
                        }
                    ],
                }
            }
        ],
        "usage": usage,
    }


def _answer_response(text: str, *, cost: float | None = None) -> dict[str, Any]:
    usage: dict[str, Any] = {"prompt_tokens": 10, "completion_tokens": 5}
    if cost is not None:
        usage["cost"] = cost
    return {
        "choices": [{"message": {"role": "assistant", "content": text}}],
        "usage": usage,
    }


def test_service_runs_a_tool_then_answers_from_its_result() -> None:
    client = StubModelClient(
        [
            _tool_call_response("read_deck", cost=0.0002),
            _answer_response("Ghalta wants more ramp.", cost=0.0007),
        ]
    )
    toolbox = StubToolbox()
    deck = DeckAgentDeckSnapshot(name="Ghalta Stompy", cards=[])
    service = DeckAgentService(
        model_client=client,
        settings=_settings(),
        toolbox=toolbox,
    )

    reply = asyncio.run(
        service.chat(
            DeckAgentChatRequest(
                messages=[DeckAgentMessage(role="user", content="What is missing?")],
                deck=deck,
            )
        )
    )

    assert reply.message.content == "Ghalta wants more ramp."
    # The user sees exactly this line in the chat, so it is part of the contract.
    assert [call.signature for call in reply.tool_calls] == ["read_deck()"]
    assert reply.tool_calls[0].ok is True
    # A turn that used a tool paid for two completions, not one.
    assert reply.cost_usd == pytest.approx(0.0009)
    assert reply.unpriced_call_count == 0
    assert toolbox.calls == [("read_deck", {})]
    # The tool reads the deck posted with this turn; the backend holds none.
    assert toolbox.decks == [deck]

    # The tool result has to go back as a `tool` message answering the call id, or
    # the next request is rejected as an incomplete conversation.
    second = client.payloads[1]["messages"]
    assert second[-2]["role"] == "assistant"
    assert second[-2]["tool_calls"][0]["id"] == "call-1"
    assert second[-1] == {
        "role": "tool",
        "tool_call_id": "call-1",
        "content": "read_deck said something.",
    }


def test_service_advertises_both_tools_only_while_rounds_remain() -> None:
    client = StubModelClient(
        [
            _tool_call_response("read_deck"),
            _tool_call_response("see_cards", '{"cards": ["Sol Ring"]}'),
            _answer_response("Answered at last."),
        ]
    )
    service = DeckAgentService(
        model_client=client,
        settings=_settings(tools={"max_iterations": 3}),
        toolbox=StubToolbox(),
    )

    reply = asyncio.run(service.chat(_request("What is missing?")))

    assert [call.name for call in reply.tool_calls] == ["read_deck", "see_cards"]
    assert client.payloads[0]["tool_choice"] == "auto"
    assert len(client.payloads[0]["tools"]) == 2
    assert reply.message.content == "Answered at last."


def test_a_model_that_never_stops_calling_tools_still_answers() -> None:
    # Every completion asks for another tool, so the rounds run out.
    client = StubModelClient([_tool_call_response("read_deck")] * 3)
    client._responses.append(_answer_response("Fine, here is the answer."))
    service = DeckAgentService(
        model_client=client,
        settings=_settings(tools={"max_iterations": 3}),
        toolbox=StubToolbox(),
    )

    reply = asyncio.run(service.chat(_request("What is missing?")))

    # The last pass advertises no tools, so the turn ends in prose rather than in
    # nothing the user can read.
    assert reply.message.content == "Fine, here is the answer."
    assert len(client.payloads) == 4
    assert "tools" not in client.payloads[-1]
    assert len(reply.tool_calls) == 3

    # And it is told so, not only shown so. Measured against the real model: a
    # conversation ending in tool results with the toolbox silently gone got the next
    # tool call written into the answer as prose in 5 of 5 forced final passes.
    #
    # The whole conversation is still there under it — the instruction is appended for
    # this one call rather than replacing what the model has read.
    final = client.payloads[-1]["messages"]
    assert final[-1] == {
        "role": "system",
        "content": DeckAgentSettings().tools.final_pass_instruction,
    }
    assert [message["role"] for message in final[:2]] == ["system", "user"]
    # ...and only there. A round that still has tools left is not told it has none.
    for payload in client.payloads[:-1]:
        assert all(
            message["content"] != final[-1]["content"] for message in payload["messages"]
        )


def test_service_rejects_a_tool_call_written_as_prose() -> None:
    # The failure the final-pass instruction exists to prevent, arriving anyway. This
    # is the model's own routing syntax with the provider's special tokens stripped,
    # copied from a real reply: it validates as a successful completion and is not
    # something a person can read, which is the same contract error as an empty one.
    client = StubModelClient(
        [
            _answer_response(
                'to=search_local_cards  (json)\n'
                '{"semantic_sort":"mana rock, ramp","sort_by":"weighted"}'
            )
        ]
    )
    service = DeckAgentService(model_client=client, settings=_settings())

    with pytest.raises(DeckAgentUnavailable) as error:
        asyncio.run(service.chat(_request("What ramp should I add?")))

    assert error.value.contract_error is True


def test_service_keeps_an_answer_that_merely_mentions_a_tool() -> None:
    # The near miss that a looser rule would eat. An answer wrongly rejected is worse
    # than the failure above, which the instruction already prevents, so the test is
    # shapes prose cannot contain — not the tool names, which prose says all the time.
    client = StubModelClient(
        [
            _answer_response(
                "I read your deck with read_deck() and looked {Sol Ring} up. "
                "The ramp to add is {Fellwar Stone}."
            )
        ]
    )
    service = DeckAgentService(model_client=client, settings=_settings())

    reply = asyncio.run(service.chat(_request("What ramp should I add?")))

    assert reply.message.content.startswith("I read your deck with read_deck()")


def test_tools_are_not_advertised_when_the_toolbox_is_disabled() -> None:
    client = StubModelClient()
    service = DeckAgentService(
        model_client=client,
        settings=_settings(),
        toolbox=StubToolbox(enabled=False),
    )

    reply = asyncio.run(service.chat(_request("Hello")))

    assert reply.tool_calls == []
    assert "tools" not in client.payloads[0]


def test_a_failed_tool_is_reported_without_failing_the_turn() -> None:
    class FailingToolbox(StubToolbox):
        async def run(
            self,
            name: object,
            arguments: object,
            *,
            deck: Any,
            history: Any = None,
        ) -> Any:
            self.calls.append((name, arguments))
            return ToolOutcome(
                signature="read_deck()",
                content="The local card catalog is unavailable.",
                ok=False,
                detail="catalog unavailable",
            )

    client = StubModelClient(
        [
            _tool_call_response("read_deck"),
            _answer_response("I could not read the deck, so tell me the commander."),
        ]
    )
    service = DeckAgentService(
        model_client=client,
        settings=_settings(),
        toolbox=FailingToolbox(),
    )

    reply = asyncio.run(service.chat(_request("What is missing?")))

    assert reply.tool_calls[0].ok is False
    assert reply.tool_calls[0].detail == "catalog unavailable"
    assert "tell me the commander" in reply.message.content
    # The failure text is what the model gets to read and adapt to.
    assert client.payloads[1]["messages"][-1]["content"] == (
        "The local card catalog is unavailable."
    )


def test_a_part_priced_turn_counts_what_it_could_not_price() -> None:
    client = StubModelClient(
        [
            _tool_call_response("read_deck", cost=0.0002),
            _answer_response("Done."),
        ]
    )
    service = DeckAgentService(
        model_client=client,
        settings=_settings(),
        toolbox=StubToolbox(),
    )

    reply = asyncio.run(service.chat(_request("What is missing?")))

    # Summing only what was reported would total silently low, so the gap is counted.
    assert reply.cost_usd == pytest.approx(0.0002)
    assert reply.unpriced_call_count == 1


def test_malformed_tool_arguments_reach_the_toolbox_rather_than_being_dropped() -> None:
    client = StubModelClient(
        [
            _tool_call_response("see_cards", "{not json"),
            _answer_response("Retried and answered."),
        ]
    )
    toolbox = StubToolbox()
    service = DeckAgentService(
        model_client=client,
        settings=_settings(),
        toolbox=toolbox,
    )

    reply = asyncio.run(service.chat(_request("What is missing?")))

    # Silently ignoring the request would just make the model repeat it; handing the
    # raw string on lets the toolbox answer with a correction it can read.
    assert toolbox.calls == [("see_cards", "{not json")]
    assert reply.message.content == "Retried and answered."


def test_deck_snapshot_contract_bounds_what_a_client_may_post() -> None:
    card = {
        "scryfall_id": "aaaaaaaa-2222-4222-8222-222222222222",
        "quantity": 1,
        "section": "mainboard",
    }
    assert DeckAgentDeckSnapshot(name="Deck", cards=[card]).cards[0].quantity == 1
    # A deck is optional: a client with none open still chats.
    assert DeckAgentChatRequest(
        messages=[DeckAgentMessage(role="user", content="Hi")]
    ).deck is None
    for invalid in (
        {**card, "section": "sideboard"},
        {**card, "quantity": 0},
        {**card, "unknown": True},
    ):
        with pytest.raises(ValidationError):
            DeckAgentDeckSnapshot(name="Deck", cards=[invalid])
    with pytest.raises(ValidationError):
        DeckAgentDeckSnapshot(name="   ", cards=[])


def _session(edits: int = 1) -> DeckAgentDeckSession:
    return DeckAgentDeckSession(
        actor="user",
        started_at="2026-08-01T14:02:00+02:00",
        ended_at="2026-08-01T14:06:00+02:00",
        edits=[
            DeckAgentDeckHistoryEdit(
                at="2026-08-01T14:02:00+02:00",
                cards=[
                    DeckAgentDeckHistoryChange(
                        name="Sol Ring",
                        after=DeckAgentDeckPlacement(quantity=1, section="mainboard"),
                    )
                ],
            )
            for _ in range(edits)
        ],
    )


def test_history_contract_bounds_what_a_client_may_post() -> None:
    # Optional, like the deck: a client that records no history still chats, and the
    # tool reports which of the two it is rather than pretending the deck has no past.
    assert DeckAgentChatRequest(
        messages=[DeckAgentMessage(role="user", content="Hi")]
    ).history is None
    inside = DeckAgentChatRequest(
        messages=[DeckAgentMessage(role="user", content="Hi")],
        history=DeckAgentDeckHistory(sessions=[_session()] * MAX_HISTORY_SESSIONS),
    )
    assert inside.history is not None
    assert len(inside.history.sessions) == MAX_HISTORY_SESSIONS

    with pytest.raises(ValidationError):
        DeckAgentDeckHistory(sessions=[_session()] * (MAX_HISTORY_SESSIONS + 1))
    # Both bounds are needed: fifty sessions of ten edits is a body worth carrying and
    # fifty sessions of five hundred edits is not, so the total is bounded too.
    with pytest.raises(ValidationError):
        DeckAgentDeckHistory(
            sessions=[_session(edits=MAX_HISTORY_EDITS // 4) for _ in range(5)]
        )
    # A change that carries neither a before nor an after records nothing at all.
    with pytest.raises(ValidationError):
        DeckAgentDeckHistoryChange(name="Sol Ring")


def test_the_open_deck_and_its_history_both_reach_the_tools() -> None:
    client = StubModelClient(
        [_tool_call_response("read_deck"), _answer_response("Two rocks went in.")]
    )
    toolbox = StubToolbox()
    deck = DeckAgentDeckSnapshot(name="Gruul Stompy", cards=[])
    posted = DeckAgentDeckHistory(sessions=[_session()])
    service = DeckAgentService(
        model_client=client, settings=_settings(), toolbox=toolbox
    )

    asyncio.run(
        service.chat(
            DeckAgentChatRequest(
                messages=[DeckAgentMessage(role="user", content="What changed?")],
                deck=deck,
                history=posted,
            )
        )
    )

    # The backend holds neither, so both are posted with the turn and threaded through
    # to whichever tool asks for them.
    assert toolbox.decks == [deck]
    assert toolbox.histories == [posted]


def _an_edit() -> DeckAgentDeckEdit:
    return DeckAgentDeckEdit(
        deck_name="Gruul Stompy",
        reason="one more rock",
        changes=[
            DeckAgentDeckEditChange(
                scryfall_id=UUID("aaaaaaaa-2222-4222-8222-222222222222"),
                name="Sol Ring",
                quantity=0,
                previous_quantity=1,
            )
        ],
    )


def test_a_deck_edit_travels_as_its_own_event_beside_the_tool_line() -> None:
    client = StubStreamingClient(
        [[_tool_chunk("edit_deck", "{}")], _text_chunks("Done — Sol Ring is out.")]
    )
    service = DeckAgentService(
        model_client=client,
        settings=_settings(),
        toolbox=StubToolbox(edit=_an_edit()),
    )

    events = _collect(_request("Cut the weakest rock."), service)

    # Beside the tool line rather than with the answer: nothing has changed in the
    # browser until it acts on this, and the result the model is about to read already
    # says the edit happened.
    assert [type(event).__name__ for event in events] == [
        "DeckAgentToolEvent",
        "DeckAgentDeckEditEvent",
        "DeckAgentTextEvent",
        "DeckAgentDoneEvent",
    ]
    assert events[1].type == "deck_edit"
    assert events[1].edit.changes[0].name == "Sol Ring"


def test_no_deck_edit_event_for_a_turn_that_changed_nothing_or_failed() -> None:
    def kinds(toolbox: StubToolbox) -> list[str]:
        client = StubStreamingClient(
            [[_tool_chunk("edit_deck", "{}")], _text_chunks("Nothing to do.")]
        )
        service = DeckAgentService(
            model_client=client, settings=_settings(), toolbox=toolbox
        )
        return [
            type(event).__name__
            for event in _collect(_request("Cut the weakest rock."), service)
        ]

    # A tool that carried no edit changed nothing, and a failed call changed nothing
    # either — applying an edit for one would leave history recording an intent that
    # did not happen.
    assert "DeckAgentDeckEditEvent" not in kinds(StubToolbox())
    assert "DeckAgentDeckEditEvent" not in kinds(StubToolbox(edit=_an_edit(), ok=False))


def test_the_stream_route_frames_a_deck_edit_as_its_own_event() -> None:
    client = StubStreamingClient(
        [[_tool_chunk("edit_deck", "{}")], _text_chunks("Sol Ring is out.")]
    )
    with TestClient(create_app()) as http:
        http.app.state.deck_agent = DeckAgentService(
            model_client=client,
            settings=_settings(),
            toolbox=StubToolbox(edit=_an_edit()),
        )
        with http.stream(
            "POST",
            "/api/v1/agent/chat/stream",
            json={"messages": [{"role": "user", "content": "Cut a rock."}]},
        ) as response:
            assert response.status_code == 200
            events = _read_sse(response.iter_lines())

    assert [event["type"] for event in events] == ["tool", "deck_edit", "text", "done"]
    edit = events[1]["edit"]
    assert edit["reason"] == "one more rock"
    assert edit["changes"][0]["previous_quantity"] == 1
    # Serialized without `exclude_none`, so an absent payload stays visibly null rather
    # than becoming a field the browser has to guess about.
    assert edit["changes"][0]["card"] is None


def test_a_tool_calls_payloads_are_taken_from_the_call_that_ran() -> None:
    client = StubModelClient(
        [
            _tool_call_response("see_cards", '{"cards": ["Sol Ring"]}'),
            _answer_response("Sol Ring costs one."),
        ]
    )
    service = DeckAgentService(
        model_client=client,
        settings=_settings(),
        toolbox=StubToolbox(),
    )

    reply = asyncio.run(
        service.chat(
            DeckAgentChatRequest(
                messages=[DeckAgentMessage(role="user", content="What does it cost?")],
                debug=True,
            )
        )
    )

    call = reply.tool_calls[0]
    # Taken from the call that ran, so neither the chat nor the next turn's replay can
    # show arguments the model never sent, or a result it never read. `debug` is still
    # accepted and no longer decides whether they travel — the control for that is
    # `test_a_turn_that_asked_for_no_debug_carries_its_payloads_anyway`.
    assert json.loads(call.arguments_json or "") == {"cards": ["Sol Ring"]}
    assert call.result == "see_cards said something."


def test_a_turn_that_asked_for_no_debug_carries_its_payloads_anyway() -> None:
    """The behaviour this replaces: payloads used to travel only for a debug turn.

    They travel on every turn now, because which turn the user interrupts is not
    knowable in advance and the next turn replays that one's calls rather than paying
    for the same lookups again. `debug` still rides along — the browser uses it to
    decide what it shows — and no longer decides what comes back.
    """

    client = StubModelClient(
        [
            _tool_call_response("read_deck"),
            _answer_response("You are light on ramp."),
        ]
    )
    service = DeckAgentService(
        model_client=client,
        settings=_settings(),
        toolbox=StubToolbox(),
    )

    reply = asyncio.run(service.chat(_request("What is missing?")))

    call = reply.tool_calls[0]
    assert call.signature == "read_deck()"
    assert call.arguments_json == "{}"
    assert call.result == "read_deck said something."
    # Without the provider's own id the pair cannot be handed back at all: an
    # `assistant.tool_calls` entry and its `tool` message are matched by it.
    assert call.id == "call-1"


def test_malformed_arguments_are_shown_as_they_arrived() -> None:
    client = StubModelClient(
        [
            _tool_call_response("see_cards", "{not json"),
            _answer_response("Retried and answered."),
        ]
    )
    service = DeckAgentService(
        model_client=client,
        settings=_settings(),
        toolbox=StubToolbox(),
    )

    reply = asyncio.run(
        service.chat(
            DeckAgentChatRequest(
                messages=[DeckAgentMessage(role="user", content="What is missing?")],
                debug=True,
            )
        )
    )

    # A call that could not be parsed is the one most worth reading, so it is shown
    # verbatim rather than rendered as an empty object.
    assert reply.tool_calls[0].arguments_json == "{not json"


def test_an_oversized_tool_result_is_truncated_inside_the_contract() -> None:
    overflowing = "x" * (MAX_TOOL_PAYLOAD_CHARS + 5_000)
    client = StubModelClient(
        [
            _tool_call_response("read_deck"),
            _answer_response("That is a big deck."),
        ]
    )
    service = DeckAgentService(
        model_client=client,
        settings=_settings(),
        toolbox=StubToolbox(content=overflowing),
    )

    reply = asyncio.run(
        service.chat(
            DeckAgentChatRequest(
                messages=[DeckAgentMessage(role="user", content="Read my deck.")],
                debug=True,
            )
        )
    )

    result = reply.tool_calls[0].result or ""
    assert len(result) == MAX_TOOL_PAYLOAD_CHARS
    # Silently cutting it would show a listing that looks complete and is not.
    assert result.endswith("characters more")
    assert "5,000" in result
    # The model still read the whole thing; only the copy sent back is trimmed.
    assert client.payloads[1]["messages"][-1]["content"] == overflowing


class StubStreamingClient:
    """Answer each completion with a fixed list of streamed chunks."""

    def __init__(self, rounds: list[list[dict[str, Any]]]) -> None:
        self._rounds = list(rounds)
        self.payloads: list[dict[str, Any]] = []

    async def stream_chat_completion(
        self,
        payload: dict[str, Any],
    ) -> AsyncIterator[dict[str, Any]]:
        self.payloads.append(payload)
        chunks = self._rounds[min(len(self.payloads) - 1, len(self._rounds) - 1)]
        for chunk in chunks:
            yield chunk


class FakeStreamResponse:
    """An SSE body read one line at a time, the way the client reads a socket."""

    def __init__(self, lines: list[bytes]) -> None:
        self._lines = list(lines)
        self.closed = False

    def readline(self) -> bytes:
        return self._lines.pop(0) if self._lines else b""

    def close(self) -> None:
        self.closed = True


def _text_chunks(*pieces: str) -> list[dict[str, Any]]:
    return [{"choices": [{"delta": {"content": piece}}]} for piece in pieces]


def _tool_chunk(
    name: str,
    arguments: str,
    *,
    call_id: str = "call-1",
    index: int = 0,
) -> dict[str, Any]:
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": index,
                            "id": call_id,
                            "function": {"name": name, "arguments": arguments},
                        }
                    ]
                }
            }
        ]
    }


def _collect(request: DeckAgentChatRequest, service: DeckAgentService) -> list[Any]:
    async def drain() -> list[Any]:
        return [event async for event in service.stream(request)]

    return asyncio.run(drain())


def test_streaming_client_reads_chunks_and_ignores_keep_alives() -> None:
    opened: list[Any] = []
    response = FakeStreamResponse(
        [
            b": OPENROUTER PROCESSING\n",
            b"\n",
            b'data: {"choices": [{"delta": {"content": "Sol "}}]}\n',
            b"data: not json\n",
            b'data: {"choices": [{"delta": {"content": "Ring."}}]}\n',
            b"data: [DONE]\n",
            b'data: {"choices": [{"delta": {"content": "never read"}}]}\n',
        ]
    )

    def open_url(request: Any, *, timeout: float) -> FakeStreamResponse:
        opened.append(request)
        return response

    client = OpenRouterClient(
        api_key="test-key",
        base_url="https://openrouter.test/api/v1",
        timeout_seconds=5.0,
        open_url=open_url,
    )

    async def drain() -> list[dict[str, Any]]:
        return [chunk async for chunk in client.stream_chat_completion({"model": "m"})]

    chunks = asyncio.run(drain())

    # A keep-alive comment and an unparsable line are ordinary traffic, not faults;
    # `[DONE]` ends the stream, so nothing after it is read.
    assert [chunk["choices"][0]["delta"]["content"] for chunk in chunks] == [
        "Sol ",
        "Ring.",
    ]
    assert response.closed is True
    assert json.loads(opened[0].data)["stream"] is True


def test_streaming_client_raises_an_error_chunk() -> None:
    response = FakeStreamResponse(
        [b'data: {"error": {"message": "rate limited", "code": 429}}\n']
    )
    client = OpenRouterClient(
        api_key="test-key",
        base_url="https://openrouter.test/api/v1",
        timeout_seconds=5.0,
        open_url=lambda *_args, **_kwargs: response,
    )

    async def drain() -> None:
        async for _chunk in client.stream_chat_completion({"model": "m"}):
            pass

    # The HTTP status was spent on 200 before this arrived, so the error is in-band.
    with pytest.raises(OpenRouterError, match="rate limited"):
        asyncio.run(drain())


def test_stream_reports_each_tool_call_before_the_answer_it_produced() -> None:
    client = StubStreamingClient(
        [
            [_tool_chunk("read_deck", "{}")],
            _text_chunks("You are light ", "on ramp."),
        ]
    )
    service = DeckAgentService(
        model_client=client,
        settings=_settings(),
        toolbox=StubToolbox(),
    )

    events = _collect(_request("What is missing?"), service)

    # The whole point: the call is announced while it runs, not with the answer.
    assert [type(event).__name__ for event in events] == [
        "DeckAgentToolEvent",
        "DeckAgentTextEvent",
        "DeckAgentTextEvent",
        "DeckAgentDoneEvent",
    ]
    assert events[0].call.signature == "read_deck()"
    # What streamed is exactly what the turn committed, so the panel cannot show one
    # answer while it arrives and a different one once it lands.
    assert "".join(event.content for event in events[1:3]) == "You are light on ramp."
    assert events[-1].reply.message.content == "You are light on ramp."
    assert [call.signature for call in events[-1].reply.tool_calls] == ["read_deck()"]


def test_stream_assembles_a_tool_call_split_across_chunks() -> None:
    client = StubStreamingClient(
        [
            [
                # The id and name arrive first, then the arguments a few characters
                # at a time, keyed only by index.
                _tool_chunk("see_cards", ""),
                _tool_chunk("", '{"cards": ', call_id=""),
                _tool_chunk("", '["Sol Ring"]}', call_id=""),
            ],
            _text_chunks("One mana."),
        ]
    )
    toolbox = StubToolbox()
    service = DeckAgentService(
        model_client=client,
        settings=_settings(),
        toolbox=toolbox,
    )

    events = _collect(_request("What does Sol Ring cost?"), service)

    assert toolbox.calls == [("see_cards", {"cards": ["Sol Ring"]})]
    assert events[-1].reply.message.content == "One mana."
    # The reassembled call has to be echoed back with its id, or the next request is
    # rejected as an incomplete conversation.
    echoed = client.payloads[1]["messages"][-2]
    assert echoed["tool_calls"][0]["id"] == "call-1"
    assert client.payloads[1]["messages"][-1]["tool_call_id"] == "call-1"


def test_stream_totals_the_cost_reported_on_a_final_usage_chunk() -> None:
    client = StubStreamingClient(
        [
            [
                _tool_chunk("read_deck", "{}"),
                {"choices": [], "usage": {"cost": 0.0002}},
            ],
            [*_text_chunks("Ramp."), {"choices": [], "usage": {"cost": 0.0007}}],
        ]
    )
    service = DeckAgentService(
        model_client=client,
        settings=_settings(),
        toolbox=StubToolbox(),
    )

    reply = _collect(_request("What is missing?"), service)[-1].reply

    # Usage arrives on its own chunk at the end of each completion, and a turn that
    # used a tool paid for two of them.
    assert reply.cost_usd == pytest.approx(0.0009)
    assert reply.unpriced_call_count == 0
    assert client.payloads[0]["usage"] == {"include": True}


def test_stream_route_sends_events_then_the_finished_reply() -> None:
    client = StubStreamingClient(
        [
            [_tool_chunk("read_deck", "{}")],
            _text_chunks("Ghalta ", "wants ramp."),
        ]
    )
    with TestClient(create_app()) as http:
        http.app.state.deck_agent = DeckAgentService(
            model_client=client,
            settings=_settings(),
            toolbox=StubToolbox(),
        )
        with http.stream(
            "POST",
            "/api/v1/agent/chat/stream",
            json={"messages": [{"role": "user", "content": "What is missing?"}]},
        ) as response:
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")
            events = _read_sse(response.iter_lines())

    assert [event["type"] for event in events] == ["tool", "text", "text", "done"]
    assert events[0]["call"]["signature"] == "read_deck()"
    assert events[-1]["reply"]["message"]["content"] == "Ghalta wants ramp."
    # Serialized without `exclude_none`, so the streamed reply has the same shape as
    # the JSON route's and an unreported cost stays visibly null.
    assert events[-1]["reply"]["cost_usd"] is None


def test_stream_route_reports_an_unconfigured_agent_before_streaming() -> None:
    with TestClient(create_app()) as http:
        http.app.state.deck_agent = DeckAgentService(
            model_client=None,
            settings=_settings(),
        )
        response = http.post(
            "/api/v1/agent/chat/stream",
            json={"messages": [{"role": "user", "content": "Hello"}]},
        )

    # Not an event: nothing has been sent yet, so this can still be an HTTP failure.
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "deck_agent_unavailable"


def test_stream_route_turns_a_late_failure_into_an_error_event() -> None:
    class BrokenStream:
        async def stream_chat_completion(
            self,
            payload: dict[str, Any],
        ) -> AsyncIterator[dict[str, Any]]:
            yield {"choices": [{"delta": {"content": "Sol "}}]}
            raise OpenRouterError("OpenRouter could not be reached")

    with TestClient(create_app()) as http:
        http.app.state.deck_agent = DeckAgentService(
            model_client=BrokenStream(),
            settings=_settings(),
        )
        with http.stream(
            "POST",
            "/api/v1/agent/chat/stream",
            json={"messages": [{"role": "user", "content": "Hello"}]},
        ) as response:
            assert response.status_code == 200
            events = _read_sse(response.iter_lines())

    # The status code was already 200 by the time this happened, so the failure has
    # to travel in-band — with the same wording the JSON route would have used.
    assert [event["type"] for event in events] == ["text", "error"]
    assert events[-1]["code"] == "deck_agent_unavailable"
    assert events[-1]["message"] == "The deck agent is temporarily unavailable."


def test_stream_route_reports_an_empty_answer_as_a_contract_error_event() -> None:
    client = StubStreamingClient([[{"choices": [{"delta": {"content": ""}}]}]])
    with TestClient(create_app()) as http:
        http.app.state.deck_agent = DeckAgentService(
            model_client=client,
            settings=_settings(),
        )
        with http.stream(
            "POST",
            "/api/v1/agent/chat/stream",
            json={"messages": [{"role": "user", "content": "Hello"}]},
        ) as response:
            events = _read_sse(response.iter_lines())

    # A reasoning model can spend the whole turn thinking and stream no text at all.
    assert [event["type"] for event in events] == ["error"]
    assert events[-1]["code"] == "deck_agent_contract_error"


def _read_sse(lines: Any) -> list[dict[str, Any]]:
    """Parse a server-sent-event body into its JSON payloads."""

    return [
        json.loads(line[len("data:") :].strip())
        for line in lines
        if line.startswith("data:")
    ]


def test_settings_load_the_repository_tool_yaml() -> None:
    tools = Settings().agent.tools

    assert tools.enabled is True
    assert tools.max_iterations >= 1
    # The shipped instruction, not the code default. They are the same words today and
    # are two separate strings — the test above pins the wiring to whatever the service
    # was given, so nothing there would notice `config.yaml` losing this. Without one,
    # the turn goes back to ending in a tool call written out as prose.
    assert "Do not write a tool call." in tools.final_pass_instruction
    assert tools.see_cards_max_cards >= 1
    assert tools.see_cards_default_details == ["rules"]


def _answering(text: str) -> StubModelClient:
    return StubModelClient(
        [{"choices": [{"message": {"role": "assistant", "content": text}}]}]
    )


def test_braced_card_names_come_back_resolved_in_the_order_they_were_written() -> None:
    toolbox = StubToolbox()
    service = DeckAgentService(
        model_client=_answering(
            "Play {Ghalta, Primal Hunger} behind {Sol Ring}, not {Sol Rong}."
        ),
        settings=_settings(),
        toolbox=toolbox,
    )

    reply = asyncio.run(service.chat(_request("What ramp?")))

    # Reading order, because the interface renders them where they were written.
    assert [link.name for link in reply.card_links] == ["Ghalta, Primal Hunger", "Sol Ring"]
    # A name the catalog does not know yields no link rather than a broken one.
    assert "Sol Rong" not in [link.name for link in reply.card_links]


def test_a_mana_symbol_is_not_mistaken_for_a_card() -> None:
    toolbox = StubToolbox()
    service = DeckAgentService(
        model_client=_answering("{Sol Ring} taps for {C}{C}, and {T} is a tap."),
        settings=_settings(),
        toolbox=toolbox,
    )

    reply = asyncio.run(service.chat(_request("What ramp?")))

    # Braces meant mana long before they meant a link, and the agent quotes rules
    # text. The catalog is what settles it: no card is called "C".
    assert [link.name for link in reply.card_links] == ["Sol Ring"]
    # Asked about anyway rather than pre-filtered — deciding what is a card by regex
    # is exactly the guess the catalog exists to replace.
    assert toolbox.resolved_names == [["Sol Ring", "C", "T"]]


def test_a_name_written_twice_is_resolved_and_returned_once() -> None:
    toolbox = StubToolbox()
    service = DeckAgentService(
        model_client=_answering("{Sol Ring} first. Always {sol ring}."),
        settings=_settings(),
        toolbox=toolbox,
    )

    reply = asyncio.run(service.chat(_request("What ramp?")))

    # One card, one link, whatever case it was written in the second time.
    assert len(reply.card_links) == 1
    assert toolbox.resolved_names == [["Sol Ring"]]


def test_an_answer_full_of_braces_is_capped_rather_than_queried_forever() -> None:
    toolbox = StubToolbox()
    names = " ".join(f"{{Card {index}}}" for index in range(MAX_CARD_LINKS + 20))
    service = DeckAgentService(
        model_client=_answering(names), settings=_settings(), toolbox=toolbox
    )

    asyncio.run(service.chat(_request("Name everything.")))

    assert len(toolbox.resolved_names[0]) == MAX_CARD_LINKS


def test_a_turn_without_a_toolbox_still_answers_without_links() -> None:
    service = DeckAgentService(model_client=_answering("Play {Sol Ring}."), settings=_settings())

    reply = asyncio.run(service.chat(_request("What ramp?")))

    # Links are an enhancement. No catalog to ask means no links, never no answer.
    assert reply.message.content == "Play {Sol Ring}."
    assert reply.card_links == []


def test_the_streamed_done_event_carries_the_same_links() -> None:
    service = DeckAgentService(
        model_client=StubStreamingClient([_text_chunks("Play {Sol Ring}.")]),
        settings=_settings(),
        toolbox=StubToolbox(),
    )

    events = _collect(_request("What ramp?"), service)

    # Nothing the interface keeps may depend on which route produced it.
    done = events[-1]
    assert done.type == "done"
    assert [link.name for link in done.reply.card_links] == ["Sol Ring"]


def test_a_name_broken_across_two_lines_is_not_one_card() -> None:
    toolbox = StubToolbox()
    service = DeckAgentService(
        model_client=_answering("Ramp:\n- {Sol\nRing}\n- {Sol Ring}"),
        settings=_settings(),
        toolbox=toolbox,
    )

    asyncio.run(service.chat(_request("What ramp?")))

    # A brace stops at the end of its line, matching the parser the browser runs, so
    # the two sides cannot disagree about where one card name ends.
    assert toolbox.resolved_names == [["Sol Ring"]]


# --- Replaying an interrupted turn -------------------------------------------------
#
# A cancelled turn keeps the calls it made, and the next turn hands them back to the
# model rather than paying for the same lookups twice. That makes the transcript a
# carrier of tool calls and their results, which is what everything below is about.


def _call(
    identifier: str,
    name: str = "read_deck",
    *,
    arguments: str = "{}",
    revision: str | None = None,
) -> DeckAgentReplayCall:
    return DeckAgentReplayCall(
        id=identifier,
        name=name,
        arguments_json=arguments,
        deck_revision=revision,
    )


def _interrupted_transcript(
    *calls: DeckAgentReplayCall,
    results: list[str] | None = None,
    prose: str | None = None,
) -> list[DeckAgentMessage]:
    """The shape the browser posts for one interrupted turn, plus the next question."""

    answers = results or [f"{call.name} said something." for call in calls]
    messages = [
        DeckAgentMessage(role="user", content="What is missing?"),
        DeckAgentMessage(role="assistant", content=prose, tool_calls=list(calls)),
        *(
            DeckAgentMessage(role="tool", tool_call_id=call.id, content=answer)
            for call, answer in zip(calls, answers, strict=True)
        ),
        DeckAgentMessage(role="user", content="Carry on."),
    ]
    return messages


def test_a_message_must_carry_content_or_tool_calls() -> None:
    # An assistant message with neither says nothing at all.
    with pytest.raises(ValidationError):
        DeckAgentMessage(role="assistant")
    # Rule 1 is what rejects a tool message with an id and no result: the pair would
    # reach the provider as a call answered by nothing.
    with pytest.raises(ValidationError):
        DeckAgentMessage(role="tool", tool_call_id="call-1")
    # Tool calls alone are a whole message, because that is the provider's own shape
    # for an assistant turn that only called tools.
    assert DeckAgentMessage(role="assistant", tool_calls=[_call("call-1")]).content is None


def test_the_two_replay_fields_belong_to_one_role_each() -> None:
    with pytest.raises(ValidationError):
        DeckAgentMessage(role="user", content="Hi", tool_calls=[_call("call-1")])
    with pytest.raises(ValidationError):
        DeckAgentMessage(role="tool", content="Read.", tool_calls=[_call("call-1")])
    with pytest.raises(ValidationError):
        DeckAgentMessage(role="assistant", content="Hi", tool_call_id="call-1")
    with pytest.raises(ValidationError):
        DeckAgentMessage(role="user", content="Hi", tool_call_id="call-1")
    # A tool message that names no call cannot be paired with one.
    with pytest.raises(ValidationError):
        DeckAgentMessage(role="tool", content="read_deck said something.")


def test_a_replayed_tool_result_may_be_longer_than_prose_ever_is() -> None:
    """The two bounds are different because the two contents are different things.

    A five-hundred-card `read_deck` listing is three times the prose bound, and it is
    the reply's own `ToolPayloadText` coming back, so sharing the prose bound would make
    the largest decks the ones a replay silently 422s on.
    """

    listing = "x" * (MAX_MESSAGE_CHARS + 1_000)
    assert (
        len(
            DeckAgentMessage(role="tool", tool_call_id="call-1", content=listing).content
            or ""
        )
        == MAX_MESSAGE_CHARS + 1_000
    )
    # Prose keeps the bound it always had, and keeps being stripped.
    with pytest.raises(ValidationError):
        DeckAgentMessage(role="user", content=listing)
    assert DeckAgentMessage(role="user", content="  Hi  ").content == "Hi"
    # A tool result is handed back byte for byte instead: the model has to read exactly
    # what it read the first time.
    padded = DeckAgentMessage(role="tool", tool_call_id="call-1", content="  Read.\n")
    assert padded.content == "  Read.\n"
    # And it may be empty. A tool that returned nothing is a fact about the call, and
    # 422-ing the whole turn over it would fail the chat rather than bound it — prose
    # keeps the non-blank rule, which is what that rule was for.
    assert DeckAgentMessage(role="tool", tool_call_id="call-1", content="").content == ""
    with pytest.raises(ValidationError):
        DeckAgentMessage(role="assistant", content="")


def test_every_replayed_call_must_be_answered_by_id() -> None:
    # An unanswered call is exactly what an interrupted turn produces, so the message
    # names the id rather than only the count.
    with pytest.raises(ValidationError) as unanswered:
        DeckAgentChatRequest(
            messages=[
                DeckAgentMessage(role="user", content="What is missing?"),
                DeckAgentMessage(role="assistant", tool_calls=[_call("call-7")]),
                DeckAgentMessage(role="user", content="Carry on."),
            ]
        )
    assert "'call-7'" in str(unanswered.value)

    # And a result answering nothing is the same fault from the other side.
    with pytest.raises(ValidationError) as orphaned:
        DeckAgentChatRequest(
            messages=[
                DeckAgentMessage(
                    role="tool", tool_call_id="call-9", content="read_deck said so."
                ),
                DeckAgentMessage(role="user", content="Carry on."),
            ]
        )
    assert "'call-9'" in str(orphaned.value)

    # A whole pair is accepted.
    assert (
        len(DeckAgentChatRequest(messages=_interrupted_transcript(_call("call-1"))).messages)
        == 4
    )


def test_a_call_and_an_answer_that_do_not_refer_to_each_other_are_rejected() -> None:
    """The corpus that tells an id check apart from a count.

    One call and one answer, so any implementation counting them agrees. They name
    different ids, so the provider would reject the completion — which is the whole
    reason this validator exists.
    """

    with pytest.raises(ValidationError) as mismatched:
        DeckAgentChatRequest(
            messages=[
                DeckAgentMessage(role="user", content="What is missing?"),
                DeckAgentMessage(role="assistant", tool_calls=[_call("call-a")]),
                DeckAgentMessage(
                    role="tool", tool_call_id="call-b", content="read_deck said so."
                ),
                DeckAgentMessage(role="user", content="Carry on."),
            ]
        )
    assert "'call-b'" in str(mismatched.value)

    # An answer before its own call is out of order rather than merely unmatched: a
    # count is blind to that too.
    with pytest.raises(ValidationError):
        DeckAgentChatRequest(
            messages=[
                DeckAgentMessage(
                    role="tool", tool_call_id="call-a", content="read_deck said so."
                ),
                DeckAgentMessage(role="assistant", tool_calls=[_call("call-a")]),
                DeckAgentMessage(role="user", content="Carry on."),
            ]
        )

    # Two calls sharing an id cannot be paired with one answer each.
    with pytest.raises(ValidationError):
        DeckAgentChatRequest(
            messages=_interrupted_transcript(_call("call-a"), _call("call-a"))
        )


def test_the_chat_route_rejects_an_unpaired_call_with_a_422() -> None:
    with TestClient(create_app()) as client:
        client.app.state.deck_agent = DeckAgentService(
            model_client=StubModelClient(),
            settings=_settings(),
        )
        response = client.post(
            "/api/v1/agent/chat",
            json={
                "messages": [
                    {"role": "user", "content": "What is missing?"},
                    {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": "call-7",
                                "name": "read_deck",
                                "arguments_json": "{}",
                            }
                        ],
                    },
                    {"role": "user", "content": "Carry on."},
                ]
            },
        )

    # Rejected here, naming the call, rather than 502'd by the provider later.
    assert response.status_code == 422
    assert "call-7" in response.text


def test_the_memory_window_never_cuts_a_replayed_group_in_half() -> None:
    client = StubModelClient()
    service = DeckAgentService(
        model_client=client,
        settings=_settings(max_history_messages=3),
        toolbox=StubToolbox(),
    )

    reply = asyncio.run(
        service.chat(
            DeckAgentChatRequest(
                messages=_interrupted_transcript(_call("call-1"), _call("call-2"))
            )
        )
    )

    # Three would have cut between the two results. The cut moves backwards to the
    # assistant that asked for them, so the group arrives whole and one message over
    # the window rather than as an orphaned result the provider refuses outright.
    assert reply.replayed_message_count == 4
    roles = [message["role"] for message in client.payloads[0]["messages"]]
    assert roles == ["system", "assistant", "tool", "tool", "user"]


def test_the_window_only_reaches_back_when_a_kept_result_needs_it() -> None:
    """The control for the trim: an ordinary window is not widened.

    Without this, "the slice does not begin with a tool message" would be satisfied by
    an implementation that simply never trims.
    """

    client = StubModelClient()
    service = DeckAgentService(
        model_client=client, settings=_settings(max_history_messages=2)
    )

    reply = asyncio.run(service.chat(_request("first", "second", "third", "fourth")))

    assert reply.replayed_message_count == 2
    assert [message["content"] for message in client.payloads[0]["messages"][1:]] == [
        "third",
        "fourth",
    ]


def test_a_group_that_ends_before_the_window_is_left_behind_whole() -> None:
    client = StubModelClient()
    service = DeckAgentService(
        model_client=client,
        settings=_settings(max_history_messages=3),
        toolbox=StubToolbox(),
    )

    reply = asyncio.run(
        service.chat(
            DeckAgentChatRequest(
                messages=[
                    *_interrupted_transcript(_call("call-1"))[:3],
                    DeckAgentMessage(role="assistant", content="You want ramp."),
                    DeckAgentMessage(role="user", content="And what else?"),
                    DeckAgentMessage(role="assistant", content="More lands."),
                    DeckAgentMessage(role="user", content="And now?"),
                ]
            )
        )
    )

    # Nothing kept answers a call, so nothing is pulled back in: the trim widens the
    # window only for a group it would otherwise have split, and an interrupted turn
    # old enough to fall out of memory falls out of it whole.
    assert reply.replayed_message_count == 3
    assert [message["role"] for message in client.payloads[0]["messages"]] == [
        "system",
        "user",
        "assistant",
        "user",
    ]


def test_the_trim_keeps_moving_back_past_an_interleaved_group() -> None:
    """Two groups whose answers are interleaved, which the contract allows.

    An answer only has to come *later* than its call, not immediately after it, so
    pulling in one group can expose a result belonging to an older one. One hop
    backwards is not enough; this is why the trim runs to a fixpoint.
    """

    client = StubModelClient()
    service = DeckAgentService(
        model_client=client,
        settings=_settings(max_history_messages=3),
        toolbox=StubToolbox(),
    )

    reply = asyncio.run(
        service.chat(
            DeckAgentChatRequest(
                messages=[
                    DeckAgentMessage(role="assistant", tool_calls=[_call("call-a")]),
                    DeckAgentMessage(role="assistant", tool_calls=[_call("call-b")]),
                    DeckAgentMessage(
                        role="tool", tool_call_id="call-b", content="second."
                    ),
                    DeckAgentMessage(
                        role="tool", tool_call_id="call-a", content="first."
                    ),
                    DeckAgentMessage(role="user", content="Carry on."),
                ]
            )
        )
    )

    assert reply.replayed_message_count == 5
    assert client.payloads[0]["messages"][1]["tool_calls"][0]["id"] == "call-a"


def test_a_replayed_group_reaches_the_provider_in_its_own_shape() -> None:
    client = StubModelClient()
    service = DeckAgentService(
        model_client=client, settings=_settings(), toolbox=StubToolbox()
    )

    asyncio.run(
        service.chat(
            DeckAgentChatRequest(
                messages=_interrupted_transcript(
                    _call("call-1", arguments='{"extra_info": []}'),
                    _call("call-2", "see_cards", arguments='{"cards": ["Sol Ring"]}'),
                    results=["The deck holds 99.", "Sol Ring costs one."],
                    prose="Reading the deck now.",
                )
            )
        )
    )

    # Exactly the shape the completions API accepts a tool result back in, and exactly
    # the shape this loop echoes its own calls back in. The system message is asserted
    # by the replay-note test; everything after it is the transcript.
    assert client.payloads[0]["messages"][1:] == [
        {"role": "user", "content": "What is missing?"},
        {
            "role": "assistant",
            "content": "Reading the deck now.",
            "tool_calls": [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "read_deck", "arguments": '{"extra_info": []}'},
                },
                {
                    "id": "call-2",
                    "type": "function",
                    "function": {
                        "name": "see_cards",
                        "arguments": '{"cards": ["Sol Ring"]}',
                    },
                },
            ],
        },
        {"role": "tool", "tool_call_id": "call-1", "content": "The deck holds 99."},
        {"role": "tool", "tool_call_id": "call-2", "content": "Sol Ring costs one."},
        {"role": "user", "content": "Carry on."},
    ]


def test_an_assistant_message_with_no_prose_replays_as_an_empty_string() -> None:
    client = StubModelClient()
    service = DeckAgentService(
        model_client=client, settings=_settings(), toolbox=StubToolbox()
    )

    asyncio.run(
        service.chat(
            DeckAgentChatRequest(messages=_interrupted_transcript(_call("call-1")))
        )
    )

    # A cancelled turn that wrote nothing before it was stopped still has to carry its
    # calls, and the provider wants `content` present.
    assistant = client.payloads[0]["messages"][2]
    assert assistant["tool_calls"][0]["id"] == "call-1"
    assert assistant["content"] == ""


def _replay_payload(
    *calls: DeckAgentReplayCall,
    updated_at: str | None,
    results: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Run one turn over a replayed group and return what reached the provider."""

    client = StubModelClient()
    service = DeckAgentService(
        model_client=client, settings=_settings(), toolbox=StubToolbox()
    )
    asyncio.run(
        service.chat(
            DeckAgentChatRequest(
                messages=_interrupted_transcript(*calls, results=results),
                deck=DeckAgentDeckSnapshot(
                    name="Gruul Stompy", cards=[], updated_at=updated_at
                ),
            )
        )
    )
    return client.payloads[0]["messages"]


def test_a_replayed_deck_read_survives_only_while_the_deck_has_not_moved() -> None:
    unchanged = _replay_payload(
        _call("call-1", "read_deck", revision="2026-08-03T10:00:00.000Z"),
        results=["Deck \"Gruul Stompy\" — 99 cards, 99 distinct."],
        updated_at="2026-08-03T10:00:00.000Z",
    )
    moved = _replay_payload(
        _call("call-1", "read_deck", revision="2026-08-03T10:00:00.000Z"),
        results=["Deck \"Gruul Stompy\" — 99 cards, 99 distinct."],
        updated_at="2026-08-03T11:30:00.000Z",
    )

    # Byte for byte, both ways.
    assert unchanged[3]["content"] == 'Deck "Gruul Stompy" — 99 cards, 99 distinct.'
    assert moved[3]["content"] == (
        "This result is not replayed: the deck changed after it was read. "
        "Call read_deck again if you need the current deck."
    )
    assert moved[3]["content"] == STALE_REPLAY_RESULT
    # The pairing survives the substitution: the model still sees an answer to its own
    # call, which is what the provider requires and what tells it the call was made.
    assert moved[3]["tool_call_id"] == "call-1"
    assert moved[2]["tool_calls"][0]["id"] == "call-1"


def test_every_deck_dependent_tool_is_substituted_and_nothing_else_is() -> None:
    def replayed(name: str) -> str:
        messages = _replay_payload(
            _call("call-1", name, revision="2026-08-03T10:00:00.000Z"),
            results=[f"{name} said something."],
            updated_at="2026-08-03T11:30:00.000Z",
        )
        return messages[3]["content"]

    # The three whose output describes the deck.
    assert sorted(DECK_DEPENDENT_TOOLS) == ["edit_deck", "read_deck", "read_history"]
    for name in sorted(DECK_DEPENDENT_TOOLS):
        assert replayed(name) == STALE_REPLAY_RESULT

    # The control that proves the substitution is scoped: a web answer, a card's Oracle
    # text and a catalog search do not change because a card was cut, so a changed deck
    # costs them nothing.
    for name in ("search_web", "read_page", "see_cards", "search_cards"):
        assert replayed(name) == f"{name} said something."


def test_a_revision_nobody_can_vouch_for_counts_as_changed() -> None:
    """Absent is not unchanged.

    A deck-dependent call with no recorded revision, or a deck posted without one, is a
    read this turn cannot verify — and an unverifiable read of the deck is exactly the
    one worth refusing.
    """

    unreported = _replay_payload(
        _call("call-1", "read_deck"),
        updated_at="2026-08-03T10:00:00.000Z",
    )
    no_deck_revision = _replay_payload(
        _call("call-1", "read_deck", revision="2026-08-03T10:00:00.000Z"),
        updated_at=None,
    )
    neither = _replay_payload(_call("call-1", "read_deck"), updated_at=None)

    assert unreported[3]["content"] == STALE_REPLAY_RESULT
    assert no_deck_revision[3]["content"] == STALE_REPLAY_RESULT
    # Both absent is the one honest match: a client that tracks no revision at all is
    # not a client whose deck has changed.
    assert neither[3]["content"] == "read_deck said something."


def test_the_replay_note_reaches_the_model_only_when_something_is_replayed() -> None:
    replaying = StubModelClient()
    ordinary = StubModelClient()
    settings = _settings()
    asyncio.run(
        DeckAgentService(
            model_client=replaying, settings=settings, toolbox=StubToolbox()
        ).chat(DeckAgentChatRequest(messages=_interrupted_transcript(_call("call-1"))))
    )
    asyncio.run(
        DeckAgentService(model_client=ordinary, settings=settings).chat(
            _request("What is missing?")
        )
    )

    note = settings.tools.replayed_call_instruction
    assert replaying.payloads[0]["messages"][0]["content"].endswith(note)
    # A rule about interrupted turns on a turn that has none is a paragraph the model
    # has to work out is irrelevant.
    assert ordinary.payloads[0]["messages"][0]["content"] == settings.system_prompt


def test_the_replay_note_is_configuration_and_says_the_result_may_be_used() -> None:
    instruction = Settings().agent.tools.replayed_call_instruction.casefold()

    # It has to name the interruption, or a replayed call reads as somebody else's
    # evidence; and it has to say the result may be used, or the prompt's own "call
    # read_deck every turn without exception" wins and the replay saves nothing.
    assert "interrupted" in instruction
    assert "read_deck" in instruction
    assert "not replayed" in instruction


def _sheddable_turn(rounds: int, *, chars: int) -> list[DeckAgentToolCall]:
    """Run a turn of `rounds` tool calls whose results are `chars` long each."""

    client = StubModelClient(
        [
            *(
                _tool_call_response("read_deck", call_id=f"call-{index + 1}")
                for index in range(rounds)
            ),
            _answer_response("That is a big deck."),
        ]
    )
    service = DeckAgentService(
        model_client=client,
        settings=_settings(tools={"max_iterations": rounds + 1}),
        toolbox=StubToolbox(content="x" * chars),
    )
    reply = asyncio.run(service.chat(_request("Read my deck.")))
    return reply.tool_calls


def test_a_turn_sheds_its_oldest_results_to_fit_the_replay_budget() -> None:
    calls = _sheddable_turn(3, chars=MAX_TOOL_PAYLOAD_CHARS)

    # Three full payloads are 72,000 characters, so one has to go. The oldest goes
    # first, and it loses its result rather than the arguments that still let it replay
    # as framing.
    assert [call.result is None for call in calls] == [True, False, False]
    assert [call.arguments_json for call in calls] == ["{}", "{}", "{}"]
    assert (
        sum(len(call.arguments_json or "") + len(call.result or "") for call in calls)
        <= MAX_REPLAY_CHARS
    )
    # The newest lookup is the one a replay is most likely to continue from.
    assert len(calls[-1].result or "") == MAX_TOOL_PAYLOAD_CHARS


def test_the_per_payload_cap_keeps_a_pair_of_results_inside_the_budget() -> None:
    """Where the two caps meet, which is not where it looks.

    A 70,000-character pair of results never reaches the whole-turn budget: each one is
    truncated to `MAX_TOOL_PAYLOAD_CHARS` first, so the pair carries 48,000 and nothing
    is shed. It takes three calls, or a pair with arguments as large as its results, to
    reach 60,000 at all.
    """

    calls = _sheddable_turn(2, chars=35_000)

    assert [len(call.result or "") for call in calls] == [MAX_TOOL_PAYLOAD_CHARS] * 2
    assert all(call.result is not None for call in calls)
    assert all("characters more" in (call.result or "") for call in calls)


def test_arguments_are_shed_only_after_every_result_has_gone() -> None:
    client = StubModelClient(
        [
            *(
                _tool_call_response(
                    "see_cards",
                    '{"cards": ["' + "x" * (MAX_TOOL_PAYLOAD_CHARS - 20) + '"]}',
                    call_id=f"call-{index + 1}",
                )
                for index in range(3)
            ),
            _answer_response("Answered."),
        ]
    )
    service = DeckAgentService(
        model_client=client,
        settings=_settings(tools={"max_iterations": 4}),
        toolbox=StubToolbox(content="x" * MAX_TOOL_PAYLOAD_CHARS),
    )

    calls = asyncio.run(service.chat(_request("Read everything."))).tool_calls

    # Six payloads of nearly 24,000 is nearly 144,000 against a budget of 60,000, so
    # every result goes; that is still over, so arguments start going too, oldest first,
    # and it stops the moment it fits rather than emptying the turn.
    assert [call.result is None for call in calls] == [True, True, True]
    assert [call.arguments_json is None for call in calls] == [True, False, False]
    assert (
        sum(len(call.arguments_json or "") + len(call.result or "") for call in calls)
        <= MAX_REPLAY_CHARS
    )


def test_the_streamed_done_event_carries_the_shed_reply() -> None:
    client = StubStreamingClient(
        [
            [_tool_chunk("read_deck", "{}", call_id="call-1")],
            [_tool_chunk("read_deck", "{}", call_id="call-2")],
            [_tool_chunk("read_deck", "{}", call_id="call-3")],
            _text_chunks("That is a big deck."),
        ]
    )
    service = DeckAgentService(
        model_client=client,
        settings=_settings(tools={"max_iterations": 4}),
        toolbox=StubToolbox(content="x" * MAX_TOOL_PAYLOAD_CHARS),
    )

    events = _collect(_request("Read my deck."), service)

    tool_events = [event for event in events if event.type == "tool"]
    done = events[-1]
    assert done.type == "done"
    # The events carry every payload as it happens, because a turn cancelled after the
    # second one has to keep what it saw. The budget is applied to the finished reply,
    # which is what an answered turn stores.
    assert [len(event.call.result or "") for event in tool_events] == [
        MAX_TOOL_PAYLOAD_CHARS
    ] * 3
    assert [call.result is None for call in done.reply.tool_calls] == [
        True,
        False,
        False,
    ]


def test_the_streamed_tool_event_carries_the_call_id() -> None:
    """An interrupted turn commits from the stream and never sees `done`.

    So the id has to be on the `tool` event as well as on the reply: without it the
    browser has a call it cannot pair with its result, every interrupted turn degrades
    to framing-only, and the whole replay ships as its own fallback with a green suite.
    """

    service = DeckAgentService(
        model_client=StubStreamingClient(
            [
                [_tool_chunk("read_deck", "{}", call_id="call-live")],
                _text_chunks("You are light on ramp."),
            ]
        ),
        settings=_settings(),
        toolbox=StubToolbox(),
    )

    events = _collect(_request("What is missing?"), service)

    tool_event = next(event for event in events if event.type == "tool")
    assert tool_event.call.id == "call-live"
    # And the payloads it needs to replay that call, before any `done` arrives.
    assert tool_event.call.arguments_json == "{}"
    assert tool_event.call.result == "read_deck said something."


def test_the_stream_route_frames_the_call_id_and_its_payloads() -> None:
    with TestClient(create_app()) as http:
        http.app.state.deck_agent = DeckAgentService(
            model_client=StubStreamingClient(
                [
                    [_tool_chunk("read_deck", "{}", call_id="call-live")],
                    _text_chunks("You are light on ramp."),
                ]
            ),
            settings=_settings(),
            toolbox=StubToolbox(),
        )
        with http.stream(
            "POST",
            "/api/v1/agent/chat/stream",
            json={"messages": [{"role": "user", "content": "What is missing?"}]},
        ) as response:
            assert response.status_code == 200
            events = _read_sse(response.iter_lines())

    call = next(event for event in events if event["type"] == "tool")["call"]
    assert call["id"] == "call-live"
    assert call["result"] == "read_deck said something."
    # The same call arrives again in `done`, which is what an answered turn stores.
    done = events[-1]["reply"]["tool_calls"][0]
    assert done["id"] == "call-live"


def test_an_answer_may_not_be_given_twice() -> None:
    """One answer per call, which is a third shape the provider refuses.

    Neither of the other two checks sees it: the call is answered, and every answer
    answers a call. Counting sees it least of all — two answers to one call and two
    answers to two calls come to the same number.
    """

    with pytest.raises(ValidationError) as twice:
        DeckAgentChatRequest(
            messages=[
                DeckAgentMessage(role="user", content="What is missing?"),
                DeckAgentMessage(role="assistant", tool_calls=[_call("call-a")]),
                DeckAgentMessage(
                    role="tool", tool_call_id="call-a", content="read_deck said so."
                ),
                DeckAgentMessage(
                    role="tool", tool_call_id="call-a", content="read_deck said so again."
                ),
                DeckAgentMessage(role="user", content="Carry on."),
            ]
        )
    assert "'call-a'" in str(twice.value)
    assert "twice" in str(twice.value)


def test_the_chat_route_rejects_an_answer_to_no_call_with_a_422() -> None:
    """The route, not only the model: a 422 is the promise this contract makes.

    Rejecting here is the whole point — the alternative is the model host refusing the
    completion and the user reading it as the agent being down.
    """

    with TestClient(create_app()) as client:
        client.app.state.deck_agent = DeckAgentService(
            model_client=StubModelClient(),
            settings=_settings(),
        )
        response = client.post(
            "/api/v1/agent/chat",
            json={
                "messages": [
                    {
                        "role": "tool",
                        "tool_call_id": "call-9",
                        "content": "read_deck said so.",
                    },
                    {"role": "user", "content": "Carry on."},
                ]
            },
        )

    assert response.status_code == 422
    assert "call-9" in response.text


def test_the_route_bounds_an_inbound_tool_result_at_the_payload_cap() -> None:
    """The upper bound, exercised from the side that can violate it.

    `ToolPayloadText` is the only thing stopping a browser from posting a megabyte of
    replayed results, and nothing else in this suite drives a request past it — so
    retyping the field to a bare `str` would leave every other test green.
    """

    def post(chars: int) -> int:
        with TestClient(create_app()) as client:
            client.app.state.deck_agent = DeckAgentService(
                model_client=StubModelClient(),
                settings=_settings(),
            )
            return client.post(
                "/api/v1/agent/chat",
                json={
                    "messages": [
                        {"role": "user", "content": "What is missing?"},
                        {
                            "role": "assistant",
                            "tool_calls": [
                                {
                                    "id": "call-1",
                                    "name": "read_deck",
                                    "arguments_json": "{}",
                                }
                            ],
                        },
                        {
                            "role": "tool",
                            "tool_call_id": "call-1",
                            "content": "x" * chars,
                        },
                        {"role": "user", "content": "Carry on."},
                    ]
                },
            ).status_code

    # Exactly the cap is the largest result the reply was ever allowed to emit, so it
    # has to come back; one character more is a client that did not truncate.
    assert post(MAX_TOOL_PAYLOAD_CHARS) == 200
    assert post(MAX_TOOL_PAYLOAD_CHARS + 1) == 422


def test_the_trim_iterates_when_the_answers_come_in_call_order() -> None:
    """Two groups answered oldest-answer-first, which one hop backwards cannot fix.

    The hop target is the *earliest* call any kept result belongs to, so the sibling
    fixture — answers in reverse — reaches the front in a single step and would pass an
    implementation that never loops. Here the newest kept result belongs to the *newer*
    group, so one hop lands between the two calls and leaves the older answer orphaned:
    the provider gets `tool_calls` naming only `call-b`, and a `tool` message answering
    `call-a`, which is exactly what validator 3 exists to prevent and what the trim is
    for. Only iterating to a fixpoint reaches the front.
    """

    client = StubModelClient()
    service = DeckAgentService(
        model_client=client,
        settings=_settings(max_history_messages=2),
        toolbox=StubToolbox(),
    )

    reply = asyncio.run(
        service.chat(
            DeckAgentChatRequest(
                messages=[
                    DeckAgentMessage(role="assistant", tool_calls=[_call("call-a")]),
                    DeckAgentMessage(role="assistant", tool_calls=[_call("call-b")]),
                    DeckAgentMessage(
                        role="tool", tool_call_id="call-a", content="first."
                    ),
                    DeckAgentMessage(
                        role="tool", tool_call_id="call-b", content="second."
                    ),
                    DeckAgentMessage(role="user", content="Carry on."),
                ]
            )
        )
    )

    assert reply.replayed_message_count == 5
    shaped = client.payloads[0]["messages"][1:]
    asked = [
        call["id"] for message in shaped for call in message.get("tool_calls", [])
    ]
    answered = [
        message["tool_call_id"] for message in shaped if message["role"] == "tool"
    ]
    # The invariant itself rather than a message count: whatever the window did, every
    # result the provider is handed has the call it answers in front of it.
    assert asked == ["call-a", "call-b"]
    assert answered == ["call-a", "call-b"]
