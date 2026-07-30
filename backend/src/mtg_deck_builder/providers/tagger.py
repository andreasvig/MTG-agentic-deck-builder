"""Read-only client for the Scryfall Tagger website's GraphQL data."""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass
from http.cookies import SimpleCookie
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pydantic import BaseModel, ConfigDict, Field, ValidationError

_SEARCH_EDGES_QUERY = """
query SearchEdges($input: EdgeSearchInput!) {
  edges(input: $input) {
    page
    perPage
    total
    results {
      classifier
      subjectId
      subjectName
      foreignKey
      id
      namespace
      relatedId
      relatedName
      type
      ... on Tagging {
        annotation
        createdAt
        creatorId
        pendingRevisions
        status
        weight
        tag {
          category
          createdAt
          creatorId
          description
          hasExemplaryTagging
          id
          name
          namespace
          pendingRevisions
          slug
          status
          type
        }
      }
      ... on Relationship {
        annotation
        classifierInverse
        createdAt
        creatorId
        name
        pendingRevisions
        status
      }
    }
  }
}
""".strip()

_CSRF_PATTERN = re.compile(r'<meta name="csrf-token" content="([^"]+)"')
_RETRYABLE_HTTP_STATUS = {429, 500, 502, 503, 504}


class TaggerUnavailable(RuntimeError):
    """Raised when Tagger data cannot be read or validated."""


class TaggerTag(BaseModel):
    """One tag definition returned beside a tagging edge."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    id: str
    name: str
    slug: str
    namespace: str
    type: str
    status: str
    category: bool = False
    description: str | None = None
    created_at: str | None = Field(default=None, alias="createdAt")
    creator_id: str | None = Field(default=None, alias="creatorId")
    pending_revisions: int | None = Field(default=None, alias="pendingRevisions")
    has_exemplary_tagging: bool | None = Field(
        default=None,
        alias="hasExemplaryTagging",
    )


class TaggerBulkOracleTag(BaseModel):
    """One Oracle tag and all memberships from Scryfall's bulk tag payload."""

    model_config = ConfigDict(extra="ignore")

    object: str
    id: str
    label: str
    type: Literal["oracle"]
    description: str | None = None
    oracle_ids: list[str]


class _BulkOracleTagList(BaseModel):
    model_config = ConfigDict(extra="ignore")

    object: Literal["list"]
    has_more: bool
    data: list[TaggerBulkOracleTag]


class TaggerEdge(BaseModel):
    """One Tagger tagging or relationship edge."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    id: str
    type: Literal["TAGGING", "RELATIONSHIP"]
    classifier: str
    namespace: str
    subject_id: str = Field(alias="subjectId")
    subject_name: str = Field(alias="subjectName")
    foreign_key: str = Field(alias="foreignKey")
    related_id: str = Field(alias="relatedId")
    related_name: str | None = Field(default=None, alias="relatedName")
    status: str | None = None
    weight: str | None = None
    annotation: str | None = None
    classifier_inverse: str | None = Field(default=None, alias="classifierInverse")
    created_at: str | None = Field(default=None, alias="createdAt")
    creator_id: str | None = Field(default=None, alias="creatorId")
    pending_revisions: int | None = Field(default=None, alias="pendingRevisions")
    name: str | None = None
    tag: TaggerTag | None = None


class TaggerEdgePage(BaseModel):
    """One numbered page from Tagger's edge search."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    page: int = Field(ge=1)
    per_page: int = Field(alias="perPage", ge=1)
    total: int = Field(ge=0)
    results: list[TaggerEdge]


class _GraphQLData(BaseModel):
    model_config = ConfigDict(extra="ignore")

    edges: TaggerEdgePage


class _GraphQLResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    data: _GraphQLData | None = None
    errors: list[dict[str, Any]] = Field(default_factory=list)


@dataclass
class _Session:
    csrf_token: str
    cookie_header: str
    generation: int


class _RequestRateLimiter:
    def __init__(self, interval_seconds: float) -> None:
        self._interval_seconds = interval_seconds
        self._next_start = 0.0
        self._lock = threading.Lock()

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            delay = self._next_start - now
            if delay > 0:
                time.sleep(delay)
                now = time.monotonic()
            self._next_start = now + self._interval_seconds


