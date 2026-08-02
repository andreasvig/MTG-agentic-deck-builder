"""Reading a known site through its own data instead of its markup.

Every adapter is an optimisation on a shape that was measured, so these tests mostly
assert the two things that make one worth having: that the structured endpoint is the
one actually requested, and that a miss still leaves the page readable the ordinary way.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from mtg_deck_builder.providers.web_page import WebPageFetcher
from mtg_deck_builder.providers.web_sites import known_hosts


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


class Server:
    """Serve canned responses by URL and remember what was asked for.

    Routing by URL is the point: an adapter is only doing its job if the request that
    leaves the machine is the structured endpoint rather than the page the agent named.
    """

    def __init__(self, routes: dict[str, Any]) -> None:
        self.routes = routes
        self.requested: list[str] = []

    def open_url(self, request: Any, timeout: float) -> Any:
        url = request.full_url
        self.requested.append(url)
        served = self.routes.get(url)
        if served is None:
            raise _http_error(url, 404)
        if isinstance(served, Exception):
            raise served
        return served


def _http_error(url: str, code: int) -> Exception:
    from urllib.error import HTTPError

    return HTTPError(url, code, "nope", {}, None)  # type: ignore[arg-type]


def public_resolve(host: str, port: int) -> list[Any]:
    return [(2, 1, 6, "", ("93.184.216.34", port))]


def make_fetcher(
    routes: dict[str, Any],
    *,
    resolve: Any = public_resolve,
    max_characters: int = 6000,
    max_bytes: int = 2_000_000,
) -> tuple[WebPageFetcher, Server]:
    server = Server(routes)
    fetcher = WebPageFetcher(
        timeout_seconds=5,
        max_characters=max_characters,
        max_bytes=max_bytes,
        user_agent="test-agent",
        open_url=server.open_url,
        resolve=resolve,
    )
    return fetcher, server


def as_json(payload: Any) -> StubResponse:
    return StubResponse(json.dumps(payload).encode(), "application/json")


def read(fetcher: WebPageFetcher, url: str, page: int = 1) -> Any:
    return asyncio.run(fetcher.fetch(url, page))


# ---------------------------------------------------------------------- MTGGoldfish


# `alt` sits before `class` on one tile and after it on another, because attribute
# order is not a promise any HTML makes and a parser that depended on it would pass a
# fixture written in only one of the two orders.
GOLDFISH = b"""<html><body>
<h1>Gale, Waterdeep Prodigy (Spellslinger)</h1>
<img alt="Sol Ring" class="deck-visual-pile-card deck-visual-pile-card-1" src="a.webp">
<img class="deck-visual-pile-card" alt="Brainstorm" src="b.webp">
<img alt="Island" class="deck-visual-pile-card" src="c.webp">
<img alt="Island" class="deck-visual-pile-card" src="d.webp">
<img alt="MTGGoldfish Logo" class="site-logo" src="logo.webp">
</body></html>"""

GOLDFISH_VISUAL = "https://www.mtggoldfish.com/deck/visual/5862293"


def test_a_goldfish_deck_is_read_through_the_visual_view_it_does_serve() -> None:
    fetcher, server = make_fetcher({GOLDFISH_VISUAL: StubResponse(GOLDFISH)})

    page = read(fetcher, "https://www.mtggoldfish.com/deck/5862293")

    # The deck view itself answers 403, so asking for it at all is the bug.
    assert server.requested == [GOLDFISH_VISUAL]
    assert "1 Sol Ring" in page.text
    assert "1 Brainstorm" in page.text


def test_goldfish_tiles_are_counted_because_one_tile_is_one_copy() -> None:
    fetcher, _ = make_fetcher({GOLDFISH_VISUAL: StubResponse(GOLDFISH)})

    page = read(fetcher, "https://www.mtggoldfish.com/deck/5862293")

    assert "2 Island" in page.text
    assert "4 cards" in page.text


def test_a_goldfish_logo_is_not_mistaken_for_a_card() -> None:
    fetcher, _ = make_fetcher({GOLDFISH_VISUAL: StubResponse(GOLDFISH)})

    page = read(fetcher, "https://www.mtggoldfish.com/deck/5862293")

    assert "MTGGoldfish Logo" not in page.text


def test_a_goldfish_page_without_tiles_falls_back_to_reading_the_markup() -> None:
    plain = b"<html><body><h1>Not a deck</h1><p>An article about frogs.</p></body></html>"
    fetcher, server = make_fetcher(
        {
            GOLDFISH_VISUAL: StubResponse(plain),
            "https://www.mtggoldfish.com/deck/5862293": StubResponse(plain),
        }
    )

    page = read(fetcher, "https://www.mtggoldfish.com/deck/5862293")

    assert "An article about frogs." in page.text
    assert server.requested[-1] == "https://www.mtggoldfish.com/deck/5862293"


# ------------------------------------------------------------------------ Archidekt


ARCHIDEKT_API = "https://archidekt.com/api/decks/4444516/"


def archidekt_payload() -> dict[str, Any]:
    def card(name: str, category: str, quantity: int = 1) -> dict[str, Any]:
        return {
            "quantity": quantity,
            "categories": [category],
            "card": {"oracleCard": {"name": name}},
        }

    return {
        "name": "Grolnok, The Omnivore",
        "updatedAt": "2023-08-27T15:30:35.926604Z",
        "viewCount": 4878,
        "owner": {"username": "Vader94"},
        "deckTags": [{"name": "Self-Mill"}, {"name": "Combo"}],
        # Declared out of order, and the maybeboard is the one marked out of the deck.
        "categories": [
            {"name": "Land", "includedInDeck": True},
            {"name": "Maybeboard", "includedInDeck": False},
            {"name": "Commander", "includedInDeck": True},
            {"name": "Artifact", "includedInDeck": True},
        ],
        "cards": [
            card("Forest", "Land", 8),
            card("Sol Ring", "Artifact"),
            card("Grolnok, the Omnivore", "Commander"),
            card("Thassa's Oracle", "Maybeboard"),
        ],
    }


def test_an_archidekt_deck_comes_from_the_api_not_the_five_part_page() -> None:
    fetcher, server = make_fetcher({ARCHIDEKT_API: as_json(archidekt_payload())})

    page = read(fetcher, "https://archidekt.com/decks/4444516/grolnok_the_omnivore")

    assert server.requested == [ARCHIDEKT_API]
    assert "8 Forest" in page.text
    assert "Tags: Self-Mill, Combo" in page.text


def test_the_commander_is_listed_first_whatever_order_the_api_used() -> None:
    fetcher, _ = make_fetcher({ARCHIDEKT_API: as_json(archidekt_payload())})

    page = read(fetcher, "https://archidekt.com/decks/4444516/")
    headings = [line for line in page.text.splitlines() if line.endswith(")")]

    assert headings[0].startswith("Commander (1)")


def test_a_maybeboard_is_shown_but_not_counted_as_part_of_the_deck() -> None:
    fetcher, _ = make_fetcher({ARCHIDEKT_API: as_json(archidekt_payload())})

    page = read(fetcher, "https://archidekt.com/decks/4444516/")

    # Ten in the deck, plus one card the owner is only considering.
    assert "10 cards ·" in page.text
    assert "Maybeboard (1) — not counted in the deck" in page.text
    assert "1 Thassa's Oracle" in page.text


def test_the_view_count_is_left_out_so_two_reads_split_the_same_way() -> None:
    """A number that ticks upward between part one and part two would move every
    boundary after it, and pagination refetches rather than remembering."""

    fetcher, _ = make_fetcher({ARCHIDEKT_API: as_json(archidekt_payload())})

    page = read(fetcher, "https://archidekt.com/decks/4444516/")

    assert "4,878" not in page.text
    assert "views" not in page.text


def test_a_deck_the_api_does_not_have_falls_back_to_the_page() -> None:
    missing = b"<html><body><p>A deck with this ID could not be found.</p></body></html>"
    fetcher, _ = make_fetcher(
        {"https://archidekt.com/decks/999/": StubResponse(missing)}
    )

    page = read(fetcher, "https://archidekt.com/decks/999/")

    assert "could not be found" in page.text


# --------------------------------------------------------------------------- EDHREC


def edhrec_payload() -> dict[str, Any]:
    return {
        "header": "Gale, Waterdeep Prodigy (Commander)",
        "creature": 14,
        "land": 34,
        "planeswalker": 1,
        "container": {
            "json_dict": {
                "cardlists": [
                    {
                        "header": "High Synergy Cards",
                        "cardviews": [
                            {
                                "name": "Consider",
                                "num_decks": 1978,
                                "potential_decks": 2848,
                                "synergy": 0.57,
                            }
                        ],
                    }
                ]
            }
        },
    }


def test_edhrec_reports_the_real_inclusion_figures() -> None:
    """The bake-off caught Sonar restating these wrong by up to 128x, so the whole
    point of the adapter is that this line is EDHREC's own arithmetic."""

    url = "https://json.edhrec.com/pages/commanders/gale-waterdeep-prodigy.json"
    fetcher, server = make_fetcher({url: as_json(edhrec_payload())})

    page = read(fetcher, "https://edhrec.com/commanders/gale-waterdeep-prodigy")

    assert server.requested == [url]
    assert "Consider — in 1,978 of 2,848 decks (69%), synergy +57%" in page.text


