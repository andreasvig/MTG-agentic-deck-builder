"""Small async boundary for OpenRouter chat completions."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from typing import Any, Final
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

_STREAM_END: Final = object()
"""The `data: [DONE]` sentinel, which is not a chunk and is not an error."""


class OpenRouterError(RuntimeError):
    """OpenRouter could not return a valid chat-completion response."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        response_body: object | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


class OpenRouterClient:
    """Post JSON chat-completion requests without leaking credentials."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        timeout_seconds: float,
        open_url: Callable[..., Any] = urlopen,
    ) -> None:
        if not api_key.strip():
            raise ValueError("OpenRouter API key must not be blank")
        self._api_key = api_key
        self._url = f"{base_url.rstrip('/')}/chat/completions"
        self._timeout_seconds = timeout_seconds
        self._open_url = open_url

    async def chat_completion(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Return one validated JSON object from OpenRouter."""

        return await asyncio.to_thread(self._post, payload)

    async def stream_chat_completion(
        self,
        payload: dict[str, Any],
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield each chunk of one streamed completion as it arrives.

        The connection is opened and read in worker threads, one line at a time, so
        this boundary keeps its dependency-free transport and its injectable
        `open_url` instead of growing an async HTTP client. Reads are strictly
        sequential, so the response object is only ever touched by one thread.
        """

        streamed = {**payload, "stream": True}
        response = await asyncio.to_thread(self._open_stream, streamed)
        try:
            while True:
                line = await asyncio.to_thread(response.readline)
                if not line:
                    return
                chunk = _stream_chunk(line)
                if chunk is _STREAM_END:
                    return
                if isinstance(chunk, dict):
                    yield chunk
        finally:
            await asyncio.to_thread(response.close)

    def _open_stream(self, payload: dict[str, Any]) -> Any:
        request = self._build_request(payload, accept="text/event-stream")
        try:
            return self._open_url(request, timeout=self._timeout_seconds)
        except HTTPError as exc:
            parsed = _parse_json_or_text(exc.read())
            raise OpenRouterError(
                f"OpenRouter returned HTTP {exc.code}",
                status_code=exc.code,
                response_body=parsed,
            ) from exc
        except (OSError, URLError) as exc:
            raise OpenRouterError("OpenRouter could not be reached") from exc

    def _build_request(
        self,
        payload: dict[str, Any],
        *,
        accept: str = "application/json",
    ) -> Request:
        return Request(
            self._url,
            data=json.dumps(payload, ensure_ascii=True).encode("utf-8"),
            method="POST",
            headers={
                "Accept": accept,
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "http://127.0.0.1",
                "X-Title": "MTG Agentic Deck Builder",
            },
        )

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        request = self._build_request(payload)
        try:
            with self._open_url(request, timeout=self._timeout_seconds) as response:
                body = response.read()
        except HTTPError as exc:
            parsed = _parse_json_or_text(exc.read())
            raise OpenRouterError(
                f"OpenRouter returned HTTP {exc.code}",
                status_code=exc.code,
                response_body=parsed,
            ) from exc
        except (OSError, URLError) as exc:
            raise OpenRouterError("OpenRouter could not be reached") from exc

        parsed = _parse_json_or_text(body)
        if not isinstance(parsed, dict):
            raise OpenRouterError(
                "OpenRouter returned a non-object response",
                response_body=parsed,
            )
        return parsed


def completion_cost_usd(response: dict[str, Any]) -> float | None:
    """Return what one completion cost, as OpenRouter itself accounted for it.

    `usage.cost` is the provider's own charge in USD credits, so it is the only
    honest source: token counts multiplied by a hardcoded price would drift the
    moment a model or its routing changed. An absent or non-numeric figure returns
    `None` rather than `0.0`, because "not reported" and "free" are different
    claims and only one of them is safe to add into a total.
    """

    usage = response.get("usage")
    if not isinstance(usage, dict):
        return None
    cost = usage.get("cost")
    if isinstance(cost, bool) or not isinstance(cost, (int, float)):
        return None
    return float(cost)


def _stream_chunk(line: bytes) -> object:
    """Read one SSE line, or report that it carried nothing.

    OpenRouter sends `: OPENROUTER PROCESSING` comments as keep-alives while a
    reasoning model thinks, so a line that is not a `data:` payload is ordinary
    traffic rather than a fault. An error, on the other hand, arrives inside a chunk
    once the response has already begun, and has to be raised rather than yielded.
    """

    text = line.decode("utf-8", errors="replace").strip()
    if not text or text.startswith(":") or not text.startswith("data:"):
        return None
    data = text[len("data:") :].strip()
    if data == "[DONE]":
        return _STREAM_END
    try:
        chunk = json.loads(data)
    except json.JSONDecodeError:
        return None
    if not isinstance(chunk, dict):
        return None
    error = chunk.get("error")
    if error is not None:
        message = error.get("message") if isinstance(error, dict) else None
        raise OpenRouterError(
            str(message) if message else "OpenRouter reported a streaming error",
            response_body=error,
        )
    return chunk


def _parse_json_or_text(body: bytes) -> object:
    try:
        return json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return body.decode("utf-8", errors="replace")
