"""Ask Perplexity Sonar a question about Magic, and keep its sources.

This is the one thing the local catalog cannot do: find what people have *said* about a
card or an archetype — brews, primers, discussion, decklists — rather than what a card
prints. The catalog stays the authority on every fact a card carries; Sonar is only
ever the authority on where to look.

That split is not a preference, it is what a bake-off across the four Sonar tiers
measured (see `docs/decisions/0040-web-research-through-sonar.md`). The reasoning was
consistently sound and the *identifiers* consistently were not: EDHREC deck counts came
back wrong by up to 128x, and a card name arrived as "Gretian Titcho" when the real card
was Gretchen Titchwillow — colours, body and ability all correct, only the name wrong.
A corrupted name is the dangerous case for a deck builder, because the name is the
catalog's lookup key, so the sources travel with every answer and the tool result says
in as many words that nothing here has been checked against the catalog.

`perplexity/sonar` is the chosen tier: at roughly $0.006 and five seconds a call it is
about a tenth the price and a fifth the latency of `sonar-pro-search`, and on the same
questions the pro tiers bought length rather than accuracy — both invented card names in
the bake-off came from `sonar-pro`. `sonar-reasoning-pro` was rejected outright for
returning empty bodies and spurious truncations on roughly a third of calls.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from mtg_deck_builder.config import DeckAgentWebSettings
from mtg_deck_builder.providers.openrouter import (
    OpenRouterClient,
    OpenRouterError,
    completion_cost_usd,
)


class WebSearchUnavailable(RuntimeError):
    """A web search could not be answered."""


@dataclass(frozen=True)
class WebSource:
    """One citation, as the agent will be offered it for a follow-up read."""

    url: str
    title: str | None


@dataclass(frozen=True)
class WebSearchAnswer:
    """What one Sonar call returned: its prose, and where the prose came from."""

    summary: str
    sources: tuple[WebSource, ...]
    cost_usd: float | None


class WebSearchService:
    """Run one Sonar search per call, returning its summary and its citations."""

    def __init__(
        self,
        *,
        model_client: OpenRouterClient | None,
        settings: DeckAgentWebSettings,
    ) -> None:
        self._model_client = model_client
        self._settings = settings

    @property
    def enabled(self) -> bool:
        """Report whether a search can actually be run.

        Without an API key there is no client, and a tool that always fails is worse
        than a tool the model was never offered.
        """

        return self._settings.enabled and self._model_client is not None

    async def search(self, question: str) -> WebSearchAnswer:
        """Answer one question from the live web, with its sources."""

        if self._model_client is None:
            raise WebSearchUnavailable("Web search is not configured.")
        payload: dict[str, Any] = {
            "model": self._settings.model,
            "messages": [
                {"role": "system", "content": self._settings.system_prompt},
                {"role": "user", "content": question},
            ],
            "max_tokens": self._settings.max_tokens,
            # OpenRouter only accounts for a call when asked to, and the cost of a
            # search is the reason this tool has a budget worth watching.
            "usage": {"include": True},
        }
        try:
            response = await self._model_client.chat_completion(payload)
        except OpenRouterError as exc:
            raise WebSearchUnavailable(f"The web search failed: {exc}") from exc

        message = _first_message(response)
        summary = str(message.get("content") or "").strip()
        if not summary:
            # Observed live during the bake-off: a finish_reason of `stop`, no content
            # and no usage block at all. Rare on this tier, and cheap to defend against.
            raise WebSearchUnavailable("The web search came back empty.")
        return WebSearchAnswer(
            summary=summary,
            sources=_sources(message, limit=self._settings.max_sources),
            cost_usd=completion_cost_usd(response),
        )


def _first_message(response: dict[str, Any]) -> dict[str, Any]:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise WebSearchUnavailable("The web search returned nothing to read.")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        raise WebSearchUnavailable("The web search returned nothing to read.")
    return message


def _sources(message: dict[str, Any], *, limit: int) -> tuple[WebSource, ...]:
    """Read the citations off a completion, in the order Sonar numbered them.

    Sonar's prose carries inline `[1]` markers that index into this list, so the order
    is load-bearing and duplicates are dropped rather than reordered — renumbering here
    would silently repoint every marker in the summary.
    """

    annotations = message.get("annotations")
    if not isinstance(annotations, list):
        return ()
    sources: list[WebSource] = []
    seen: set[str] = set()
    for annotation in annotations:
        if not isinstance(annotation, dict) or annotation.get("type") != "url_citation":
            continue
        citation = annotation.get("url_citation")
        if not isinstance(citation, dict):
            continue
        url = str(citation.get("url") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        title = str(citation.get("title") or "").strip() or None
        sources.append(WebSource(url=url, title=title))
        if len(sources) >= limit:
            break
    return tuple(sources)