def test_a_single_planeswalker_is_not_reported_as_planeswalkers() -> None:
    url = "https://json.edhrec.com/pages/commanders/gale-waterdeep-prodigy.json"
    fetcher, _ = make_fetcher({url: as_json(edhrec_payload())})

    page = read(fetcher, "https://edhrec.com/commanders/gale-waterdeep-prodigy")

    assert "1 planeswalker," in page.text


@pytest.mark.parametrize(
    "path",
    [
        "/articles/how-to-choose-your-commander",  # the API answers 403 to these
        "/themes/spellslinger",
        "/commanders",  # a section index, which has no page behind it
    ],
)
def test_an_edhrec_path_with_no_api_behind_it_is_never_asked_of_the_api(
    path: str,
) -> None:
    article = b"<html><body><p>Welcome to Combo Week.</p></body></html>"
    fetcher, server = make_fetcher({f"https://edhrec.com{path}": StubResponse(article)})

    page = read(fetcher, f"https://edhrec.com{path}")

    assert "Welcome to Combo Week." in page.text
    assert not any("json.edhrec.com" in one for one in server.requested)


def test_a_combo_heading_does_not_repeat_its_own_two_cards() -> None:
    payload = {
        "header": "Simic Combos",
        "container": {
            "json_dict": {
                "cardlists": [
                    {
                        "header": "Kinnan, Bonder Prodigy + Basalt Monolith (46053 decks)",
                        "cardviews": [
                            {"name": "Kinnan, Bonder Prodigy"},
                            {"name": "Basalt Monolith"},
                        ],
                    }
                ]
            }
        },
    }
    url = "https://json.edhrec.com/pages/combos/simic.json"
    fetcher, _ = make_fetcher({url: as_json(payload)})

    page = read(fetcher, "https://edhrec.com/combos/simic")

    assert page.text.count("Basalt Monolith") == 1


