"""Fetch one web page as readable text, for an agent that was handed a link.

This is the plain-fetch half of web research: `search_web` returns a summary and its
sources, and this is how the agent reads one of those sources itself rather than
trusting the summary of it. There is no JavaScript here and no rendering — a page that
only exists after its scripts run comes back nearly empty, and saying so is the honest
outcome. A headless or Firecrawl-style fetch is the upgrade path, deliberately not
taken yet.

A handful of sites are read through their own data instead of their markup, because on
those the generic extraction is not just noisy but wrong — see `web_sites`. That is a
detail of this reader, not a second tool: the agent calls `read_page` with whatever URL
it has, and pagination works the same either way.

The URL comes from a model, so it is treated as untrusted input: the scheme is
restricted, the resolved address must be public, the response is capped in bytes
before it is read, and only HTML and plain text are accepted. A local-first app on a
laptop still has a loopback API and a cloud-metadata endpoint on the same network
stack, and neither is something a chat message should be able to reach.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from typing import Any, Final
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from .web_sites import read_known_site

_ALLOWED_SCHEMES: Final = frozenset({"http", "https"})

# How many distinct fetches the short-lived cache keeps. A read walks one document,
# so this only has to span the parts of it plus whatever an adapter fetched alongside.
_CACHE_ENTRIES: Final = 8

# What one fetch returns: content type, body, and the URL after any redirect.
_Fetched = tuple[str, bytes, str]

# Content this reader can turn into text. Anything else — a PDF, an image, a download —
# is reported rather than decoded into mojibake.
_READABLE_TYPES: Final = ("text/html", "application/xhtml+xml", "text/plain")

# Tags whose content is markup machinery, never prose. `nav` is here because site
# navigation is the first thing on almost every page and would otherwise spend a good
# part of the character budget before the article starts. `header` and `footer` are
# deliberately not: on plenty of article pages the headline lives in one of them.
_SKIPPED: Final = frozenset(
    {"script", "style", "noscript", "template", "svg", "canvas", "nav"}
)

# Hosts that serve an empty shell to a plain fetch and build the page in the browser.
# Measured, not assumed: `www.reddit.com` returns no readable text at all, and YouTube
# returns its cookie footer with a 200, which is worse — it looks like a result. Naming
# them costs the agent one clear sentence instead of one wasted tool round.
#
# YouTube stays on this list even though it has an adapter, because the adapter only
# handles a *video*. The refusal runs after the adapters, so a watch URL is read and a
# channel or a search URL still gets the honest refusal rather than a cookie footer.
_NEEDS_RENDERING: Final = frozenset(
    {
        "youtube.com", "m.youtube.com", "youtu.be",
        "facebook.com", "instagram.com", "tiktok.com",
        "x.com", "twitter.com", "threads.net",
        # Moxfield is the largest deckbuilding site there is and it cannot be read at
        # all: its API answers 403 to everything, and a page like `/decks/public`
        # answers 200 with forty-three characters saying "Loading Moxfield. This may
        # take a minute..." — a placeholder that reads exactly like a short deck.
        "moxfield.com",
    }
)

# Rewrites that turn a host this reader cannot read into one it can. Reddit is the
# single most-cited domain in a Sonar answer and its modern front end is script-built,
# while `old.reddit.com` serves the same thread as ordinary HTML.
_REWRITTEN_HOSTS: Final = {
    "www.reddit.com": "old.reddit.com",
    "reddit.com": "old.reddit.com",
    "new.reddit.com": "old.reddit.com",
}

# Tags that end a line of prose. Without these the whole page collapses into one
# paragraph and a decklist becomes unreadable, which is the main thing worth reading.
_BREAKING: Final = frozenset(
    {
        "p", "div", "br", "li", "tr", "section", "article", "header", "footer",
        "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table", "ul", "ol",
    }
)

_BLANK_RUN = re.compile(r"\n{3,}")
# `\xa0` is the non-breaking space, which is ordinary in rendered HTML and would
# otherwise survive into the text as an invisible non-space.
_SPACE_RUN = re.compile(r"[ \t\xa0]+")


class WebPageUnavailable(RuntimeError):
    """A page could not be fetched or could not be read as text."""


@dataclass(frozen=True)
class WebPage:
    """One slice of one fetched page, reduced to what a reader needs.

    A long document is paginated rather than cut off, so `text` is the requested page
    of it and `total_pages` says how many there are. Nothing is held between calls: the
    next page refetches the URL and re-slices it, which keeps this boundary as stateless
    as the rest of the backend at the cost of one more request.

    `truncated` is a different claim from `page < total_pages`, and the two must not be
    conflated. It means the *download* hit the byte cap, so even the last page is not
    the end of the document — there is more that was never fetched at all.
    """

    url: str
    title: str | None
    text: str
    page: int
    total_pages: int
    truncated: bool
    # True when a site adapter rendered this from the site's own data rather than from
    # its markup. What that changes is how far the reader should trust the numbers in
    # it, which is a different answer for a database export than for a model's prose.
    from_site_data: bool = False
    # The card names an adapter declared *and* that survived into this part. Declared
    # by the adapter rather than parsed back out of `text`, so it never mistakes a
    # heading or a total for a card.
    card_names: tuple[str, ...] = ()

    @property
    def has_more_pages(self) -> bool:
        return self.page < self.total_pages


class _TextExtractor(HTMLParser):
    """Collect a page's prose and its title, discarding markup machinery.

    A break is recorded as a pending flag rather than written straight out, so that a
    run of tags — `</li><li>`, a closed paragraph inside a closed div — yields one
    newline rather than one per tag. On a hundred-card decklist that difference is
    half the character budget spent on blank lines.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title: str | None = None
        self._parts: list[str] = []
        self._skip_depth = 0
        self._in_title = False
        self._pending_break = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _SKIPPED:
            self._skip_depth += 1
        elif tag == "title":
            self._in_title = True
        elif tag in _BREAKING:
            self._pending_break = True

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIPPED:
            self._skip_depth = max(0, self._skip_depth - 1)
        elif tag == "title":
            self._in_title = False
        elif tag in _BREAKING:
            self._pending_break = True

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        if self._in_title:
            self.title = ((self.title or "") + data).strip() or None
            return
        if not data.strip():
            # Whitespace between tags is layout, and must not cancel a pending break.
            return
        if self._pending_break and self._parts:
            self._parts.append("\n")
        self._pending_break = False
        self._parts.append(data)

    def text(self) -> str:
        joined = _SPACE_RUN.sub(" ", "".join(self._parts))
        lines = [line.strip() for line in joined.split("\n")]
        return _BLANK_RUN.sub("\n\n", "\n".join(lines)).strip()


