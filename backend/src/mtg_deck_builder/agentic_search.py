"""Non-network runtime guards for progressive agentic card search."""

from collections.abc import Iterable
from uuid import UUID

from mtg_deck_builder.domain import (
    AgentRankedSearchOutput,
    CardSearchFilters,
    LocalCardSearchRequest,
)


class AgentSearchContractError(ValueError):
    """An agent response or tool request violated a runtime search boundary."""


def resolve_local_tool_limit(
    request: LocalCardSearchRequest,
    *,
    immutable_filters: CardSearchFilters,
    default_max_results: int,
    hard_max_results: int,
) -> int:
    """Validate a local-tool request and resolve its bounded candidate count."""

    if not 1 <= default_max_results <= hard_max_results:
        raise ValueError("local tool result bounds are invalid")
    if not request.has_agent_criteria() and not _has_immutable_filters(immutable_filters):
        raise AgentSearchContractError(
            "local search requires agent criteria or immutable UI filters"
        )
    resolved = request.max_results or default_max_results
    if resolved > hard_max_results:
        raise AgentSearchContractError("local search max_results exceeds the hard maximum")
    return resolved


def validate_final_ranking(
    output: AgentRankedSearchOutput,
    *,
    preview_ids: Iterable[UUID],
    tool_candidate_ids: Iterable[UUID],
    max_candidate_count: int,
) -> tuple[UUID, ...]:
    """Require the final model to rank every candidate and invent no IDs."""

    candidate_union = tuple(dict.fromkeys((*preview_ids, *tool_candidate_ids)))
    if len(candidate_union) > max_candidate_count:
        raise AgentSearchContractError("candidate union exceeds the configured maximum")

    ranked = tuple(output.ranked_ids)
    candidate_set = set(candidate_union)
    ranked_set = set(ranked)
    unknown = ranked_set - candidate_set
    missing = candidate_set - ranked_set
    if unknown:
        raise AgentSearchContractError("final ranking contains IDs outside the candidate union")
    if missing:
        raise AgentSearchContractError("final ranking omitted candidate IDs")
    return ranked


def _has_immutable_filters(filters: CardSearchFilters) -> bool:
    return bool(filters.model_dump(exclude_defaults=True))