# ------------------------------------------------------------- the text-export sites


EXPORT = b"1 Sol Ring\n8 Forest\n1 Brainstorm\n"


def test_tappedout_is_read_through_its_own_text_export() -> None:
    url = "https://tappedout.net/mtg-decks/foretell-and-flicker/?fmt=txt"
    fetcher, server = make_fetcher({url: StubResponse(EXPORT, "text/plain")})

    page = read(fetcher, "https://tappedout.net/mtg-decks/foretell-and-flicker/")

    assert server.requested == [url]
    assert "10 cards" in page.text
    assert "8 Forest" in page.text


def test_a_deck_named_only_by_its_slug_is_quoted_rather_than_prettified() -> None:
    """`grolnok-the-omnivore` tidied into Title Case reads as *Grolnok The Omnivore* —
    a real card under a wrong name, which is the exact failure this feature guards."""

    url = "https://tappedout.net/mtg-decks/grolnok-the-omnivore/?fmt=txt"
    fetcher, _ = make_fetcher({url: StubResponse(EXPORT, "text/plain")})

    page = read(fetcher, "https://tappedout.net/mtg-decks/grolnok-the-omnivore/")

    assert 'TappedOut deck "grolnok-the-omnivore"' in page.text
    assert "Grolnok The Omnivore" not in page.text


def test_an_aetherhub_deck_id_is_taken_from_the_tail_of_its_slug() -> None:
    url = "https://aetherhub.com/Deck/MtgoDeckExport/1153227"
    fetcher, server = make_fetcher({url: StubResponse(EXPORT, "text/plain")})

    page = read(fetcher, "https://aetherhub.com/Deck/grolnok-the-omnivore-1153227")

    assert server.requested == [url]
    assert "1 Brainstorm" in page.text


def test_an_export_that_is_really_an_error_page_falls_back() -> None:
    apology = b"Sorry, that deck is private."
    fetcher, _ = make_fetcher(
        {
            "https://tappedout.net/mtg-decks/x/?fmt=txt": StubResponse(
                apology, "text/plain"
            ),
            "https://tappedout.net/mtg-decks/x/": StubResponse(apology, "text/plain"),
        }
    )

    page = read(fetcher, "https://tappedout.net/mtg-decks/x/")

    assert page.text == "Sorry, that deck is private."


