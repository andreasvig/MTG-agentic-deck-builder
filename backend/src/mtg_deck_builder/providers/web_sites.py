"""Read a known site through its own data instead of through its rendered HTML.

`read_page` is a generic HTML-to-text reader, and on the handful of sites a Magic
search actually cites it is not merely noisy — it is wrong. Measured on 2026-08-02
against the 314 citations from the Sonar bake-off:

- **MTGGoldfish** puts every card name in an `img alt`, which is exactly what an
  HTML-to-text extractor discards. The generic reader returns a deck page with the
  price, the type counts, the newsletter signup and **not one card**. A page that
  looks like it worked and contains no answer is the worst failure available.
- **TappedOut** spends its first six thousand characters on chat widgets, inventory
  panels and price tables; the decklist starts on part two. Its own `?fmt=txt` export
  is the whole list in 1.4 KB.
- **Archidekt** renders across five parts what its API returns in one call.
- **EDHREC** is the second-most-cited domain of all, and its numbers are the ones the
  bake-off caught Sonar fabricating worst — Esika's 25,116 decks reported as 854. The
  real figures are one request away.

So each adapter here matches a URL, fetches the structured thing behind it, and renders
readable text. Everything else still falls through to the generic reader, and so does
any adapter that misses: an adapter is an optimisation on a known shape, never the only
way a page can be read.

Nothing here is a new tool. The agent keeps calling `read_page` with the URL a search
gave it, and pagination applies to the rendered text the same way it applies to prose.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from typing import Any, Final
from urllib.parse import parse_qs, quote, urlsplit

# Fetch one URL and hand back its bytes. Bound to the caller's guards — scheme, address
# and byte cap — so an adapter cannot reach anywhere the generic reader could not.
Getter = Callable[[str, str], bytes]

_JSON: Final = "application/json"
_TEXT: Final = "text/plain,*/*;q=0.5"
_HTML: Final = "text/html,application/xhtml+xml"


class AdapterMiss(Exception):
    """This adapter cannot read this URL, so the generic reader should have it."""


@dataclass(frozen=True)
class SiteReading:
    """One page rendered from its own data rather than from its markup."""

    title: str
    text: str


def _provenance(what: str) -> str:
    """Say where the text came from, in one line, at the top of every reading.

    Worth its own line because it is a real distinction the agent should act on. These
    names are a database export, not a language model's prose, so they are spelled the
    way the source stores them — which is a different claim from being right about the
    local catalog, and the tool result's closing caution still applies.
    """

    return f"Read from {what}."


def _thousands(value: Any) -> str:
    return f"{value:,}" if isinstance(value, int) else str(value)


def _count(quantity: int, singular: str, plural: str | None = None) -> str:
    return f"{quantity} {singular if quantity == 1 else (plural or singular + 's')}"


# --------------------------------------------------------------------------- EDHREC


# The sections `json.edhrec.com` serves. Verified one by one: `themes`, bare
# `commanders` and every `articles` path answer 403, and `decks` answers 200 with a
# 743 KB payload whose useful half is not in it — all four are better off generic.
_EDHREC_SECTIONS: Final = frozenset(
    {"commanders", "combos", "cards", "average-decks", "top", "tags"}
)


def _edhrec(parts: Any, get: Getter) -> SiteReading:
    path = parts.path.strip("/")
    if not path or path.split("/")[0] not in _EDHREC_SECTIONS:
        raise AdapterMiss
    if len(path.split("/")) < 2:
        # A section index rather than a page within it; the API has no entry for those.
        raise AdapterMiss
    payload = _json(get(f"https://json.edhrec.com/pages/{path}.json", _JSON))
    container = payload.get("container") or {}
    header = str(payload.get("header") or "").strip() or path
    lines = [header, _provenance("EDHREC's own data API, not from the page's HTML")]

    composition = _edhrec_composition(payload)
    if composition:
        lines += ["", composition]
    description = str(payload.get("description") or "").strip()
    if description:
        lines += ["", description]

    cardlists = ((container.get("json_dict") or {}).get("cardlists")) or []
    if not cardlists:
        raise AdapterMiss
    for cardlist in cardlists:
        rendered = _edhrec_cardlist(cardlist)
        if not rendered:
            continue
        # A combos page is a run of bare headings, each one a whole combo. Separating
        # those with blank lines would double the length of the part for no reading.
        lines += rendered if len(rendered) == 1 else ["", *rendered]
    return SiteReading(title=f"{header} | EDHREC", text="\n".join(lines))


def _edhrec_composition(payload: dict[str, Any]) -> str:
    """The average deck's shape, which is the one EDHREC number stated as a bare int."""

    shown = [
        _count(value, singular, plural)
        for key, singular, plural in (
            ("creature", "creature", None), ("instant", "instant", None),
            ("sorcery", "sorcery", "sorceries"), ("artifact", "artifact", None),
            ("enchantment", "enchantment", None), ("battle", "battle", None),
            ("planeswalker", "planeswalker", None), ("land", "land", None),
        )
        for value in [payload.get(key)]
        if isinstance(value, int) and value
    ]
    return "Average deck: " + ", ".join(shown) if shown else ""