class WebPageFetcher:
    """Read one page over plain HTTP, with the guards a model-supplied URL needs."""

    def __init__(
        self,
        *,
        timeout_seconds: float,
        max_characters: int,
        max_bytes: int,
        user_agent: str,
        cache_seconds: float = 0.0,
        open_url: Any = urlopen,
        resolve: Any = socket.getaddrinfo,
        clock: Any = time.monotonic,
    ) -> None:
        self._timeout_seconds = timeout_seconds
        self._max_characters = max_characters
        self._max_bytes = max_bytes
        self._user_agent = user_agent
        self._cache_seconds = cache_seconds
        self._open_url = open_url
        self._resolve = resolve
        self._clock = clock
        self._cache: OrderedDict[tuple[str, str], tuple[float, _Fetched]] = OrderedDict()
        self._cache_lock = threading.Lock()

    async def fetch(self, url: str, page: int = 1) -> WebPage:
        """Return one page of one document's text, or say why it could not be read."""

        return await asyncio.to_thread(self._fetch, url, page)

    def _fetch(self, url: str, page: int = 1) -> WebPage:
        target = self._checked_url(url)

        # A known site is read through its own data first — see `web_sites`. The
        # adapters share this fetcher's guards because they are handed `self._get`,
        # and a miss returns None so the page is still read the ordinary way.
        #
        # This runs *before* the renderer refusal below, so an adapter may claim a
        # host that a plain fetch cannot read — YouTube is exactly that case.
        try:
            reading = read_known_site(target, self._get)
        except WebPageUnavailable:
            # An adapter's endpoint failing is not the same as the page failing, so
            # this falls through rather than reporting. The generic reader is always
            # available and is sometimes the only thing that still works.
            reading = None
        if reading is not None:
            return self._paged(
                url=target,
                title=reading.title,
                text=reading.text,
                page=page,
                oversized=False,
                from_site_data=True,
                cards=reading.cards,
            )
        self._refuse_if_it_needs_a_renderer(target)

        content_type, body, final_url = self._get_readable(target)
        oversized = len(body) > self._max_bytes
        decoded = body[: self._max_bytes].decode(_charset(content_type), errors="replace")
        if "text/plain" in content_type:
            title, text = None, decoded.strip()
        else:
            extractor = _TextExtractor()
            # A body cut mid-tag is ordinary here, and `HTMLParser` tolerates it.
            extractor.feed(decoded)
            title, text = extractor.title, extractor.text()

        if not text:
            raise WebPageUnavailable(
                "That page has no readable text. It most likely builds its content "
                "with JavaScript, which this reader does not run."
            )
        return self._paged(
            url=final_url,
            title=unescape(title) if title else None,
            text=text,
            page=page,
            oversized=oversized,
        )

    def _paged(
        self,
        *,
        url: str,
        title: str | None,
        text: str,
        page: int,
        oversized: bool,
        from_site_data: bool = False,
        cards: tuple[str, ...] = (),
    ) -> WebPage:
        """Split one document and return the requested part of it.

        Shared by both routes so an adapter's rendering paginates exactly the way prose
        does, and the agent never has to know which one produced the text it is reading.
        """

        pages = _paginate(text, self._max_characters)
        if page > len(pages):
            # Naming the real count is what makes this recoverable in one more call,
            # rather than the caller guessing its way back into range.
            raise WebPageUnavailable(
                f"That page has only {len(pages)} "
                f"{'part' if len(pages) == 1 else 'parts'}, so there is no part "
                f"{page} to read."
            )
        return WebPage(
            url=url,
            title=title,
            text=pages[page - 1],
            page=page,
            total_pages=len(pages),
            truncated=oversized,
            from_site_data=from_site_data,
            # Narrowed to this part, because a reader can only act on what it can see.
            # Order and duplicates are dropped here, not by the adapters.
            card_names=tuple(
                dict.fromkeys(card for card in cards if card in pages[page - 1])
            ),
        )

    def _refuse_if_it_needs_a_renderer(self, url: str) -> None:
        """Stop before fetching a page that only exists once its scripts have run.

        Checked after the adapters rather than before, so a host on this list can
        still be read when there is a way to read it — YouTube has no readable HTML
        but does answer oEmbed, and refusing it before the adapter ran would throw
        that away.
        """

        bare = (urlsplit(url).hostname or "").lower().removeprefix("www.")
        if bare in _NEEDS_RENDERING:
            raise WebPageUnavailable(
                f"{bare} builds its pages in the browser, so a plain fetch reads "
                "nothing useful from it. Whatever the search summary said about this "
                "source is all there is without a rendering fetch."
            )

    def _get(self, url: str, accept: str) -> bytes:
        """Fetch one URL under this fetcher's guards, for a site adapter to parse.

        An adapter's endpoint is derived from a URL that already passed `_checked_url`,
        but it is a different host and a different path, so it goes through the same
        checks rather than around them.
        """

        return self._get_body(self._checked_url(url), accept)[1]

    def _get_readable(self, target: str) -> tuple[str, bytes, str]:
        """Fetch a page the generic reader is about to turn into text."""

        content_type, body, final_url = self._get_body(
            target, "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1"
        )
        if not any(kind in content_type for kind in _READABLE_TYPES):
            raise WebPageUnavailable(
                f"That page is {content_type or 'an unknown type'}, "
                "which this reader cannot turn into text."
            )
        return content_type, body, final_url

    def _get_body(self, target: str, accept: str) -> _Fetched:
        """Fetch one URL, reusing a very recent identical fetch if there is one.

        Pagination refetches by design — nothing is held between `read_page` calls —
        which without this makes reading a five-part EDHREC page five identical
        137 KB requests. The cache also closes the one honest gap in that design: a
        document that changed between part one and part two would move every boundary
        after it, and within the window the parts now come from one download.

        Deliberately short and small. This is for the span of one read, not a store.
        """

        # One flag rather than the same comparison on both sides. Written as two
        # separate checks, either one alone was unobservable — a store nothing reads
        # and a read of a store nothing writes both behave exactly like no cache — so
        # neither could be tested, and a test that cannot fail is not a test.
        if not self._caching():
            return self._fetch_body(target, accept)
        key = (target, accept)
        with self._cache_lock:
            found = self._cache.get(key)
            if found is not None and self._clock() - found[0] < self._cache_seconds:
                return found[1]
        fetched = self._fetch_body(target, accept)
        with self._cache_lock:
            self._cache[key] = (self._clock(), fetched)
            while len(self._cache) > _CACHE_ENTRIES:
                self._cache.popitem(last=False)
        return fetched

    def _caching(self) -> bool:
        """A fast path, not the thing that disables the cache.

        A zero window is already disabled by the age comparison above — nothing can be
        newer than zero seconds old — so this only avoids taking the lock and storing
        entries that could never be read. Worth knowing when reading a mutation report:
        flipping this alone changes no behaviour, and it should not.
        """

        return self._cache_seconds > 0

    def _fetch_body(self, target: str, accept: str) -> _Fetched:
        request = Request(
            target,
            method="GET",
            headers={
                "User-Agent": self._user_agent,
                "Accept": accept,
                "Accept-Language": "en",
            },
        )
        try:
            with self._open_url(request, timeout=self._timeout_seconds) as response:
                # Capped before the read, not after: a caller must not be able to pull
                # an arbitrarily large body into memory by naming a big file.
                return (
                    _content_type(response),
                    response.read(self._max_bytes + 1),
                    str(getattr(response, "url", target) or target),
                )
        except HTTPError as exc:
            raise WebPageUnavailable(
                f"That page returned HTTP {exc.code}."
                + (
                    " Many sites block automated readers this way."
                    if exc.code in (401, 403, 429)
                    else ""
                )
            ) from exc
        except (OSError, URLError) as exc:
            raise WebPageUnavailable("That page could not be reached.") from exc

    def _checked_url(self, url: str) -> str:
        """Reject anything that is not a public http(s) page, before connecting."""

        candidate = url.strip()
        parts = urlsplit(candidate)
        if parts.scheme.lower() not in _ALLOWED_SCHEMES:
            raise WebPageUnavailable(
                "Only http and https pages can be read; "
                f"{parts.scheme or 'that'} is not one."
            )
        host = parts.hostname
        if not host:
            raise WebPageUnavailable("That is not a URL this reader can open.")

        replacement = _REWRITTEN_HOSTS.get(host.lower())
        if replacement is not None:
            parts = parts._replace(netloc=replacement)
            candidate = parts.geturl()
            host = replacement
        try:
            resolved = self._resolve(host, parts.port or (443 if parts.scheme == "https" else 80))
        except OSError as exc:
            raise WebPageUnavailable(f"{host} could not be resolved.") from exc
        for info in resolved:
            address = ipaddress.ip_address(info[4][0])
            if not address.is_global or address.is_loopback or address.is_private:
                raise WebPageUnavailable(
                    f"{host} resolves to a private address, which cannot be read."
                )
        return candidate