# -------------------------------------------------------------- Commander Spellbook


COMBO = {
    "uses": [
        {"card": {"name": "Demonic Consultation"}},
        {"card": {"name": "Thassa's Oracle"}},
    ],
    "produces": [{"feature": {"name": "Win the game"}}],
    "identity": "UB",
    "popularity": 146124,
    "description": "Cast <b>Demonic Consultation</b> naming Thassa's Oracle.",
}


def test_a_spellbook_combo_renders_its_pieces_and_its_steps() -> None:
    url = "https://backend.commanderspellbook.com/variants/742-1295/"
    fetcher, _ = make_fetcher({url: as_json(COMBO)})

    page = read(fetcher, "https://commanderspellbook.com/combo/742-1295/")

    assert "Demonic Consultation + Thassa's Oracle" in page.text
    assert "in 146,124 decks" in page.text
    # The API returns the steps as an HTML fragment, which has no business in the text.
    assert "Cast Demonic Consultation naming Thassa's Oracle." in page.text
    assert "<b>" not in page.text


def test_a_spellbook_search_passes_the_query_through_to_the_api() -> None:
    url = (
        "https://backend.commanderspellbook.com/variants/"
        "?q=Thassa%27s%20Oracle&limit=10"
    )
    fetcher, server = make_fetcher({url: as_json({"results": [COMBO]})})

    page = read(fetcher, "https://commanderspellbook.com/search/?q=Thassa%27s+Oracle")

    assert server.requested == [url]
    assert "Win the game" in page.text


# ------------------------------------------------------------------------- cEDHstat


def test_a_cedhstat_decklist_carries_its_result_as_well_as_its_cards() -> None:
    payload = {
        "commanders": "Thrasios, Triton Hero, Tymna the Weaver",
        "player_name": "Michael Newberry",
        "standing": 8,
        "participant_count": 58,
        "wins": 2,
        "losses": 3,
        "draws": 1,
        "cards": [
            {
                "section": "Mainboard",
                "card_name": "Ancient Tomb",
                "card_uuid": "3d867016",
                "count": 1,
            },
            {
                "section": "Commanders",
                "card_name": "Thrasios, Triton Hero",
                "card_uuid": "21e27b91",
                "count": 1,
            },
            # cEDHstat files its settings in the same array as its cards.
            {"section": "metadata", "card_name": "format", "card_uuid": None, "count": 1},
            {"section": "metadata", "card_name": "game", "card_uuid": None, "count": 1},
        ],
    }
    url = "https://cedhstat.com/api/decklists/85034"
    fetcher, _ = make_fetcher({url: as_json(payload)})

    page = read(fetcher, "https://cedhstat.com/decklists/85034")

    assert "placed 8 of 58 · record 2-3-1" in page.text
    assert "1 Ancient Tomb" in page.text


def test_cedhstat_settings_filed_among_the_cards_are_not_read_as_cards() -> None:
    """`format`, `game` and `importedFrom` sit in the same array as the decklist and
    are marked apart only by having no card behind them."""

    payload = {
        "commanders": "Thrasios, Triton Hero",
        "cards": [
            {
                "section": "Mainboard",
                "card_name": "Ancient Tomb",
                "card_uuid": "3d867016",
                "count": 1,
            },
            {"section": "metadata", "card_name": "format", "card_uuid": None, "count": 1},
            {
                "section": "metadata",
                "card_name": "importedFrom",
                "card_uuid": None,
                "count": 1,
            },
        ],
    }
    url = "https://cedhstat.com/api/decklists/85034"
    fetcher, _ = make_fetcher({url: as_json(payload)})

    page = read(fetcher, "https://cedhstat.com/decklists/85034")

    assert "1 format" not in page.text
    assert "importedFrom" not in page.text
    assert "metadata" not in page.text


# ------------------------------------------------------------------------- dispatch


def test_a_site_with_no_adapter_is_read_exactly_as_before() -> None:
    body = b"<html><head><title>A primer</title></head><body><p>Mill it.</p></body></html>"
    fetcher, server = make_fetcher({"https://example.com/p": StubResponse(body)})

    page = read(fetcher, "https://example.com/p")

    assert server.requested == ["https://example.com/p"]
    assert page.title == "A primer"


def test_an_adapter_endpoint_that_is_not_json_falls_back_to_the_page() -> None:
    notice = b"<html><body><p>The API is down for maintenance.</p></body></html>"
    fetcher, _ = make_fetcher(
        {
            ARCHIDEKT_API: StubResponse(b"<html>not json</html>", "application/json"),
            "https://archidekt.com/decks/4444516/": StubResponse(notice),
        }
    )

    page = read(fetcher, "https://archidekt.com/decks/4444516/")

    assert "down for maintenance" in page.text