def _edhrec_cardlist(cardlist: Any) -> list[str]:
    if not isinstance(cardlist, dict):
        return []
    header = str(cardlist.get("header") or "").strip()
    views = cardlist.get("cardviews") or []
    if not views:
        return []
    named = 0
    rows = []
    for view in views:
        if not isinstance(view, dict):
            continue
        name = str(view.get("name") or "").strip()
        if not name:
            continue
        named += 1
        stats = _edhrec_stats(view)
        if not stats and name in header:
            # A combos page names both pieces in its own heading and then repeats them
            # with nothing attached. Printing the same two names twice is pure cost —
            # but the heading is then the whole entry, so it is still worth emitting.
            continue
        rows.append(f"{name}{stats}")
    if not named:
        return []
    return [f"## {header}" if header else "## Cards", *rows]


def _edhrec_stats(view: dict[str, Any]) -> str:
    """The inclusion figures, which are the whole reason to read EDHREC at all."""

    played = view.get("num_decks")
    possible = view.get("potential_decks")
    bits = []
    if isinstance(played, int) and isinstance(possible, int) and possible > 0:
        share = round(100 * played / possible)
        bits.append(f"in {_thousands(played)} of {_thousands(possible)} decks ({share}%)")
    synergy = view.get("synergy")
    if isinstance(synergy, (int, float)) and round(100 * synergy):
        bits.append(f"synergy {round(100 * synergy):+d}%")
    return " — " + ", ".join(bits) if bits else ""


# ------------------------------------------------------------------------ Archidekt


_ARCHIDEKT_DECK = re.compile(r"^/decks/(\d+)(?:/|$)")


def _archidekt(parts: Any, get: Getter) -> SiteReading:
    matched = _ARCHIDEKT_DECK.match(parts.path)
    if matched is None:
        raise AdapterMiss
    deck_id = matched.group(1)
    payload = _json(get(f"https://archidekt.com/api/decks/{deck_id}/", _JSON))
    cards = payload.get("cards")
    if not isinstance(cards, list) or not cards:
        raise AdapterMiss

    name = str(payload.get("name") or "").strip() or f"Archidekt deck {deck_id}"
    # A category can be marked out of the deck — a maybeboard or a considering pile.
    # Counting those toward the total would report a 140-card Commander deck.
    excluded = {
        str(category.get("name"))
        for category in (payload.get("categories") or [])
        if isinstance(category, dict) and category.get("includedInDeck") is False
    }
    grouped: dict[str, Counter[str]] = {}
    total = 0
    for entry in cards:
        if not isinstance(entry, dict):
            continue
        card_name = (
            ((entry.get("card") or {}).get("oracleCard") or {}).get("name") or ""
        ).strip()
        if not card_name:
            continue
        quantity = entry.get("quantity")
        quantity = quantity if isinstance(quantity, int) and quantity > 0 else 1
        categories = [str(one) for one in (entry.get("categories") or [])]
        group = next((one for one in categories if one not in excluded), None)
        if group is None:
            group = categories[0] if categories else "Uncategorised"
        else:
            total += quantity
        grouped.setdefault(group, Counter())[card_name] += quantity

    lines = [
        name,
        _provenance("Archidekt's deck API, not from the page's HTML"),
        "",
        _archidekt_meta(payload, total),
    ]
    tags = [
        str(tag.get("name")) for tag in (payload.get("deckTags") or [])
        if isinstance(tag, dict) and tag.get("name")
    ]
    if tags:
        lines.append("Tags: " + ", ".join(tags))
    for group in _ordered_groups(grouped, excluded):
        lines += ["", *_card_block(group, grouped[group], noted=group in excluded)]
    return SiteReading(title=f"{name} | Archidekt", text="\n".join(lines))


