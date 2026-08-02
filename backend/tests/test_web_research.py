"""The two tools that leave this machine: the Sonar search, and the page reader."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from mtg_deck_builder.config import DeckAgentWebSettings
from mtg_deck_builder.providers.openrouter import OpenRouterError
from mtg_deck_builder.providers.web_page import (
    WebPageFetcher,
    WebPageUnavailable,
)
from mtg_deck_builder.web_search import WebSearchService, WebSearchUnavailable


def citation(url: str, title: str | None = "A page") -> dict[str, Any]:
    return {"type": "url_citation", "url_citation": {"url": url, "title": title}}


def completion(
    content: str = "Dredge works because the graveyard is a second hand.[1]",
    annotations: list[dict[str, Any]] | None = None,
    cost: float | None = 0.0057,
) -> dict[str, Any]:
    usage: dict[str, Any] = {"prompt_tokens": 40, "completion_tokens": 120}
    if cost is not None:
        usage["cost"] = cost
    return {
        "choices": [
            {
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": content,
                    "annotations": annotations if annotations is not None else [],
                },
            }
        ],
        "usage": usage,
    }


class StubModelClient:
    """Record the payload and return one canned completion."""

    def __init__(self, response: Any = None) -> None:
        self.response = response if response is not None else completion()
        self.payloads: list[dict[str, Any]] = []

    async def chat_completion(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.payloads.append(payload)
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def make_service(response: Any = None, **settings: Any) -> tuple[WebSearchService, Any]:
    client = StubModelClient(response)
    service = WebSearchService(
        model_client=client,  # type: ignore[arg-type]
        settings=DeckAgentWebSettings(**settings),
    )
    return service, client


def test_a_search_returns_the_summary_and_its_sources_in_order() -> None:
    service, _ = make_service(
        completion(
            annotations=[
                citation("https://edhrec.com/commanders/grolnok", "Grolnok"),
                citation("https://tappedout.net/mtg-decks/madness/", "Madness"),
            ]
        )
    )

    answer = asyncio.run(service.search("What makes Dredge work in Commander?"))

    assert answer.summary.startswith("Dredge works because")
    assert [source.url for source in answer.sources] == [
        "https://edhrec.com/commanders/grolnok",
        "https://tappedout.net/mtg-decks/madness/",
    ]
    assert [source.title for source in answer.sources] == ["Grolnok", "Madness"]
    assert answer.cost_usd == pytest.approx(0.0057)


def test_a_repeated_url_is_dropped_without_reordering_the_rest() -> None:
    # Sonar's prose cites `[1]`, `[2]` positionally, so the surviving order is the
    # contract: sorting or renumbering here repoints every marker in the summary.
    # The URLs are deliberately NOT in alphabetical order — an alphabetical fixture
    # cannot tell "kept as given" apart from "sorted", and mine could not.
    service, _ = make_service(
        completion(
            annotations=[
                citation("https://zed.example/one", "One"),
                citation("https://alpha.example/two", "Two"),
                citation("https://zed.example/one", "One again"),
                citation("https://mid.example/three", "Three"),
            ]
        )
    )

    answer = asyncio.run(service.search("A question long enough to pass validation."))

    assert [source.url for source in answer.sources] == [
        "https://zed.example/one",
        "https://alpha.example/two",
        "https://mid.example/three",
    ]


def test_sources_stop_at_the_configured_maximum() -> None:
    service, _ = make_service(
        completion(
            annotations=[citation(f"https://example.com/{n}") for n in range(12)]
        ),
        max_sources=4,
    )

    answer = asyncio.run(service.search("A question long enough to pass validation."))

    assert len(answer.sources) == 4
    assert answer.sources[-1].url == "https://example.com/3"


def test_an_annotation_that_is_not_a_citation_is_ignored() -> None:
    service, _ = make_service(
        completion(
            annotations=[
                {"type": "file_citation", "file_citation": {"file_id": "x"}},
                citation("https://example.com/real"),
            ]
        )
    )

    answer = asyncio.run(service.search("A question long enough to pass validation."))

    assert [source.url for source in answer.sources] == ["https://example.com/real"]


def test_an_empty_body_is_reported_rather_than_returned_as_an_answer() -> None:
    # Observed live: finish_reason `stop`, no content, no usage. Returning it would
    # hand the model a blank tool result it cannot distinguish from "nothing found".
    service, _ = make_service({"choices": [{"message": {"content": "   "}}]})

    with pytest.raises(WebSearchUnavailable, match="came back empty"):
        asyncio.run(service.search("A question long enough to pass validation."))


def test_a_response_with_no_choices_is_reported() -> None:
    service, _ = make_service({"choices": []})

    with pytest.raises(WebSearchUnavailable, match="nothing to read"):
        asyncio.run(service.search("A question long enough to pass validation."))


def test_a_provider_failure_becomes_an_unavailable_search() -> None:
    service, _ = make_service(OpenRouterError("OpenRouter returned HTTP 429"))

    with pytest.raises(WebSearchUnavailable, match="429"):
        asyncio.run(service.search("A question long enough to pass validation."))


def test_the_payload_carries_the_configured_model_prompt_and_accounting() -> None:
    service, client = make_service(model="perplexity/sonar", max_tokens=900)

    asyncio.run(service.search("Has anyone built a strong Foretell deck?"))

    payload = client.payloads[0]
    assert payload["model"] == "perplexity/sonar"
    assert payload["max_tokens"] == 900
    # Without this OpenRouter reports no cost at all, and the search fee is the whole
    # reason this tool has a budget worth watching.
    assert payload["usage"] == {"include": True}
    assert payload["messages"][0]["role"] == "system"
    assert payload["messages"][1] == {
        "role": "user",
        "content": "Has anyone built a strong Foretell deck?",
    }


def test_a_search_without_a_client_is_not_enabled() -> None:
    service = WebSearchService(model_client=None, settings=DeckAgentWebSettings())

    assert service.enabled is False
    with pytest.raises(WebSearchUnavailable, match="not configured"):
        asyncio.run(service.search("A question long enough to pass validation."))


def test_a_disabled_search_is_not_enabled_even_with_a_client() -> None:
    service, _ = make_service(enabled=False)

    assert service.enabled is False


# --- the page reader -------------------------------------------------------------


class StubResponse:
    def __init__(
        self,
        body: bytes,
        content_type: str = "text/html; charset=utf-8",
        url: str = "https://example.com/page",
    ) -> None:
        self.body = body
        self.headers = {"Content-Type": content_type}
        self.url = url

    def read(self, size: int | None = None) -> bytes:
        return self.body if size is None else self.body[:size]

    def __enter__(self) -> StubResponse:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def public_resolve(host: str, port: int) -> list[Any]:
    return [(2, 1, 6, "", ("93.184.216.34", port))]


def make_fetcher(
    response: Any = None,
    *,
    resolve: Any = public_resolve,
    max_characters: int = 6000,
    max_bytes: int = 2_000_000,
) -> WebPageFetcher:
    def open_url(request: Any, timeout: float) -> Any:
        if isinstance(response, Exception):
            raise response
        return response

    return WebPageFetcher(
        timeout_seconds=5,
        max_characters=max_characters,
        max_bytes=max_bytes,
        user_agent="test-agent",
        open_url=open_url,
        resolve=resolve,
    )


HTML = b"""<html><head><title>Grolnok Primer</title>
<style>.a{color:red}</style></head>
<body><h1>Grolnok, the Omnivore</h1>
<script>document.write('never');</script>
<p>Mill <b>yourself</b>, then <em>croak</em> the permanents back.</p>
<ul><li>Wild Growth</li><li>Life from the Loam</li></ul>
</body></html>"""


def test_a_page_comes_back_as_title_and_prose_without_its_markup() -> None:
    page = asyncio.run(make_fetcher(StubResponse(HTML)).fetch("https://example.com/p"))

    assert page.title == "Grolnok Primer"
    assert "Grolnok, the Omnivore" in page.text
    # Inline markup must NOT break the line. Without a sentence broken up by `<b>` and
    # `<em>`, "break after a block tag" and "break before every text run" produce the
    # same output, and the fixture proves nothing.
    assert "Mill yourself, then croak the permanents back." in page.text
    # Block tags do have to break, or a decklist arrives as one paragraph.
    assert "Wild Growth\nLife from the Loam" in page.text
    assert page.truncated is False


def test_script_and_style_content_never_reaches_the_text() -> None:
    page = asyncio.run(make_fetcher(StubResponse(HTML)).fetch("https://example.com/p"))

    assert "never" not in page.text
    assert "color:red" not in page.text


def test_a_long_page_is_split_into_parts_rather_than_cut_off() -> None:
    body = b"<html><title>Long</title><body><p>" + (b"card " * 4000) + b"</p></body>"

    first = asyncio.run(
        make_fetcher(StubResponse(body), max_characters=200).fetch(
            "https://example.com/p"
        )
    )

    # At most the budget: a break taken at a boundary is trimmed, so it can land just
    # under rather than exactly on it.
    assert 190 <= len(first.text) <= 200
    assert first.page == 1
    assert first.total_pages == 100
    assert first.has_more_pages is True
    # The byte cap never fired, so nothing was lost — it is all reachable by paging.
    assert first.truncated is False


def test_every_part_of_a_document_is_reachable_and_none_overlaps() -> None:
    # Each call refetches and re-splits, so the parts have to reassemble into the whole
    # document: a boundary that drifted between calls would duplicate or skip text.
    lines = "\n".join(f"line {n:03d}" for n in range(200)).encode()
    body = b"<html><title>List</title><body><pre>" + lines + b"</pre></body></html>"
    fetcher = make_fetcher(StubResponse(body), max_characters=300)

    first = asyncio.run(fetcher.fetch("https://example.com/p"))
    parts = [
        asyncio.run(fetcher.fetch("https://example.com/p", n)).text
        for n in range(1, first.total_pages + 1)
    ]

    assert first.total_pages > 3
    rejoined = "\n".join(parts)
    assert rejoined.split() == asyncio.run(
        make_fetcher(StubResponse(body), max_characters=10**6).fetch(
            "https://example.com/p"
        )
    ).text.split()
    assert all(part for part in parts)


def test_a_part_break_lands_on_a_line_ending() -> None:
    # A decklist cut through a card name is the failure this avoids.
    lines = "\n".join(f"1 Card Number {n:03d}" for n in range(120)).encode()
    body = b"<html><title>Deck</title><body><pre>" + lines + b"</pre></body></html>"

    page = asyncio.run(
        make_fetcher(StubResponse(body), max_characters=300).fetch(
            "https://example.com/p"
        )
    )

    assert page.total_pages > 1
    assert page.text.endswith(tuple(f"{n:03d}" for n in range(120)))


def test_asking_past_the_last_part_names_how_many_there_are() -> None:
    body = b"<html><title>Short</title><body><p>Only a little text.</p></body></html>"

    with pytest.raises(WebPageUnavailable, match="only 1 part, so there is no part 4"):
        asyncio.run(make_fetcher(StubResponse(body)).fetch("https://example.com/p", 4))


def test_a_download_stopped_by_the_byte_cap_is_reported_as_truncated() -> None:
    # Distinct from having more parts: this is text that was never fetched at all.
    body = b"<html><title>Huge</title><body><p>" + (b"card " * 4000) + b"</p></body>"

    page = asyncio.run(
        make_fetcher(
            StubResponse(body), max_characters=500, max_bytes=1200
        ).fetch("https://example.com/p")
    )

    assert page.truncated is True


def test_a_page_that_builds_itself_in_the_browser_says_that() -> None:
    empty = b"<html><head><title>App</title></head><body><div id='root'></div></body>"

    with pytest.raises(WebPageUnavailable, match="JavaScript"):
        asyncio.run(make_fetcher(StubResponse(empty)).fetch("https://example.com/p"))


def test_plain_text_is_returned_as_it_stands() -> None:
    fetcher = make_fetcher(StubResponse(b"1 Sol Ring\n1 Arcane Signet", "text/plain"))

    page = asyncio.run(fetcher.fetch("https://example.com/list.txt"))

    assert page.title is None
    assert page.text == "1 Sol Ring\n1 Arcane Signet"


def test_a_pdf_is_refused_rather_than_decoded() -> None:
    fetcher = make_fetcher(StubResponse(b"%PDF-1.7", "application/pdf"))

    with pytest.raises(WebPageUnavailable, match="application/pdf"):
        asyncio.run(fetcher.fetch("https://example.com/a.pdf"))


@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "10.0.0.5", "192.168.1.20", "169.254.169.254"],
)
def test_a_host_resolving_to_a_private_address_is_refused(address: str) -> None:
    # The app's own API is on loopback and the metadata endpoint is link-local, so a
    # URL from a chat message must not be able to reach either.
    def resolve(host: str, port: int) -> list[Any]:
        return [(2, 1, 6, "", (address, port))]

    fetcher = make_fetcher(StubResponse(HTML), resolve=resolve)

    with pytest.raises(WebPageUnavailable, match="private address"):
        asyncio.run(fetcher.fetch("http://localhost:43127/api/v1/health"))


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://example.com/x"])
def test_only_http_and_https_can_be_read(url: str) -> None:
    with pytest.raises(WebPageUnavailable, match="http and https"):
        asyncio.run(make_fetcher(StubResponse(HTML)).fetch(url))


def test_a_blocked_page_says_that_sites_block_readers() -> None:
    from urllib.error import HTTPError

    fetcher = make_fetcher(
        HTTPError("https://example.com/p", 403, "Forbidden", {}, None)  # type: ignore[arg-type]
    )

    with pytest.raises(WebPageUnavailable, match=r"403.*block"):
        asyncio.run(fetcher.fetch("https://example.com/p"))


def test_an_unreachable_page_is_reported_plainly() -> None:
    fetcher = make_fetcher(OSError("connection refused"))

    with pytest.raises(WebPageUnavailable, match="could not be reached"):
        asyncio.run(fetcher.fetch("https://example.com/p"))


def test_a_page_byte_cap_below_the_character_cap_is_refused_at_construction() -> None:
    # The byte cap bounds what is pulled over the wire and markup is most of a page,
    # so a byte cap under the character cap could never fill the character cap.
    with pytest.raises(ValueError, match="page_max_bytes"):
        DeckAgentWebSettings(page_max_bytes=10_000, page_max_characters=20_000)


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/watch?v=hioFrk69zTQ",
        "https://youtu.be/hioFrk69zTQ",
        "https://www.facebook.com/groups/magicthegatheringcommander/posts/1/",
        "https://x.com/someone/status/1",
    ],
)
def test_a_host_that_needs_a_renderer_is_named_rather_than_fetched(url: str) -> None:
    # YouTube is the worst case: it answers 200 with its cookie footer, so a plain
    # fetch "succeeds" and returns nothing. Refusing is honest and costs one round less.
    fetcher = make_fetcher(StubResponse(HTML))

    with pytest.raises(WebPageUnavailable, match="builds its pages in the browser"):
        asyncio.run(fetcher.fetch(url))


def test_a_reddit_thread_is_read_through_the_server_rendered_host() -> None:
    # Reddit is the most-cited domain in a Sonar answer and `www.reddit.com` returns
    # no readable text at all, while `old.reddit.com` serves the same thread as HTML.
    seen: list[str] = []

    def open_url(request: Any, timeout: float) -> Any:
        seen.append(request.full_url)
        return StubResponse(HTML)

    fetcher = WebPageFetcher(
        timeout_seconds=5,
        max_characters=6000,
        max_bytes=2_000_000,
        user_agent="test-agent",
        open_url=open_url,
        resolve=public_resolve,
    )

    asyncio.run(
        fetcher.fetch("https://www.reddit.com/r/EDH/comments/berx3n/madness_commander/")
    )

    assert seen == [
        "https://old.reddit.com/r/EDH/comments/berx3n/madness_commander/"
    ]


def test_site_navigation_never_reaches_the_text() -> None:
    body = (
        b"<html><title>T</title><body><nav><a>Shop</a><a>Sell Your Cards</a></nav>"
        b"<p>The actual article starts here.</p></body></html>"
    )

    page = asyncio.run(make_fetcher(StubResponse(body)).fetch("https://example.com/p"))

    assert "Sell Your Cards" not in page.text
    assert page.text == "The actual article starts here."
