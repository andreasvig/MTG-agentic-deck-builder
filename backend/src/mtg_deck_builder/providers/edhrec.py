"""Small client for EDHREC's public commander-page and card-page JSON payloads."""

from __future__ import annotations

import gzip
import json
import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError

_MAX_RESPONSE_BYTES = 5 * 1024 * 1024
# Scryfall writes the ASCII apostrophe; the curly forms (U+2019, U+02BC) are covered
# so the deletion keeps working if this ever runs before the ASCII fold that would
# otherwise drop them.
_APOSTROPHES = re.compile("['\u2019\u02bc]")


class EdhrecUnavailable(RuntimeError):
    """Raised when a commander page cannot be fetched or validated."""


class _EdhrecCardView(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: UUID
    name: str = Field(min_length=1)
    num_decks: int = Field(ge=0)
    potential_decks: int = Field(ge=0)
    synergy: float | None = None


class _EdhrecThemeLink(BaseModel):
    model_config = ConfigDict(extra="ignore")

    slug: str = Field(min_length=1, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    value: str = Field(min_length=1)
    count: int = Field(ge=0)


@dataclass(frozen=True)
class EdhrecCardMetric:
    """One printing-level association from an EDHREC commander page."""

    scryfall_id: UUID
    name: str
    num_decks: int
    potential_decks: int
    synergy: float | None


@dataclass(frozen=True)
class EdhrecDeckTheme:
    """One commander deck theme advertised by EDHREC."""

    slug: str
    name: str
    deck_count: int


@dataclass(frozen=True)
class EdhrecCommanderPage:
    """Validated useful fields plus the complete source payload for caching."""

    cards: tuple[EdhrecCardMetric, ...]
    raw_json: str
    themes: tuple[EdhrecDeckTheme, ...] = ()


@dataclass(frozen=True)
class EdhrecCardPage:
    """The similar-card names one card page advertises, in EDHREC's own order.

    EDHREC publishes these as bare names with no Scryfall id and no score, so the
    list order is the only ranking signal and resolving each name to a local Oracle
    identity is the caller's job.
    """

    similar_names: tuple[str, ...]
    raw_json: str


class EdhrecJsonClient:
    """Fetch one EDHREC commander or card page without adding a runtime dependency."""

    def __init__(
        self,
        *,
        base_url: str,
        user_agent: str,
        timeout_seconds: float,
        open_url: Callable[..., Any] = urlopen,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._user_agent = user_agent
        self._timeout_seconds = timeout_seconds
        self._open_url = open_url

    def fetch_commander(
        self,
        slug: str,
        *,
        theme_slug: str | None = None,
    ) -> EdhrecCommanderPage:
        """Fetch and validate all cardviews on a commander or themed page."""

        page_path = quote(slug, safe="-")
        if theme_slug is not None:
            if re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", theme_slug) is None:
                raise EdhrecUnavailable("EDHREC theme slug was invalid")
            page_path = f"{page_path}/{quote(theme_slug, safe='-')}"
        raw_json = self._read_page("commanders", page_path, subject="commander page")
        try:
            payload = json.loads(raw_json)
            cardlists = payload["container"]["json_dict"]["cardlists"]
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            raise EdhrecUnavailable("EDHREC returned an invalid commander page") from exc
        if not isinstance(cardlists, list):
            raise EdhrecUnavailable("EDHREC returned an invalid card list")

        deduplicated: dict[UUID, EdhrecCardMetric] = {}
        for cardlist in cardlists:
            if not isinstance(cardlist, dict) or not isinstance(cardlist.get("cardviews"), list):
                continue
            for raw_view in cardlist["cardviews"]:
                try:
                    view = _EdhrecCardView.model_validate(raw_view)
                except ValidationError:
                    continue
                metric = EdhrecCardMetric(
                    scryfall_id=view.id,
                    name=view.name.strip(),
                    num_decks=view.num_decks,
                    potential_decks=view.potential_decks,
                    synergy=view.synergy,
                )
                previous = deduplicated.get(metric.scryfall_id)
                if previous is None or (
                    metric.num_decks,
                    metric.potential_decks,
                ) > (
                    previous.num_decks,
                    previous.potential_decks,
                ):
                    deduplicated[metric.scryfall_id] = metric

        if not deduplicated:
            raise EdhrecUnavailable("EDHREC returned no usable commander associations")
        themes: list[EdhrecDeckTheme] = []
        raw_theme_links = payload.get("panels", {}).get("taglinks", [])
        if isinstance(raw_theme_links, list):
            for raw_theme in raw_theme_links:
                try:
                    theme = _EdhrecThemeLink.model_validate(raw_theme)
                except ValidationError:
                    continue
                themes.append(
                    EdhrecDeckTheme(
                        slug=theme.slug,
                        name=theme.value.strip(),
                        deck_count=theme.count,
                    )
                )
        themes.sort(key=lambda theme: (-theme.deck_count, theme.name.casefold()))
        return EdhrecCommanderPage(
            cards=tuple(deduplicated.values()),
            raw_json=raw_json,
            themes=tuple(themes),
        )

    def fetch_card(self, slug: str) -> EdhrecCardPage:
        """Fetch the similar-card names EDHREC publishes on a single card's page."""

        raw_json = self._read_page("cards", quote(slug, safe="-"), subject="card page")
        try:
            payload = json.loads(raw_json)
        except json.JSONDecodeError as exc:
            raise EdhrecUnavailable("EDHREC returned an invalid card page") from exc
        if not isinstance(payload, dict):
            raise EdhrecUnavailable("EDHREC returned an invalid card page")

        # An absent key means the page is not the shape this code was written for; an
        # empty list is a legitimate answer and gets cached like any other, so a card
        # EDHREC has nothing to say about is not re-fetched on every view.
        raw_similar = payload.get("similar")
        if not isinstance(raw_similar, list):
            raise EdhrecUnavailable("EDHREC card page carried no similar-card list")
        similar_names = tuple(
            dict.fromkeys(
                name.strip() for name in raw_similar if isinstance(name, str) and name.strip()
            )
        )
        return EdhrecCardPage(similar_names=similar_names, raw_json=raw_json)

    def _read_page(self, section: str, page_path: str, *, subject: str) -> str:
        """Fetch one JSON page as text, without interpreting its contents."""

        request = Request(
            f"{self._base_url}/pages/{section}/{page_path}.json",
            headers={
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
                "User-Agent": self._user_agent,
            },
        )
        try:
            with self._open_url(request, timeout=self._timeout_seconds) as response:
                body = response.read(_MAX_RESPONSE_BYTES + 1)
                if len(body) > _MAX_RESPONSE_BYTES:
                    raise EdhrecUnavailable("EDHREC response exceeded the safety limit")
                if "gzip" in (response.headers.get("Content-Encoding") or "").casefold():
                    body = gzip.decompress(body)
        except (HTTPError, URLError, OSError, TimeoutError) as exc:
            raise EdhrecUnavailable(f"EDHREC {subject} could not be fetched") from exc
        try:
            return body.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise EdhrecUnavailable(f"EDHREC returned an invalid {subject}") from exc


def edhrec_slug(card_name: str) -> str:
    """Convert a local card name to the slug form used by EDHREC pages.

    Apostrophes are deleted rather than replaced, because EDHREC closes the gap
    they leave: `Thassa's Oracle` is served at `thassas-oracle`, and asking for
    `thassa-s-oracle` is answered with an HTTP 403. Scryfall writes the plain
    ASCII apostrophe, which survives the ASCII fold below and would otherwise
    become a separator like any other punctuation.
    """

    first_face = card_name.split(" // ", 1)[0]
    unpunctuated = _APOSTROPHES.sub("", first_face)
    ascii_name = unicodedata.normalize("NFKD", unpunctuated).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.casefold()).strip("-")