def _archidekt_meta(payload: dict[str, Any], total: int) -> str:
    """Facts about the deck that do not change between two reads of it.

    The view count is deliberately left out. Pagination refetches and re-splits, so a
    field that ticks upward between part one and part two would shift every boundary
    after it — and a view count is the one number here that changes by the minute.
    Archidekt reports the format as a bare integer with no name attached, so it is
    left out too rather than guessed at.
    """

    bits = [_count(total, "card")]
    owner = (payload.get("owner") or {}).get("username")
    if owner:
        bits.append(f"by {owner}")
    bracket = payload.get("edhBracket")
    if isinstance(bracket, int):
        bits.append(f"bracket {bracket}")
    updated = str(payload.get("updatedAt") or "")[:10]
    if updated:
        bits.append(f"updated {updated}")
    return " · ".join(bits)


def _ordered_groups(grouped: dict[str, Counter[str]], excluded: set[str]) -> list[str]:
    """Commander first, then the rest alphabetically, then anything out of the deck.

    Deterministic on purpose: page two of a long list refetches and re-splits, so a
    group order that varied between calls would overlap or skip cards.
    """

    inside = sorted(name for name in grouped if name not in excluded)
    leading = [name for name in inside if name.lower().startswith("commander")]
    others = [name for name in inside if not name.lower().startswith("commander")]
    return leading + others + sorted(name for name in grouped if name in excluded)


def _card_block(group: str, counts: Counter[str], *, noted: bool) -> list[str]:
    total = sum(counts.values())
    heading = f"{group} ({total})"
    if noted:
        heading += " — not counted in the deck"
    return [heading] + [f"{counts[name]} {name}" for name in sorted(counts)]


# ---------------------------------------------------------------------- MTGGoldfish


_GOLDFISH_DECK = re.compile(r"^/deck/(?:visual/|download/|arena_download/|custom/)?(\d+)")