class TaggerClient:
    """Fetch paginated Tagger edges with a rate limit and bounded retries.

    Tagger does not currently publish a stable public API. This client mirrors
    the read-only GraphQL request used by its own website and deliberately lives
    behind the provider boundary so the importer can be replaced if that
    interface changes.
    """

    def __init__(
        self,
        *,
        base_url: str,
        scryfall_api_base_url: str,
        user_agent: str,
        timeout_seconds: float,
        request_interval_seconds: float,
        max_retries: int,
        open_url: Any = urlopen,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.scryfall_api_base_url = scryfall_api_base_url.rstrip("/")
        self.user_agent = user_agent
        self.timeout_seconds = timeout_seconds
        self.max_retries = max_retries
        self._open_url = open_url
        self._rate_limiter = _RequestRateLimiter(request_interval_seconds)
        self._session: _Session | None = None
        self._session_generation = 0
        self._session_lock = threading.Lock()

    def fetch_oracle_tags(self) -> list[TaggerBulkOracleTag]:
        """Fetch Scryfall's complete Oracle-tag membership payload."""

        request = Request(
            f"{self.scryfall_api_base_url}/private/tags/oracle",
            headers={
                "Accept": "application/json",
                "User-Agent": self.user_agent,
            },
        )
        body = self._read_with_retries(request)
        try:
            payload = _BulkOracleTagList.model_validate_json(body)
        except ValidationError as exc:
            raise TaggerUnavailable("Scryfall returned an unexpected Oracle-tag payload") from exc
        if payload.has_more:
            raise TaggerUnavailable("Scryfall Oracle-tag payload unexpectedly requires pagination")
        return payload.data

    def search_edges(
        self,
        *,
        edge_type: Literal["TAGGING", "RELATIONSHIP"],
        page: int,
        classifiers: list[str] | None = None,
    ) -> TaggerEdgePage:
        """Fetch one edge page.

        Oracle taggings can be selected server-side with the
        ``ORACLE_CARD_TAG`` classifier. Relationship pages are intentionally
        fetched without a classifier list so future Oracle-card relationship
        kinds are retained and filtered by ``foreignKey`` during import.
        """

        input_payload: dict[str, object] = {"type": edge_type, "page": page}
        if classifiers:
            input_payload["classifier"] = classifiers
        payload = {
            "query": _SEARCH_EDGES_QUERY,
            "variables": {"input": input_payload},
            "operationName": "SearchEdges",
        }
        body = self._post_graphql(payload)
        try:
            response = _GraphQLResponse.model_validate_json(body)
        except ValidationError as exc:
            raise TaggerUnavailable("Tagger returned an unexpected response") from exc
        if response.errors:
            message = str(response.errors[0].get("message") or "unknown GraphQL error")
            raise TaggerUnavailable(f"Tagger GraphQL request failed: {message}")
        if response.data is None:
            raise TaggerUnavailable("Tagger GraphQL response did not contain data")
        return response.data.edges

    def _post_graphql(self, payload: dict[str, object]) -> bytes:
        encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode()
        last_error: BaseException | None = None
        refreshed_generation: int | None = None

        for attempt in range(self.max_retries + 1):
            session = self._get_session()
            request = Request(
                f"{self.base_url}/graphql",
                data=encoded,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "Cookie": session.cookie_header,
                    "Origin": self.base_url,
                    "Referer": f"{self.base_url}/",
                    "User-Agent": self.user_agent,
                    "X-CSRF-Token": session.csrf_token,
                },
                method="POST",
            )
            try:
                return self._read_once(request)
            except HTTPError as exc:
                last_error = exc
                if exc.code == 403 and refreshed_generation != session.generation:
                    self._invalidate_session(session.generation)
                    refreshed_generation = session.generation
                    continue
                if exc.code not in _RETRYABLE_HTTP_STATUS or attempt >= self.max_retries:
                    break
                self._sleep_before_retry(attempt, exc.headers.get("Retry-After"))
            except (TimeoutError, URLError, OSError) as exc:
                last_error = exc
                if attempt >= self.max_retries:
                    break
                self._sleep_before_retry(attempt)

        raise TaggerUnavailable("Tagger request failed after bounded retries") from last_error

    def _read_with_retries(self, request: Request) -> bytes:
        last_error: BaseException | None = None
        for attempt in range(self.max_retries + 1):
            try:
                return self._read_once(request)
            except HTTPError as exc:
                last_error = exc
                if exc.code not in _RETRYABLE_HTTP_STATUS or attempt >= self.max_retries:
                    break
                self._sleep_before_retry(attempt, exc.headers.get("Retry-After"))
            except (TimeoutError, URLError, OSError) as exc:
                last_error = exc
                if attempt >= self.max_retries:
                    break
                self._sleep_before_retry(attempt)
        raise TaggerUnavailable("Scryfall Oracle-tag request failed") from last_error

    def _read_once(self, request: Request) -> bytes:
        self._rate_limiter.wait()
        with self._open_url(request, timeout=self.timeout_seconds) as response:
            return response.read()

    def _get_session(self) -> _Session:
        with self._session_lock:
            if self._session is not None:
                return self._session
            request = Request(
                f"{self.base_url}/",
                headers={
                    "Accept": "text/html,application/xhtml+xml",
                    "User-Agent": self.user_agent,
                },
            )
            self._rate_limiter.wait()
            try:
                with self._open_url(request, timeout=self.timeout_seconds) as response:
                    html = response.read().decode("utf-8")
                    cookie_values = response.headers.get_all("Set-Cookie") or []
            except (HTTPError, TimeoutError, URLError, OSError) as exc:
                raise TaggerUnavailable("Could not establish a Tagger session") from exc

            match = _CSRF_PATTERN.search(html)
            if match is None:
                raise TaggerUnavailable("Tagger page did not contain a CSRF token")
            cookies = SimpleCookie()
            for value in cookie_values:
                cookies.load(value)
            cookie_header = "; ".join(f"{name}={morsel.value}" for name, morsel in cookies.items())
            if not cookie_header:
                raise TaggerUnavailable("Tagger page did not establish a session cookie")
            self._session_generation += 1
            self._session = _Session(
                csrf_token=match.group(1),
                cookie_header=cookie_header,
                generation=self._session_generation,
            )
            return self._session

    def _invalidate_session(self, generation: int) -> None:
        with self._session_lock:
            if self._session is not None and self._session.generation == generation:
                self._session = None

    @staticmethod
    def _sleep_before_retry(attempt: int, retry_after: str | None = None) -> None:
        try:
            delay = float(retry_after) if retry_after is not None else 0
        except ValueError:
            delay = 0
        time.sleep(max(delay, min(2**attempt, 30)))