def test_an_adapter_endpoint_cut_by_the_byte_cap_falls_back_rather_than_lying() -> None:
    """Half a JSON object is not half a decklist, so a capped download is a miss."""

    notice = b"<html><body><p>Read me instead.</p></body></html>"
    fetcher, _ = make_fetcher(
        {
            ARCHIDEKT_API: as_json(archidekt_payload()),
            "https://archidekt.com/decks/4444516/": StubResponse(notice),
        },
        max_bytes=80,
    )

    page = read(fetcher, "https://archidekt.com/decks/4444516/")

    assert "Read me instead." in page.text


def test_an_adapter_endpoint_goes_through_the_same_address_guard() -> None:
    """EDHREC rather than Archidekt, because its API is on a *different* host.

    An adapter whose endpoint shares a host with its page would be guarded by the
    check the page already passed, so such a fixture cannot tell whether the adapter
    is checking anything at all.
    """

    def resolve(host: str, port: int) -> list[Any]:
        if host == "json.edhrec.com":
            return [(2, 1, 6, "", ("127.0.0.1", port))]
        return public_resolve(host, port)

    endpoint = "https://json.edhrec.com/pages/commanders/gale-waterdeep-prodigy.json"
    fallback = b"<html><body><p>Gale is a spellslinger.</p></body></html>"
    fetcher, server = make_fetcher(
        {
            endpoint: as_json(edhrec_payload()),
            "https://edhrec.com/commanders/gale-waterdeep-prodigy": StubResponse(
                fallback
            ),
        },
        resolve=resolve,
    )

    page = read(fetcher, "https://edhrec.com/commanders/gale-waterdeep-prodigy")

    # Refused before it was opened, and a refusal is a miss rather than a failure, so
    # the page itself is still read the ordinary way.
    assert endpoint not in server.requested
    assert "Gale is a spellslinger." in page.text


def test_an_adapters_rendering_paginates_the_way_prose_does() -> None:
    payload = archidekt_payload()
    payload["cards"] = [
        {
            "quantity": 1,
            "categories": ["Creature"],
            "card": {"oracleCard": {"name": f"Frog Number {index:03d}"}},
        }
        for index in range(120)
    ]
    fetcher, _ = make_fetcher({ARCHIDEKT_API: as_json(payload)}, max_characters=400)

    first = read(fetcher, "https://archidekt.com/decks/4444516/")
    parts = [
        read(fetcher, "https://archidekt.com/decks/4444516/", number).text
        for number in range(1, first.total_pages + 1)
    ]

    assert first.total_pages > 1
    assert first.has_more_pages
    # Refetching to reach part two must reproduce the same split, or the parts would
    # overlap or skip; reassembly is what proves the rendering is deterministic.
    assert "\n".join(parts).count("Frog Number") == 120


def test_every_adapter_host_is_registered_without_a_www_prefix() -> None:
    """`read_known_site` strips `www.` before looking a host up, so an entry carrying
    one could never match anything."""

    assert known_hosts()
    assert not any(host.startswith("www.") for host in known_hosts())


# ------------------------------------------------- what the tool result then says


def test_a_site_read_is_marked_so_the_tool_result_can_say_what_it_is() -> None:
    """The blanket "numbers from the web are often wrong" caution would be false on a
    database export, and a caution the model can see is false is one it learns to
    discount. The names half still holds, so only the numbers half changes."""

    from mtg_deck_builder.deck_agent_tools import _page_lines

    fetcher, _ = make_fetcher({ARCHIDEKT_API: as_json(archidekt_payload())})
    page = read(fetcher, "https://archidekt.com/decks/4444516/")
    rendered = "\n".join(_page_lines(page))

    assert page.from_site_data
    assert "that site's real figures rather than a summary of them" in rendered
    assert "numbers from the web are often wrong" not in rendered
    assert "see_cards" in rendered


def test_a_generic_read_keeps_the_unqualified_caution() -> None:
    from mtg_deck_builder.deck_agent_tools import _page_lines

    body = b"<html><head><title>A primer</title></head><body><p>Mill it.</p></body></html>"
    fetcher, _ = make_fetcher({"https://example.com/p": StubResponse(body)})
    page = read(fetcher, "https://example.com/p")
    rendered = "\n".join(_page_lines(page))

    assert not page.from_site_data
    assert "numbers from the web are often wrong" in rendered