class _GoldfishTiles(HTMLParser):
    """Pull the card names out of the visual view's image tiles, and the deck's name.

    MTGGoldfish answers 403 to `/deck/<id>`, `/deck/download/<id>` and
    `/deck/arena_download/<id>`, but serves `/deck/visual/<id>` — where each card is an
    `<img>` whose `alt` is the card name and whose tile is one physical copy, so twelve
    Islands are twelve tiles. The page carries no `<title>` at all; the deck's name is
    in its `<h1>`.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.names: list[str] = []
        self.heading: str | None = None
        self._in_heading = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "h1" and self.heading is None:
            self._in_heading = True
        elif tag == "img":
            classes = (values.get("class") or "").split()
            alt = (values.get("alt") or "").strip()
            if alt and "deck-visual-pile-card" in classes:
                self.names.append(unescape(alt))

    def handle_endtag(self, tag: str) -> None:
        if tag == "h1":
            self._in_heading = False

    def handle_data(self, data: str) -> None:
        if self._in_heading and data.strip():
            self.heading = ((self.heading or "") + " " + data.strip()).strip()


def _goldfish(parts: Any, get: Getter) -> SiteReading:
    matched = _GOLDFISH_DECK.match(parts.path)
    if matched is None:
        raise AdapterMiss
    deck_id = matched.group(1)
    body = get(f"https://www.mtggoldfish.com/deck/visual/{deck_id}", _HTML)
    tiles = _GoldfishTiles()
    tiles.feed(body.decode("utf-8", errors="replace"))
    if not tiles.names:
        raise AdapterMiss

    counts = Counter(tiles.names)
    name = tiles.heading or f"MTGGoldfish deck {deck_id}"
    lines = [
        name,
        _provenance(
            "the card images on MTGGoldfish's visual deck view, because it serves "
            "no text or download view to a reader"
        ),
        "",
        _count(sum(counts.values()), "card"),
        "",
    ]
    lines += [f"{counts[card]} {card}" for card in sorted(counts)]
    return SiteReading(title=f"{name} | MTGGoldfish", text="\n".join(lines))


# ------------------------------------------------------- plain-text export services


def _tappedout(parts: Any, get: Getter) -> SiteReading:
    if not parts.path.startswith("/mtg-decks/"):
        raise AdapterMiss
    slug = parts.path.strip("/").split("/")[-1]
    exported = get(
        f"https://tappedout.net/mtg-decks/{quote(slug)}/?fmt=txt", _TEXT
    ).decode("utf-8", errors="replace")
    return _from_export(
        slug=slug,
        site="TappedOut",
        source="TappedOut's own text export, not from the page's HTML",
        exported=exported,
    )


_AETHERHUB_DECK = re.compile(r"^/Deck/.*?-(\d+)/?$", re.IGNORECASE)


def _aetherhub(parts: Any, get: Getter) -> SiteReading:
    matched = _AETHERHUB_DECK.match(parts.path)
    if matched is None:
        raise AdapterMiss
    deck_id = matched.group(1)
    exported = get(
        f"https://aetherhub.com/Deck/MtgoDeckExport/{deck_id}", _TEXT
    ).decode("utf-8", errors="replace")
    slug = parts.path.strip("/").split("/")[-1]
    return _from_export(
        slug=slug.rsplit("-", 1)[0],
        site="Aetherhub",
        source="Aetherhub's MTGO deck export, not from the page's HTML",
        exported=exported,
    )


def _from_export(*, slug: str, site: str, source: str, exported: str) -> SiteReading:
    """Render a `1 Card Name` export, which needs tidying rather than parsing.

    These two exports carry the cards and nothing else, so the only name available for
    the deck is the one in its URL. It is quoted as a slug rather than prettified into
    Title Case, because `grolnok-the-omnivore` cleaned up reads as *Grolnok The
    Omnivore* — which is exactly the shape of the corrupted card names this whole
    feature exists to keep out of the agent's mouth.
    """

    kept = [line for line in (row.strip() for row in exported.splitlines()) if line]
    quantities = [re.match(r"^(\d+)\s+\S", line) for line in kept]
    if not any(quantities):
        # No quantities anywhere means this is an error page, not a decklist.
        raise AdapterMiss
    total = sum(int(found.group(1)) for found in quantities if found)
    name = f'{site} deck "{slug}"'
    return SiteReading(
        title=name,
        text="\n".join([name, _provenance(source), "", _count(total, "card"), "", *kept]),
    )


# --------------------------------------------------------------- Commander Spellbook


_SPELLBOOK_COMBO = re.compile(r"^/combo/([\w-]+)/?$")
_spellbook_source = _provenance(
    "Commander Spellbook's API, not from the page's HTML"
)


def _spellbook(parts: Any, get: Getter) -> SiteReading:
    matched = _SPELLBOOK_COMBO.match(parts.path)
    if matched is not None:
        payload = _json(
            get(f"https://backend.commanderspellbook.com/variants/{matched.group(1)}/", _JSON)
        )
        rendered = _spellbook_combo(payload)
        if rendered is None:
            raise AdapterMiss
        heading = f"Commander Spellbook — {rendered[0]}"
        return SiteReading(
            title=heading,
            text="\n".join([heading, _spellbook_source, "", *rendered[1]]),
        )

    if not parts.path.rstrip("/").endswith("/search"):
        raise AdapterMiss
    query = (parse_qs(parts.query).get("q") or [""])[0].strip()
    if not query:
        raise AdapterMiss
    payload = _json(
        get(
            "https://backend.commanderspellbook.com/variants/"
            f"?q={quote(query)}&limit=10",
            _JSON,
        )
    )
    results = payload.get("results")
    if not isinstance(results, list) or not results:
        raise AdapterMiss
    heading = f'Commander Spellbook — combos matching "{query}"'
    lines = [heading, _spellbook_source, ""]
    for result in results:
        rendered = _spellbook_combo(result)
        if rendered is not None:
            lines += [f"## {rendered[0]}"] + rendered[1] + [""]
    return SiteReading(title=heading, text="\n".join(lines).rstrip())


def _spellbook_combo(payload: Any) -> tuple[str, list[str]] | None:
    if not isinstance(payload, dict):
        return None
    used = [
        str((one.get("card") or {}).get("name") or "").strip()
        for one in (payload.get("uses") or [])
        if isinstance(one, dict)
    ]
    used = [name for name in used if name]
    if not used:
        return None
    lines = []
    identity = payload.get("identity")
    popularity = payload.get("popularity")
    facts = []
    if identity:
        facts.append(f"colour identity {identity}")
    if isinstance(popularity, int):
        facts.append(f"in {_thousands(popularity)} decks")
    if facts:
        lines.append(" · ".join(facts))
    produces = [
        str((one.get("feature") or {}).get("name") or "").strip()
        for one in (payload.get("produces") or [])
        if isinstance(one, dict)
    ]
    if any(produces):
        lines.append("Produces: " + "; ".join(one for one in produces if one))
    for label, key in (("Needs", "manaNeeded"), ("Requires", "easyPrerequisites")):
        value = _plain(payload.get(key))
        if value:
            lines.append(f"{label}: {value}")
    steps = _plain(payload.get("description"))
    if steps:
        lines.append("Steps: " + steps)
    return " + ".join(used), lines


def _plain(value: Any) -> str:
    """Spellbook returns some fields as HTML fragments and some as plain strings."""

    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value)).strip()


# ----------------------------------------------------------------------- cEDHstat


_CEDHSTAT_DECK = re.compile(r"^/decklists/(\d+)/?$")


def _cedhstat(parts: Any, get: Getter) -> SiteReading:
    matched = _CEDHSTAT_DECK.match(parts.path)
    if matched is None:
        raise AdapterMiss
    payload = _json(
        get(f"https://cedhstat.com/api/decklists/{matched.group(1)}", _JSON)
    )
    cards = payload.get("cards")
    if not isinstance(cards, list) or not cards:
        raise AdapterMiss

    commanders = str(payload.get("commanders") or "").strip()
    name = commanders or "cEDH tournament decklist"
    facts = []
    for label, key in (
        ("player", "player_name"), ("tournament", "tournament_name"),
        ("colour identity", "color_identity"),
    ):
        value = str(payload.get(key) or "").strip()
        if value:
            facts.append(f"{label} {value}")
    standing, field = payload.get("standing"), payload.get("participant_count")
    if isinstance(standing, int) and isinstance(field, int):
        facts.append(f"placed {standing} of {field}")
    record = [payload.get("wins"), payload.get("losses"), payload.get("draws")]
    if all(isinstance(one, int) for one in record):
        facts.append("record {}-{}-{}".format(*record))

    sections: dict[str, Counter[str]] = {}
    for entry in cards:
        if not isinstance(entry, dict):
            continue
        card_name = str(entry.get("card_name") or "").strip()
        if not card_name:
            continue
        if entry.get("card_uuid") is None:
            # cEDHstat files three settings — `format`, `game`, `importedFrom` — in the
            # same array as the cards, distinguished only by having no card behind
            # them. Rendering those would put three things that are not cards into a
            # decklist, which is the one mistake this whole feature exists to prevent.
            continue
        count = entry.get("count")
        section = str(entry.get("section") or "Deck").strip() or "Deck"
        sections.setdefault(section, Counter())[card_name] += (
            count if isinstance(count, int) and count > 0 else 1
        )

    lines = [name, _provenance("cEDHstat's tournament API, not from the page's HTML")]
    if facts:
        lines += ["", " · ".join(facts)]
    for section in _ordered_groups(sections, set()):
        lines += ["", *_card_block(section, sections[section], noted=False)]
    return SiteReading(title=f"{name} | cEDHstat", text="\n".join(lines))


# ----------------------------------------------------------------------- dispatch


def _json(body: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError) as exc:
        # Includes the case where the byte cap cut the download mid-object, which is a
        # miss rather than an error: the generic reader can still have the page.
        raise AdapterMiss from exc
    if not isinstance(payload, dict):
        raise AdapterMiss
    return payload


Adapter = Callable[[Any, Getter], SiteReading]

# Host — with any `www.` already stripped — to the adapter that reads it. Sites that
# answer 403 to everything are deliberately absent: Moxfield (every endpoint including
# its front page), Deckstats, mtgdecks.net, and MTGTop8, which times out. A hardcoded
# refusal for those would outlive the block; letting the fetch report the 403 will not.
_ADAPTERS: Final[dict[str, Adapter]] = {
    "edhrec.com": _edhrec,
    "archidekt.com": _archidekt,
    "mtggoldfish.com": _goldfish,
    "tappedout.net": _tappedout,
    "aetherhub.com": _aetherhub,
    "commanderspellbook.com": _spellbook,
    "cedhstat.com": _cedhstat,
}


def read_known_site(url: str, get: Getter) -> SiteReading | None:
    """Render a known page from its own data, or return None to read it generically."""

    parts = urlsplit(url)
    host = (parts.hostname or "").lower().removeprefix("www.")
    adapter = _ADAPTERS.get(host)
    if adapter is None:
        return None
    try:
        return adapter(parts, get)
    except AdapterMiss:
        return None


def known_hosts() -> Sequence[str]:
    """The hosts with an adapter, for the tool description and for tests."""

    return tuple(sorted(_ADAPTERS))
