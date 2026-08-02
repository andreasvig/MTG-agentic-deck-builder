"""Contract checks against the real endpoints the site adapters read.

Excluded from the default run — `pytest -m live` opts in. Every other test in the
suite stubs the transport, which is what makes them fast and deterministic and also
what makes them blind: an adapter couples to seven private endpoints that carry no
compatibility promise, and because a miss falls back to the generic reader, a site
changing shape degrades *silently*. Nothing else in the suite can see that happen.

These are deliberately loose. They assert the shape an adapter depends on rather than
any particular card or count, because the decks and the statistics behind these URLs
change on their own and a test that pinned them would fail for the wrong reason.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from mtg_deck_builder.providers.web_page import WebPageFetcher, WebPageUnavailable

pytestmark = pytest.mark.live

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def fetcher() -> WebPageFetcher:
    return WebPageFetcher(
        timeout_seconds=25,
        max_characters=6000,
        max_bytes=2_000_000,
        user_agent=USER_AGENT,
        cache_seconds=120,
    )


def read(url: str, page: int = 1) -> Any:
    return asyncio.run(fetcher().fetch(url, page))


# One live URL per adapter. Chosen from what Sonar actually cited during the bake-off,
# so they are the shape of thing the agent really gets handed.
CASES = [
    ("edhrec commander", "https://edhrec.com/commanders/gale-waterdeep-prodigy-scion-of-halaster"),
    ("edhrec combos", "https://edhrec.com/combos/simic"),
    ("edhrec card", "https://edhrec.com/cards/sol-ring"),
    ("archidekt", "https://archidekt.com/decks/4444516/grolnok_the_omnivore"),
    ("mtggoldfish", "https://www.mtggoldfish.com/deck/5862293"),
    ("tappedout", "https://tappedout.net/mtg-decks/foretell-and-flicker/"),
    ("aetherhub", "https://aetherhub.com/Deck/grolnok-the-omnivore-1153227"),
    ("spellbook combo", "https://commanderspellbook.com/combo/742-1295/"),
    ("spellbook search", "https://commanderspellbook.com/search/?q=Thassa%27s+Oracle"),
    ("cedhstat", "https://cedhstat.com/decklists/85034"),
    ("youtube", "https://www.youtube.com/watch?v=_249jkteUaQ"),
]


@pytest.mark.parametrize(("label", "url"), CASES, ids=[label for label, _ in CASES])
def test_the_adapter_still_claims_its_own_url(label: str, url: str) -> None:
    """`from_site_data` false is the whole failure mode: it means the endpoint stopped
    working and the read quietly became a generic HTML scrape."""

    page = read(url)

    assert page.from_site_data, f"{label} fell back to the generic reader"
    assert "Read from " in page.text
    # YouTube is the one adapter with no card field to read — it returns a title, a
    # channel and a description, and the cards it mentions are in prose that is not
    # this reader's to parse.
    if label != "youtube":
        assert page.card_names, f"{label} named no cards"


def test_a_goldfish_deck_still_carries_its_cards_in_image_alts() -> None:
    """The one adapter parsing markup rather than an API, so the one most likely to
    break — and the failure is invisible, since the page reads fine with no cards."""

    page = read("https://www.mtggoldfish.com/deck/5862293")

    assert len(page.card_names) > 50
    assert page.text.count("\n1 ") > 40


def test_edhrec_still_reports_a_denominator_with_its_deck_counts() -> None:
    """The inclusion figures are the reason to read EDHREC rather than a summary of
    it, and a bare numerator would be indistinguishable from an invented number."""

    page = read("https://edhrec.com/commanders/gale-waterdeep-prodigy-scion-of-halaster")

    assert " of " in page.text
    assert "decks (" in page.text


def test_a_youtube_video_still_yields_its_channel_and_description() -> None:
    page = read("https://www.youtube.com/watch?v=_249jkteUaQ")

    assert "Channel: " in page.text
    assert "Description" in page.text


def test_a_youtube_url_that_is_not_a_video_is_still_refused() -> None:
    """The adapter must not have widened into a licence to fetch any YouTube URL: a
    channel page answers 200 with a cookie footer, which reads as a successful read."""

    with pytest.raises(WebPageUnavailable, match="builds its pages in the browser"):
        read("https://www.youtube.com/@CommanderBaumi")


def test_a_walked_document_still_reassembles_without_gaps() -> None:
    page = read("https://edhrec.com/cards/sol-ring")
    parts = [read("https://edhrec.com/cards/sol-ring", number).text
             for number in range(1, page.total_pages + 1)]

    assert page.total_pages > 1
    assert len(set(parts)) == page.total_pages
    with pytest.raises(WebPageUnavailable, match="so there is no part"):
        read("https://edhrec.com/cards/sol-ring", page.total_pages + 1)


@pytest.mark.parametrize(
    "url",
    [
        # The paths that were actually measured as closed. Not a homepage: mtgdecks
        # serves its front page happily and 403s every page worth reading, so a
        # homepage here would have asserted the opposite of the real behaviour.
        "https://deckstats.net/decks/f/edh-commander/",
        "https://deckstats.net/api.php?action=get_deck&id_type=saved&owner_id=1&deck_id=1",
        "https://mtgdecks.net/Commander/staples/dredge",
        "https://api2.moxfield.com/v3/decks/search?q=grolnok&pageSize=2",
    ],
)
def test_a_site_measured_as_closed_is_still_closed(url: str) -> None:
    """These have no adapter because they refuse a reader. If one opens up it is worth
    one, and this failing is the signal to go and write it."""

    with pytest.raises(WebPageUnavailable):
        read(url)


def test_moxfield_is_refused_rather_than_read_as_a_loading_message() -> None:
    """Moxfield answers `/decks/public` with 200 and a forty-three character
    placeholder, which is a false success rather than a failure — so it is named as
    script-built instead of being left to look like a very short deck."""

    with pytest.raises(WebPageUnavailable, match="builds its pages in the browser"):
        read("https://www.moxfield.com/decks/public")