def _paginate(text: str, size: int) -> list[str]:
    """Split one document into readable parts of at most `size` characters.

    Deterministic on the text, because nothing is stored between calls: page 2 is
    produced by fetching the URL again and splitting it again, so the same document
    must always split the same way or the parts would overlap or skip.

    Breaks land on a line ending where one is available in the back half of the window,
    which is what stops a decklist from being cut through a card name. A stretch with no
    line ending — one long paragraph — is cut at the cap instead, because backing off
    further would emit a page far shorter than the budget.
    """

    if len(text) <= size:
        return [text]
    pages: list[str] = []
    start = 0
    while start < len(text):
        if len(text) - start <= size:
            pages.append(text[start:])
            break
        window = text[start : start + size]
        cut = window.rfind("\n")
        if cut < size // 2:
            cut = size
        pages.append(text[start : start + cut].rstrip())
        start += cut
        # A break taken at a line ending leaves it at the head of the next page.
        while start < len(text) and text[start] == "\n":
            start += 1
    return [page for page in pages if page] or [text[:size]]


def _content_type(response: Any) -> str:
    headers = getattr(response, "headers", None)
    raw = headers.get("Content-Type") if headers is not None else None
    return str(raw or "").lower()


def _charset(content_type: str) -> str:
    for piece in content_type.split(";"):
        piece = piece.strip()
        if piece.startswith("charset="):
            name = piece[len("charset=") :].strip().strip('"')
            if name:
                return name
    return "utf-8"
