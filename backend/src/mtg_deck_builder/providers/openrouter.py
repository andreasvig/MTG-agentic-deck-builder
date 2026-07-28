"""Small async boundary for OpenRouter chat completions."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


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

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        request = Request(
            self._url,
            data=json.dumps(payload, ensure_ascii=True).encode("utf-8"),
            method="POST",
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "http://127.0.0.1",
                "X-Title": "MTG Agentic Deck Builder",
            },
        )
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


def _parse_json_or_text(body: bytes) -> object:
    try:
        return json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return body.decode("utf-8", errors="replace")
