"""The backend half of the cross-side seam check.

Three defects in the replay work lived only between the browser's request builder and
this side's request contract: a payload bound the two sides disagreed about, a call id
the browser could emit twice that the validator now refuses, and the fix for that id
which shed a whole turn's replay. Each commit was correct against the contract it was
written against; the pair was broken. Every one of them shipped green, because the
frontend's tests validated its own output against its own assumptions and these tests
validated their own input against their own — and nothing anywhere fed one to the other.

So this file feeds one to the other. `frontend/src/domain/replaySeam.test.ts` writes what
the real `buildAgentMessages` produces to `contracts/replay-seam/`, and every file there
is validated here by the same `DeckAgentChatRequest` the route uses. Neither side imports
the other and neither restates the other's bounds: the files on disk are the contract,
which is the point. They are committed, so this run needs no build step on the other side
— a check that only runs when someone remembers to build it is not a check.

A failure here is a real defect in what the browser posts, not a stale fixture. A *stale*
fixture fails on the frontend side, where the regeneration lives.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from mtg_deck_builder.domain.agent_chat import (
    MAX_TOOL_PAYLOAD_CHARS,
    DeckAgentChatRequest,
)

CORPUS = Path(__file__).resolve().parents[2] / "contracts" / "replay-seam"

REGENERATE = (
    "cd frontend && UPDATE_FIXTURES=1 npm test -- --run src/domain/replaySeam.test.ts"
)

REQUIRED_CASES = {
    # Every name here is a real defect's fingerprint. Losing one silently is the failure
    # mode this set exists to stop: a parametrised run over an empty or thinned corpus is
    # a green suite that checked nothing.
    "answered-conversation",
    "reused-call-id-across-two-interrupted-turns",
    "reused-call-id-within-one-turn",
    "result-at-the-payload-bound",
    "result-over-the-payload-bound",
    "result-keeps-its-whitespace",
    "shed-payload-framed-not-posted",
    "long-stored-call-id",
    "message-ceiling",
    "message-floor-overflow",
}


def _fixtures() -> list[Path]:
    return sorted(CORPUS.glob("*.json"))


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_the_corpus_holds_every_shape_this_side_insists_on_seeing() -> None:
    """The known positive for the whole file.

    `pytest.mark.parametrize` over an empty list collects nothing and reports success,
    so the corpus being present has to be asserted rather than assumed. Naming the cases
    is also how the two sides disagree out loud: the browser declares which shapes it
    produces and this declares which it will be held to, and a case dropped on one side
    fails on the other.
    """

    assert CORPUS.is_dir(), f"{CORPUS} is missing. Regenerate it with:\n  {REGENERATE}"
    found = {path.stem for path in _fixtures()}
    missing = REQUIRED_CASES - found
    assert not missing, (
        f"the replay-seam corpus is missing {sorted(missing)}. Each one is a defect's "
        f"fingerprint, so regenerate the corpus rather than deleting the name:\n"
        f"  {REGENERATE}"
    )


@pytest.mark.parametrize("path", _fixtures(), ids=lambda path: path.stem)
def test_the_request_the_browser_builds_is_one_this_side_accepts(path: Path) -> None:
    """One case per file, so a failure names the shape rather than the corpus."""

    fixture = _load(path)
    request = DeckAgentChatRequest.model_validate(fixture["request"])

    # The count the browser recorded when it wrote the file, so a diff says what changed
    # before it says how.
    assert len(request.messages) == fixture["message_count"]


def test_an_answered_conversation_posts_prose_and_nothing_else() -> None:
    """The negative control: the shape that must carry no replay at all.

    The interrupted cases would all still pass if the browser replayed *every* turn, and
    that would be a worse bug than any of the three — it pays a second time for every
    reading the conversation already used. So the control is a conversation whose
    answered turn stored a call id and a result, asserted to post neither.
    """

    request = DeckAgentChatRequest.model_validate(
        _load(CORPUS / "answered-conversation.json")["request"]
    )

    assert [message.role for message in request.messages] == [
        "user",
        "assistant",
        "user",
    ]
    assert all(
        message.tool_calls == [] and message.tool_call_id is None
        for message in request.messages
    )
    assert all(message.content for message in request.messages)


def test_a_replayed_result_arrives_at_the_full_payload_bound() -> None:
    """Defect 1, from this side: the bound the two sides disagreed about.

    Asserted against this side's own constant rather than a literal, because the number
    that matters is the one the reply was allowed to carry *out*. The browser held a
    replayed result to the prose bound instead, so a deck listing over 8,000 characters
    came back two thirds gone — and the largest decks were the ones it happened to.
    """

    request = DeckAgentChatRequest.model_validate(
        _load(CORPUS / "result-at-the-payload-bound.json")["request"]
    )
    results = [message for message in request.messages if message.role == "tool"]

    assert len(results) == 1
    assert results[0].content is not None
    assert len(results[0].content) == MAX_TOOL_PAYLOAD_CHARS
    assert "truncated" not in results[0].content


def test_a_replayed_result_keeps_its_whitespace_byte_for_byte() -> None:
    """A tool message is not prose, so nothing here strips or rejects it.

    The model has to read back exactly what it read the first time. Under the prose rules
    this content would have been stripped to `Deck listing` and a blank one would have
    422'd the whole turn.
    """

    request = DeckAgentChatRequest.model_validate(
        _load(CORPUS / "result-keeps-its-whitespace.json")["request"]
    )
    results = [message for message in request.messages if message.role == "tool"]

    assert [message.content for message in results] == ["\n  Deck listing\n"]


def test_the_corpus_is_rejected_the_moment_a_posted_id_repeats() -> None:
    """The mutation control kept in the suite, because a validator can go quiet.

    Every fixture above validating proves nothing on its own unless this same call
    *refuses* the shape the defects produced. So the corpus's own hardest case is mutated
    here — the two interrupted turns' posted ids collapsed back to the one stored id —
    and the error the browser would have hit in production is asserted by its own words.
    """

    fixture = _load(CORPUS / "reused-call-id-across-two-interrupted-turns.json")
    request = fixture["request"]
    stored = "call-1"
    for message in request["messages"]:
        for call in message.get("tool_calls", []):
            call["id"] = stored
        if message.get("tool_call_id") is not None:
            message["tool_call_id"] = stored

    with pytest.raises(ValidationError) as reused:
        DeckAgentChatRequest.model_validate(request)

    assert "is asked for twice" in str(reused.value)
    assert f"{stored!r}" in str(reused.value)
