"""The deck agent's access to local card data: its five tools, and name resolution.

`read_deck` and `read_history` are answered entirely from what the browser posted
with the turn — the backend holds no deck and no history of one — while `see_cards`
and `search_cards` read the same local catalog, Tagger sidecar and EDHREC cache the
interface itself reads, so the agent and the user cannot be looking at different
data.

`edit_deck` cannot mutate anything either, for the same reason: it resolves a change
against the posted snapshot and emits it, and the browser applies it as one undo
step. What that buys is a result that can be *accurate* rather than proposed — the
deck as it was is in the request, so the tool can say what the change did to it.
Everything it declines to block, it reports: colour identity, singleton and the
hundred-card bound are warnings here because they are warnings on the board too, and
an agent held to a stricter rule than the drag target is inconsistent in a way the
user cannot see. Command-zone legality and group existence stay in
`frontend/src/domain/deck.ts`, unduplicated.

`search_cards` is the search agent's own engine with the filters moved: the
interface owns the immutable half for a panel search, and here the model owns all
of it, commander included. Nothing in `agentic_card_search` changes for it.

Every tool result is compact text rather than JSON. The model reads it either way,
and text costs a fraction of the tokens for a hundred-card deck.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, get_args
from uuid import UUID

from pydantic import Field, StringConstraints, ValidationError

from mtg_deck_builder.agentic_card_search import (
    DEFAULT_AGENT_SORT,
    ExecutedSearchTool,
    LocalCardSearchTool,
)
from mtg_deck_builder.agentic_search import AgentSearchContractError
from mtg_deck_builder.card_catalog import CardSearchUnavailable, SQLiteCardCatalog
from mtg_deck_builder.config import DeckAgentToolSettings
from mtg_deck_builder.domain import (
    AgentSearchCandidate,
    CardDetail,
    CardSearchFilters,
    CardSearchResult,
    DeckAgentDeckSnapshot,
    EdhrecDeckTheme,
    LocalCardSearchRequest,
)
from mtg_deck_builder.domain.agent_chat import (
    CardToken,
    DeckAgentDeckEdit,
    DeckAgentDeckEditChange,
    DeckAgentDeckHistory,
    DeckAgentDeckHistoryChange,
    DeckAgentDeckSession,
    DeckAgentModel,
    DeckEditChange,
    DeckEditZone,
    DeckSection,
    EditDeckArguments,
    ReadHistoryArguments,
)
from mtg_deck_builder.edhrec_catalog import (
    EdhrecCatalogUnavailable,
    EdhrecCommanderRanking,
    EdhrecCommanderService,
)
from mtg_deck_builder.providers.tool_schema import provider_tool_schema
from mtg_deck_builder.tagger_catalog import SQLiteTaggerCatalog, TaggerCatalogUnavailable

READ_DECK = "read_deck"
SEE_CARDS = "see_cards"
SEARCH_CARDS = "search_cards"
EDIT_DECK = "edit_deck"
READ_HISTORY = "read_history"

# The type that names each card's section of the deck list. Order is precedence, not
# display: a card is filed under the first type its type line mentions, so an
# artifact land is a Land. This mirrors `primaryCardType` in
# `frontend/src/domain/card.ts` on purpose — the agent must group the deck the same
# way the board on screen does. Change one and change the other.
_PRIMARY_TYPE_PRECEDENCE = (
    "Land",
    "Creature",
    "Instant",
    "Sorcery",
    "Artifact",
    "Enchantment",
    "Planeswalker",
    "Battle",
)
_OTHER_TYPE = "Other"

# How a deck list reads to a player, which is not the precedence order above.
_SECTION_DISPLAY_ORDER = (
    "Creature",
    "Artifact",
    "Enchantment",
    "Instant",
    "Sorcery",
    "Planeswalker",
    "Battle",
    "Land",
    _OTHER_TYPE,
)

# The curve's last bucket collects everything at this mana value and above. The tail of
# a Commander deck is one card at a time, so a bucket per printed value would be mostly
# zeros, and `7+` is how the curve is drawn everywhere else a player has seen one.
_CURVE_TOP_BUCKET = 7

# How many blocks the widest bar may run to. One block per card while everything fits;
# past that every bar scales down together so the shape stays readable on one line. The
# count printed beside each bar is always the literal number of cards, so a scaled bar
# never becomes the only source of truth.
_CURVE_BAR_MAX = 20

_CURVE_BLOCK = "█"

# Short enough to be cheap across a hundred-card deck, long enough that a collision
# inside one deck is vanishingly unlikely — and collisions are checked for anyway.
_MINIMUM_ID_PREFIX = 8

# The order details are reported in, whatever order they were asked for. A card's
# own printed facts come first and the related-card list last, so every block reads
# the same way and the one section that runs to several lines sits at the bottom.
_DETAIL_ORDER: tuple[CardDetail, ...] = (
    "rules",
    "legality",
    "prices",
    "tags",
    "inclusion",
    "themes",
    "similar",
)

# The related-card groups `similar` reports, with the interface's own labels and its
# order: what to play instead first, then the shape variations, then the wording
# cross-references. This mirrors `relationshipGroups` in
# `frontend/src/components/CardEnrichmentPanel.tsx` on purpose — the agent and the
# user must call the same relationship by the same name. Change one and change the
# other. `referenced_by` is deliberately absent from both.
#
# One difference from the interface: its separate "Similar on EDHREC" group is folded
# into `Similar cards` here, because the two lists overlap heavily and an agent
# reading the same card twice under two headings learns nothing from the second.
_RELATIONSHIP_GROUPS: tuple[tuple[str, str], ...] = (
    ("Upgrades", "upgrades"),
    ("Similar cards", "similar_cards"),
    ("Creature versions", "creature_versions"),
    ("Spell versions", "spell_versions"),
    ("Outclasses", "downgrades"),
    ("Variants", "variants"),
    ("Related cards", "related_cards"),
    ("References", "references"),
)

_SIMILAR_FIELD = "similar_cards"

# Groups that make a more specific claim about the same thing similarity claims: that
# you might play one of these cards instead. A card named in one of them is dropped
# from the merged similar list, so it is read once, under the heading that says the
# most. `related_cards` and `references` are deliberately absent — a cross-reference is
# a different axis, and a card can honestly be both similar and referenced.
_MORE_SPECIFIC_THAN_SIMILAR = frozenset(
    {"upgrades", "downgrades", "creature_versions", "spell_versions", "variants"}
)

_MISSING_FROM_DETAIL_ORDER = set(get_args(CardDetail)) - set(_DETAIL_ORDER)
if _MISSING_FROM_DETAIL_ORDER:
    # A detail left out of the order is silently never reported, and the tool would
    # answer a request for it with nothing. Failing at import is the only way that
    # cannot be missed when a seventh detail is added.
    raise RuntimeError(
        f"see_cards details missing from the render order: {sorted(_MISSING_FROM_DETAIL_ORDER)}"
    )

# How the two deck sections read in prose. `command_zone` is a field name, and history
# is read by a model that will repeat whatever it is shown.
# What the history calls each actor. The reader of that text is the agent, so the agent
# is `Me`: naming itself in the third person is how it comes to describe its own edits
# as somebody else's.
_ACTOR_LABELS = {"user": "You", "agent": "Me"}

# What marks an edit the user has stepped back past. Spelled out rather than a symbol,
# because it is the one fact in this record that contradicts the deck.
_UNDONE_MARKER = "(undone)"

# A minus sign, not a hyphen: it is the character that pairs with `+` down the left of a
# diff, and a hyphen reads as punctuation there. Spelled as an escape and used through
# these names because ruff flags the literal glyph as ambiguous everywhere it appears.
_REMOVED = "\u2212"
_TIME_RANGE = "\u2013"

# How many of an edit's no-op changes are explained one by one before the rest are
# merely counted. A hundred-change call that was entirely redundant needs to say so, not
# to say so a hundred times.
_MAX_REPORTED_NOOPS = 5

# How big a Commander deck is, command zone included. Exceeded, it is reported as a
# warning and the edit still applies: the board lets the user build a 103-card deck and
# tells them so, and the agent must not be the stricter of the two.
_COMMANDER_DECK_SIZE = 100

# How many cards one edit names before the tool line stops listing them, matching
# `see_cards`' own line. The rest are counted.
_SIGNATURE_NAMED_CARDS = 3

# EDHREC's own theme slugs, as the commander context advertises them.
EdhrecThemeSlug = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=100,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
    ),
]

# What `search_cards` reports about every card it returns. Fixed rather than asked for:
# a recommendation whose rules text the agent never read is guesswork, and the
# alternative — names only — makes it spend one of its few tool iterations calling
# `see_cards` on everything it just found.
#
# `similar` and `themes` stay out because each fires an EDHREC fetch per card, `tags`
# because nothing in a search turns on them, `legality` because a search is already
# legal-only unless the model said otherwise, and `inclusion` because the search's own
# evidence line reports it against the commander actually searched. `prices` is out too:
# a search shows one EUR estimate beside the other selection signals rather than the
# full three-way `see_cards` breakdown, which is a detail somebody asked for.
_SEARCH_DETAILS: tuple[CardDetail, ...] = ("rules",)

# How much of a semantic-sort string the chat's tool line shows before eliding it.
_SIGNATURE_TEXT_LIMIT = 60

# How many deck themes the `themes` detail names. Measured against Marwyn, the
# Nurturer, which advertises 66: they arrive ordered by deck count and the tail is
# themes with a single deck behind them. The count comes with each slug for the same
# reason — sorting by synergy inside a three-deck theme is evidence about three decks.
# A slug past the cap is still accepted by `search_cards`; getting one wrong is what
# lists every one of them.
_MAX_REPORTED_THEMES = 20

# The whole tool line's ceiling, which is `ShortLabel`'s `max_length` in
# `domain/agent_chat.py` — the field every signature is validated into. Change one and
# change the other. Clamped rather than trusted because the model chooses the text
# inside a signature: three 200-character card names would otherwise fail validation
# and take down a turn that had already answered.
_SIGNATURE_LIMIT = 200


@dataclass(frozen=True)
class ToolOutcome:
    """One executed tool call: what the model reads, and what the chat shows.

    `edit` is the one thing a tool result can carry beyond text, and only
    `edit_deck` ever sets it. It is absent on every failure and absent when the call
    changed nothing, so a caller can treat its presence as "there is something for the
    browser to apply" without re-deriving that from the content.
    """

    signature: str
    content: str
    ok: bool = True
    detail: str | None = None
    edit: DeckAgentDeckEdit | None = None


class ReadDeckArguments(DeckAgentModel):
    """`read_deck` takes no arguments; it reads whichever deck is open."""


class SeeCardsArguments(DeckAgentModel):
    """Which cards to look up, and how much to report about each."""

    cards: Annotated[list[CardToken], Field(min_length=1, max_length=50)]
    details: list[CardDetail] = Field(default_factory=list)


class CommanderArguments(DeckAgentModel):
    """Which commander a search is for, and what that commander is allowed to do.

    A commander does two unrelated things to a search, and conflating them is how a
    search silently deletes the card the user wanted: its colour identity is a *hard
    filter* that removes cards nothing downstream restores, while its EDHREC
    inclusion and synergy only *reorder*. `restrict_to_color_identity` separates
    them, so "rank by what this commander's decks actually play, but still show me
    cards outside its colours" is a request that can be made.
    """

    card: CardToken
    restrict_to_color_identity: bool = True
    edhrec_theme: EdhrecThemeSlug | None = None


class SearchCardsArguments(LocalCardSearchRequest):
    """The search agent's own tool arguments, plus the filters the interface owns.

    Subclassed rather than restated so the two callers cannot drift: every ordering
    and filter field, its bounds and its cross-field validators are inherited from
    the one definition the search agent's prompt and tests are written against, and
    a field added there is advertised here without another edit.

    What this adds is only what the interface's filter panel used to decide. A
    panel search has a commander because the user picked one on screen; here the
    model has to name one, and naming a commander that is not in the open deck is
    the whole point — it is what makes "would this work under a different
    commander?" one tool call rather than a feature.
    """

    commander: CommanderArguments | None = None
    commander_legal_only: bool = True
    exclude_cards_in_deck: bool = False

    def local_request(self) -> LocalCardSearchRequest:
        """Project back to exactly the request the shared search engine accepts.

        Passing this subclass straight through would work, but it would also leak
        the three fields above into the tool payload and into `has_agent_criteria`,
        where a commander alone would read as a search criterion. Narrowing to the
        base type keeps that judgement where it already lives.
        """

        return LocalCardSearchRequest.model_validate(
            {name: getattr(self, name) for name in LocalCardSearchRequest.model_fields}
        )

    def catalog_filters(self, commander: CardSearchResult | None) -> CardSearchFilters:
        """Build the filters the interface would otherwise have supplied.

        `include_outside_commander_color_identity` is deliberately left at its
        default and the identity itself carries the decision instead. Two fields
        that have to agree is one more way to be wrong, and `matches_card_filters`
        already treats a missing identity as "do not restrict".
        """

        restricted = commander is not None and (
            self.commander is not None and self.commander.restrict_to_color_identity
        )
        return CardSearchFilters(
            include_non_commander_legal=not self.commander_legal_only,
            commander_color_identity=(
                list(commander.color_identity)
                if restricted and commander is not None
                else None
            ),
        )


@dataclass(frozen=True)
class _SearchCommander:
    """A resolved commander for one search, with whatever EDHREC could add."""

    card: CardSearchResult
    ranking: EdhrecCommanderRanking | None
    theme_slug: str | None
    theme_slugs: tuple[str, ...]
    note: str

    @property
    def has_edhrec(self) -> bool:
        return self.ranking is not None


@dataclass(frozen=True)
class _DeckEntry:
    """One resolved deck card: the snapshot's placement plus catalog truth.

    `scryfall_id` is the printing the *snapshot* named, which is not necessarily the
    printing the catalog would choose today. An edit has to travel with the browser's
    own id or the applier looks for an entry the deck does not have.
    """

    card: CardSearchResult
    scryfall_id: UUID
    quantity: int
    section: str


class DeckAgentToolError(RuntimeError):
    """A tool call could not be answered.

    This is never fatal to the turn: the message is handed back to the model as the
    tool's result so it can adapt, and shown to the user on the tool's own line.
    """


class DeckAgentToolbox:
    """Run the deck agent's tools against the local data the interface uses."""

    def __init__(
        self,
        *,
        card_catalog: SQLiteCardCatalog | None,
        tagger_catalog: SQLiteTaggerCatalog | None,
        edhrec_service: EdhrecCommanderService | None,
        settings: DeckAgentToolSettings,
        local_tool: LocalCardSearchTool | None = None,
    ) -> None:
        self._card_catalog = card_catalog
        self._tagger_catalog = tagger_catalog
        self._edhrec_service = edhrec_service
        self._settings = settings
        self._local_tool = local_tool

    @property
    def enabled(self) -> bool:
        """Report whether tools can run at all.

        Without the card catalog there is nothing to resolve a deck against, so the
        agent is better off knowing it has no tools than calling one that always
        fails.
        """

        return self._settings.enabled and self._card_catalog is not None

    async def oracle_ids_for_names(self, names: list[str]) -> dict[str, UUID]:
        """Resolve card names to Oracle identities, keyed by case-folded name.

        Not a tool: this is how the answer's braced card names become links. It goes
        through the same resolver the tools use so a name the agent read out of
        `see_cards` resolves identically here — including the front-face match that
        finds a double-faced card. An unknown name is simply absent, and a catalog
        that cannot be read costs the turn nothing: links are an enhancement, and
        failing an answered turn over one would be absurd.
        """

        if self._card_catalog is None or not names:
            return {}
        try:
            return await self._card_catalog.oracle_ids_by_names(names)
        except CardSearchUnavailable:
            return {}

    def definitions(self) -> list[dict[str, Any]]:
        """Describe the runnable tools for advertisement to the provider.

        `search_cards` is advertised only when the shared search engine was wired
        in. An advertised tool that always fails costs the model an iteration and
        teaches it nothing, so a missing engine means a missing tool rather than a
        broken one.
        """

        definitions = [
            {
                "type": "function",
                "function": {
                    "name": READ_DECK,
                    "description": self._settings.read_deck_description,
                    "parameters": provider_tool_schema(ReadDeckArguments),
                },
            },
            {
                "type": "function",
                "function": {
                    "name": SEE_CARDS,
                    "description": self._settings.see_cards_description,
                    "parameters": provider_tool_schema(SeeCardsArguments),
                    # Deliberately not `strict`: `details` is optional, and strict
                    # mode requires every property in `required`. Claiming it once
                    # cost the search agent an outright provider rejection.
                },
            },
            {
                "type": "function",
                "function": {
                    "name": EDIT_DECK,
                    "description": self._settings.edit_deck_description,
                    "parameters": provider_tool_schema(EditDeckArguments),
                },
            },
            {
                "type": "function",
                "function": {
                    "name": READ_HISTORY,
                    "description": self._settings.read_history_description,
                    "parameters": provider_tool_schema(ReadHistoryArguments),
                },
            },
        ]
        if self._local_tool is not None:
            definitions.append(
                {
                    "type": "function",
                    "function": {
                        "name": SEARCH_CARDS,
                        "description": self._settings.search_cards_description,
                        "parameters": provider_tool_schema(SearchCardsArguments),
                    },
                }
            )
        return definitions

    async def run(
        self,
        name: object,
        arguments: object,
        *,
        deck: DeckAgentDeckSnapshot | None,
        history: DeckAgentDeckHistory | None = None,
    ) -> ToolOutcome:
        """Execute one tool call, returning text for the model either way."""

        if not isinstance(arguments, dict):
            return ToolOutcome(
                signature=f"{name}(?)",
                content="Tool arguments must be a JSON object.",
                ok=False,
                detail="invalid arguments",
            )
        try:
            if name == READ_DECK:
                ReadDeckArguments.model_validate(arguments)
                return await self._read_deck(deck, history)
            if name == SEE_CARDS:
                return await self._see_cards(
                    SeeCardsArguments.model_validate(arguments),
                    deck,
                )
            if name == SEARCH_CARDS:
                return await self._search_cards(
                    SearchCardsArguments.model_validate(arguments),
                    deck,
                )
            if name == EDIT_DECK:
                return await self._edit_deck(
                    EditDeckArguments.model_validate(arguments),
                    deck,
                )
            if name == READ_HISTORY:
                return self._read_history(
                    ReadHistoryArguments.model_validate(arguments),
                    deck,
                    history,
                )
        except ValidationError as exc:
            return ToolOutcome(
                signature=_signature(name, arguments),
                content=f"Those arguments are not valid: {_first_error(exc)}.",
                ok=False,
                detail="invalid arguments",
            )
        except DeckAgentToolError as exc:
            return ToolOutcome(
                signature=_signature(name, arguments),
                content=str(exc),
                ok=False,
                detail=str(exc)[:120],
            )
        return ToolOutcome(
            signature=_signature(name, arguments),
            content=f"There is no tool called {name!r}.",
            ok=False,
            detail="unknown tool",
        )

    async def _read_deck(
        self,
        deck: DeckAgentDeckSnapshot | None,
        history: DeckAgentDeckHistory | None = None,
    ) -> ToolOutcome:
        """List the open deck by card type, with names and short ids but no rules."""

        signature = f"{READ_DECK}()"
        if deck is None:
            return ToolOutcome(
                signature=signature,
                content=(
                    "No deck is open, so there is nothing to read. Ask the user what "
                    "they are building."
                ),
            )

        entries, unresolved = await self._resolve_deck(deck)
        if not entries and not unresolved:
            return ToolOutcome(
                signature=signature,
                content=(
                    f'The deck "{deck.name}" is open and completely empty — no '
                    "commander and no cards yet."
                ),
            )

        prefixes = _short_ids([entry.card.oracle_id for entry in entries])
        sections: dict[str, list[_DeckEntry]] = {}
        commanders: list[_DeckEntry] = []
        for entry in entries:
            if entry.section == "command_zone":
                commanders.append(entry)
                continue
            sections.setdefault(_primary_type(entry.card), []).append(entry)

        total = sum(entry.quantity for entry in entries)
        lines = [
            f'Deck "{deck.name}" — {total} cards, {len(entries)} distinct.',
            "",
        ]
        if commanders:
            lines.append(f"Commander ({len(commanders)})")
            lines.extend(
                _deck_line(entry, prefixes, with_quantity=False) for entry in commanders
            )
        else:
            lines.append("Commander (0) — the command zone is empty.")
        for section in _SECTION_DISPLAY_ORDER:
            group = sections.get(section)
            if not group:
                continue
            lines.append("")
            count = sum(entry.quantity for entry in group)
            lines.append(f"{section} ({count})")
            lines.extend(
                _deck_line(entry, prefixes)
                for entry in sorted(group, key=lambda item: item.card.name)
            )
        if unresolved:
            lines.append("")
            lines.append(
                f"Not in the local catalog ({len(unresolved)}): "
                + ", ".join(str(identifier) for identifier in unresolved)
            )
        if entries:
            # Unconditional rather than asked for: these are the two numbers a player
            # checks first, and a deck listing that made the agent call a second tool to
            # learn its own curve would be answering half the question. Skipped only when
            # nothing resolved, because a curve over no cards is not a curve.
            lines.append("")
            lines.extend(_curve_lines(entries))
            lines.append("")
            lines.extend(_price_lines(entries, unresolved_count=len(unresolved)))
        lines.append("")
        lines.append(
            f"No card text here. Call {SEE_CARDS} with the names or short ids above "
            "for rules, prices, tags, inclusion rates or similar cards."
        )
        # Only when there is a past to read. A pointer at an empty record would spend a
        # tool round to learn nothing, and one at a client that posts no history would
        # spend it to learn nothing twice.
        recorded = _recorded_edit_count(history)
        if recorded:
            lines.append(
                f"{recorded} earlier {'edit' if recorded == 1 else 'edits'} "
                f"{'is' if recorded == 1 else 'are'} recorded; call {READ_HISTORY} to "
                "see who changed what, when and why."
            )
        return ToolOutcome(signature=signature, content="\n".join(lines))

    async def _see_cards(
        self,
        arguments: SeeCardsArguments,
        deck: DeckAgentDeckSnapshot | None,
    ) -> ToolOutcome:
        """Report the requested detail for each named or identified card."""

        asked = list(arguments.details) or list(self._settings.see_cards_default_details)
        # Canonicalised once, so the tool line the user sees names the details in the
        # order the body below actually reports them, and a detail asked for twice is
        # reported once.
        details = [detail for detail in _DETAIL_ORDER if detail in set(asked)]
        cap = self._settings.see_cards_max_cards
        requested = list(arguments.cards)
        truncated = requested[cap:]
        requested = requested[:cap]
        signature = _see_cards_signature(requested, details, dropped=len(truncated))

        entries, _ = await self._resolve_deck(deck) if deck else ([], [])
        resolved, missing = await self._resolve_tokens(requested, entries)

        commander = next(
            (entry.card for entry in entries if entry.section == "command_zone"),
            None,
        )
        blocks: list[str] = []
        for card in resolved:
            blocks.append(
                await self._card_block(card, details=details, commander=commander)
            )
        lines: list[str] = []
        if blocks:
            lines.append("\n\n".join(blocks))
        if missing:
            lines.append(
                "Not found: "
                + ", ".join(missing)
                + ". Names must match exactly; short ids come from read_deck."
            )
        if truncated:
            lines.append(
                f"Only the first {cap} cards were read. Not looked up: "
                + ", ".join(truncated)
                + ". Ask again for the rest."
            )
        if not lines:
            lines.append("Nothing to report.")
        return ToolOutcome(signature=signature, content="\n\n".join(lines))

    async def _edit_deck(
        self,
        arguments: EditDeckArguments,
        deck: DeckAgentDeckSnapshot | None,
    ) -> ToolOutcome:
        """Resolve one edit against the posted deck and say what it did to it.

        Nothing is mutated here — the browser applies the emitted edit — but the deck
        as it was is in the request, so the result is a statement rather than a
        proposal. What it reports is what the model could not already know: which
        tokens resolved, what the deck held before, which changes were therefore
        no-ops, the resulting card count, and any warning the change introduced. The
        quantities and the reason are still sitting in its own tool call.

        Two things fail the whole call rather than part of it — a card that does not
        resolve and a quantity outside 0-99 — because a half-applied edit records an
        intent that did not happen, and that is the worst outcome available here.
        Everything else is a warning: the board treats out-of-identity as a warning,
        and an agent held to a stricter rule than the drag target is inconsistent in a
        way the user cannot see.
        """

        tokens = [change.card for change in arguments.changes]
        signature = _edit_deck_signature(tokens)
        if deck is None:
            return ToolOutcome(
                signature=signature,
                content=(
                    "No deck is open, so there is nothing to edit. Ask the user which "
                    "deck they want changed."
                ),
                ok=False,
                detail="no deck open",
            )

        entries, _ = await self._resolve_deck(deck)
        resolved = await self._resolve_token_cards(tokens, entries)
        unknown = [
            token
            for token, card in zip(tokens, resolved, strict=True)
            if card is None
        ]
        if unknown:
            return ToolOutcome(
                signature=signature,
                content=(
                    f"{'No card called' if len(unknown) == 1 else 'No cards called'} "
                    f"{_quoted_list(unknown)}, so the deck was not changed at all. "
                    "A card is named by its exact printed name, or by a short id from "
                    f"{READ_DECK}."
                ),
                ok=False,
                detail=f"unknown card: {unknown[0]}"[:120],
            )

        planned, collapsed = _planned_changes(arguments.changes, resolved, entries)
        effective = [change for change in planned if change.effective]
        # Counted from the snapshot rather than from the resolved entries, so a printing
        # the catalog does not know still counts towards the deck's size. It is in the
        # deck on screen whatever the catalog thinks.
        before_total = sum(entry.quantity for entry in deck.cards)
        after_total = before_total + sum(change.delta for change in effective)

        commander = next(
            (entry.card for entry in entries if entry.section == "command_zone"),
            None,
        )
        warnings = _edit_warnings(
            effective,
            commander=commander,
            after_total=after_total,
            collapsed=collapsed,
        )
        content = "\n".join(
            _edit_lines(
                deck_name=deck.name,
                planned=planned,
                effective=effective,
                after_total=after_total,
                warnings=warnings,
            )
        )
        if not effective:
            # Nothing for the browser to apply, so nothing is emitted. An edit carrying
            # no change would land in the history as an entry that changed nothing, and
            # a retried call would then read as a second edit.
            return ToolOutcome(signature=signature, content=content)
        return ToolOutcome(
            signature=signature,
            content=content,
            edit=DeckAgentDeckEdit(
                deck_name=deck.name,
                reason=arguments.reason,
                changes=[change.emitted() for change in effective],
            ),
        )

    def _read_history(
        self,
        arguments: ReadHistoryArguments,
        deck: DeckAgentDeckSnapshot | None,
        history: DeckAgentDeckHistory | None,
    ) -> ToolOutcome:
        """Report the deck's recorded edits, newest session first.

        Read from the request, like the deck itself: history lives in the browser
        beside the deck, and the backend keeps neither.

        The two empty cases are told apart on purpose. A client that posted no history
        leaves the agent unable to say whether the deck has ever been changed; a deck
        with an empty record has demonstrably not been changed since recording began.
        The first is a gap in what can be seen and the second is a fact about the deck,
        so they send the agent somewhere different — the same distinction `see_cards`
        draws between a commander with no themes and a card that is not a commander.
        """

        limit = min(
            arguments.limit or self._settings.read_history_default_sessions,
            self._settings.history_max_sessions,
        )
        signature = _read_history_signature(limit)
        subject = _quoted(deck.name) if deck is not None else "This deck"
        if history is None:
            return ToolOutcome(
                signature=signature,
                content=(
                    "## History\n"
                    "No history was posted with this turn, so there is none to read. "
                    "That is this client not sending one, not a deck that has never "
                    "been edited — from here you cannot tell which. Do not tell the "
                    "user their deck has no past."
                ),
            )
        sessions = list(history.sessions)
        if not sessions:
            return ToolOutcome(
                signature=signature,
                content=(
                    "## History\n"
                    f"{subject} has no recorded edits. Its history is being kept and "
                    "it is empty, so nothing has changed since recording started."
                ),
            )

        # Stored oldest first, read newest first: the recent past is what a question
        # about "what did we change" is almost always about.
        shown = sessions[::-1][:limit]
        total = len(sessions)
        counted = (
            f"{total} {'session' if total == 1 else 'sessions'} recorded"
            + (
                f", showing the last {len(shown)}."
                if len(shown) < total
                else ", all of them below."
            )
        )
        lines = ["## History", f"{subject} — {counted}"]
        # Said once, at the top, rather than beside every marked line. Only when there is
        # something marked: an explanation of a marker that does not appear is a sentence
        # the model has to work out is irrelevant.
        undone = sum(
            1 for session in shown for edit in session.edits if edit.undone
        )
        if undone:
            lines.append(
                f"{undone} {'edit is' if undone == 1 else 'edits are'} marked "
                f"{_UNDONE_MARKER}: the user stepped back past "
                f"{'it' if undone == 1 else 'them'}, so "
                f"{'it happened' if undone == 1 else 'they happened'} and the deck does "
                f"not have {'it' if undone == 1 else 'them'} now. Stepping forward again "
                f"is the user's to do, not yours — but you may put a card back with "
                f"{EDIT_DECK} if they ask for it."
            )
        # Every session's clock time is printed as the browser sent it. A date is added
        # only when a session did not happen on the same day as the newest one, so a
        # bare `14:02` never silently means last Tuesday.
        newest_day = shown[0].started_at.date()
        for session in shown:
            lines.append("")
            lines.extend(_session_lines(session, newest_day=newest_day))
        return ToolOutcome(signature=signature, content="\n".join(lines))

    async def _search_cards(
        self,
        arguments: SearchCardsArguments,
        deck: DeckAgentDeckSnapshot | None,
    ) -> ToolOutcome:
        """Search the whole local catalog under filters the model wrote itself."""

        if self._local_tool is None:
            raise DeckAgentToolError(
                "Card search is unavailable: the search engine is not installed."
            )

        entries, _ = await self._resolve_deck(deck) if deck else ([], [])
        commander = await self._search_commander(arguments, entries)
        signature = _search_cards_signature(arguments, commander=commander)

        wants_edhrec_sort = arguments.sort_by in {"edhrec_inclusion", "edhrec_synergy"}
        if wants_edhrec_sort and (commander is None or not commander.has_edhrec):
            # Caught before the engine does, because only here is it known *why* the
            # evidence is missing, and the two causes need different fixes.
            reason = (
                "no commander was named"
                if commander is None
                else f"there is no EDHREC data for {_quoted(commander.card.name)}"
            )
            return ToolOutcome(
                signature=signature,
                content=(
                    f"Sorting by {arguments.sort_by} needs EDHREC evidence, and "
                    f"{reason}. Name a commander, or sort by semantic or weighted "
                    "instead — weighted falls back to semantic closeness on its own "
                    "when there is no EDHREC data."
                ),
                ok=False,
                detail="no EDHREC evidence",
            )

        excluded = (
            frozenset(entry.card.oracle_id for entry in entries)
            if arguments.exclude_cards_in_deck
            else frozenset()
        )
        try:
            executed = await self._local_tool.search(
                arguments.local_request(),
                immutable_filters=arguments.catalog_filters(
                    commander.card if commander is not None else None
                ),
                excluded_oracle_ids=excluded,
                edhrec_ranking=commander.ranking if commander is not None else None,
            )
        except AgentSearchContractError:
            # One message covering all three of this error's causes. The engine's own
            # wording is deliberately not passed through: it talks about the interface
            # filters a panel search has, which this tool has no equivalent of, so
            # quoting it would send the model looking for something that is not there.
            return ToolOutcome(
                signature=signature,
                content=(
                    "That search could not run. It needs at least one filter, a "
                    "semantic_sort or a sort_by; max_results must be 60 or below; and "
                    "an EDHREC ordering needs a commander."
                ),
                ok=False,
                detail="invalid search",
            )
        except CardSearchUnavailable as exc:
            raise DeckAgentToolError(
                f"The card catalog could not be searched: {exc}."
            ) from exc

        return ToolOutcome(
            signature=signature,
            content="\n".join(
                await self._search_lines(
                    executed,
                    arguments=arguments,
                    commander=commander,
                    excluded_count=len(excluded),
                )
            ),
        )

    async def _search_commander(
        self,
        arguments: SearchCardsArguments,
        entries: list[_DeckEntry],
    ) -> _SearchCommander | None:
        """Resolve the named commander and load whatever EDHREC has on it.

        EDHREC is loaded whenever a commander is named rather than behind a flag,
        because the default `weighted` sort blends inclusion into its score and the
        per-card evidence line is worth having on every search. It is a 30-day cache,
        so this is usually a local read, and a failure is a note rather than an error.
        """

        if arguments.commander is None:
            return None
        resolved, missing = await self._resolve_tokens([arguments.commander.card], entries)
        if not resolved:
            raise DeckAgentToolError(
                f"No card called {_quoted(missing[0] if missing else arguments.commander.card)}. "
                "A commander is named by its exact printed name, or by a short id "
                "from read_deck."
            )
        card = resolved[0]
        requested_theme = arguments.commander.edhrec_theme

        if self._edhrec_service is None:
            return _SearchCommander(
                card=card,
                ranking=None,
                theme_slug=requested_theme,
                theme_slugs=(),
                note="EDHREC lookups are switched off, so there is no inclusion data.",
            )
        try:
            context = await self._edhrec_service.context_for(card.oracle_id)
            slugs = tuple(theme.slug for theme in context.themes)
            if requested_theme is not None and requested_theme not in slugs:
                raise DeckAgentToolError(
                    f"EDHREC has no theme {_quoted(requested_theme)} for "
                    f"{_quoted(card.name)}. "
                    + (
                        f"Its themes are: {_quoted_list(list(slugs))}."
                        if slugs
                        else "It advertises no themes, so leave edhrec_theme out."
                    )
                )
            ranking = await self._edhrec_service.ranking_for(card.oracle_id, requested_theme)
        except EdhrecCatalogUnavailable:
            return _SearchCommander(
                card=card,
                ranking=None,
                theme_slug=requested_theme,
                theme_slugs=(),
                note=(
                    f"EDHREC has no data for {_quoted(card.name)}, so there is no "
                    "inclusion or synergy evidence in this search."
                ),
            )
        return _SearchCommander(
            card=card,
            ranking=ranking,
            theme_slug=requested_theme,
            theme_slugs=slugs,
            note="",
        )

    async def _search_lines(
        self,
        executed: ExecutedSearchTool,
        *,
        arguments: SearchCardsArguments,
        commander: _SearchCommander | None,
        excluded_count: int,
    ) -> list[str]:
        """Render one search: what the model could not have known, then the cards.

        Deliberately short. The filters, the sort and the commander's name are all
        things the model wrote a moment ago, and echoing them back costs tokens on
        every call to tell it what it already said. What it cannot know is how many
        cards matched, what the commander's colour identity turned out to be, and
        whether the EDHREC fetch actually landed — so that, and nothing else.
        """

        candidates: tuple[AgentSearchCandidate, ...] = executed.candidates
        total = executed.payload.get("total_candidates", len(candidates))
        lines = ["## Search"]
        if not candidates:
            lines.append(
                "Nothing matched. Every filter you sent removes cards, so relax the "
                "narrowest one — a mana or price bound, a types condition, or the "
                "colour identity — rather than rewording semantic_sort, which "
                "removes nothing."
            )
            lines.extend(_commander_lines(commander, restricted=_restricted(arguments)))
            return lines

        matched = (
            f"{total} cards matched; showing the best {len(candidates)}, best first."
            if total > len(candidates)
            else f"{total} cards matched, all of them below, best first."
        )
        if arguments.exclude_cards_in_deck:
            matched += (
                f" {excluded_count} already in the deck were excluded."
                if excluded_count
                # Otherwise it reads as "0 were excluded", which sounds like an empty
                # deck rather than like there being no deck to read.
                else " Nothing was excluded: no deck is open, or it holds no cards."
            )
        lines.append(matched)
        lines.extend(_commander_lines(commander, restricted=_restricted(arguments)))
        lines.append("")
        blocks = [
            await self._search_card_block(candidate, commander=commander)
            for candidate in candidates
        ]
        lines.append("\n\n".join(blocks))
        lines.append("")
        lines.append(
            f"Call {SEE_CARDS} with any of these names for tags, related cards, full "
            "prices or legality."
        )
        return lines

    async def _search_card_block(
        self,
        candidate: AgentSearchCandidate,
        *,
        commander: _SearchCommander | None,
    ) -> str:
        """Render one found card the way `see_cards` renders one, plus its evidence.

        The same renderer on purpose: a card the agent found by searching and a card
        it looked up by name should not arrive in two different layouts.
        """

        block = await self._card_block(
            candidate.card,
            details=list(_SEARCH_DETAILS),
            commander=None,
        )
        return "\n".join([block, *_evidence_lines(candidate, commander=commander)])

    async def _card_block(
        self,
        card: CardSearchResult,
        *,
        details: list[CardDetail],
        commander: CardSearchResult | None,
    ) -> str:
        """Render one card, reporting `details` in the order given.

        The order is fixed by `_see_cards` rather than here, so that the tool line the
        user sees and the body the model reads cannot disagree about it.
        """

        lines = _identity_lines(card)
        for detail in details:
            lines.extend(
                await self._detail_lines(card, detail=detail, commander=commander)
            )
        return "\n".join(lines)

    async def _detail_lines(
        self,
        card: CardSearchResult,
        *,
        detail: CardDetail,
        commander: CardSearchResult | None,
    ) -> list[str]:
        """Render one requested detail for one card, or say why it is missing."""

        if detail == "rules":
            return _rules_lines(card)
        if detail == "prices":
            return [f"  Price: {_prices(card)}"]
        if detail == "legality":
            return [f"  Commander legality: {_commander_legality(card)}"]
        if detail == "tags":
            return [f"  Tags: {self._tags(card.oracle_id)}"]
        if detail == "similar":
            return await self._similar_lines(card)
        if detail == "inclusion":
            return [f"  Inclusion: {await self._inclusion(card, commander)}"]
        if detail == "themes":
            return await self._theme_detail(card)
        return []

    async def _theme_detail(self, card: CardSearchResult) -> list[str]:
        """Report the deck themes EDHREC tracks for this card as a commander.

        Only a card that can legally be a commander has an EDHREC commander page, so
        for anything else this is legitimately empty — and says which of the two it is,
        because "no themes" and "not a commander" lead somewhere different.
        """

        if self._edhrec_service is None:
            return ["  Deck themes: unavailable — EDHREC lookups are switched off."]
        try:
            context = await self._edhrec_service.context_for(card.oracle_id)
        except EdhrecCatalogUnavailable:
            return [
                f"  Deck themes: EDHREC has no commander page for {_quoted(card.name)}. "
                "Only a card that can legally be a commander has one, which in practice "
                "means a legendary creature."
            ]
        lines = _theme_lines(tuple(context.themes))
        return lines or ["  Deck themes: EDHREC lists none for this commander."]

    def _tags(self, oracle_id: UUID) -> str:
        if self._tagger_catalog is None:
            return "unavailable — the Tagger sidecar is not installed."
        try:
            enrichment = self._tagger_catalog.card_enrichment(oracle_id)
        except TaggerCatalogUnavailable:
            return "unavailable — the Tagger sidecar could not be read."
        if not enrichment.tags:
            return "no tags recorded for this card."
        return _quoted_list([tag.name for tag in enrichment.tags])

    async def _similar_lines(self, card: CardSearchResult) -> list[str]:
        """Group every related-card list the local data holds for this card.

        Two independent sources, reported as the interface groups them: Tagger's
        relationships are local, exact and say *how* two cards relate — an upgrade is
        not a variant — while EDHREC's list is a popularity signal fetched on demand.
        One of them being unavailable must not cost the other, so a source that cannot
        answer is noted and the rest of the block still arrives.
        """

        related, notes = self._relationship_groups(card.oracle_id)
        edhrec, note = await self._edhrec_similar(card)
        if note is not None:
            notes.append(note)
        related[_SIMILAR_FIELD] = _merged_similar(related, edhrec)

        groups = [
            (heading, related[field])
            for heading, field in _RELATIONSHIP_GROUPS
            if related.get(field)
        ]
        if not groups:
            missing = "; ".join(notes) if notes else "nothing recorded for this card."
            return [f"  Similar: {missing}"]
        lines = ["  Similar:"]
        lines.extend(f"    {heading}: {_quoted_list(names)}" for heading, names in groups)
        lines.extend(f"    ({note})" for note in notes)
        return lines

    def _relationship_groups(
        self,
        oracle_id: UUID,
    ) -> tuple[dict[str, list[str]], list[str]]:
        """Read Tagger's related-card lists for one card, keyed by relationship."""

        if self._tagger_catalog is None:
            return {}, ["no Tagger relationships — the sidecar is not installed"]
        try:
            enrichment = self._tagger_catalog.card_enrichment(oracle_id)
        except TaggerCatalogUnavailable:
            return {}, ["no Tagger relationships — the sidecar could not be read"]
        return {
            field: [related.name for related in getattr(enrichment, field)]
            for _, field in _RELATIONSHIP_GROUPS
            if getattr(enrichment, field)
        }, []

    async def _edhrec_similar(self, card: CardSearchResult) -> tuple[list[str], str | None]:
        """Read EDHREC's similar-card names, or say why there are none."""

        if self._edhrec_service is None:
            return [], "no EDHREC list — EDHREC lookups are switched off"
        try:
            similar = await self._edhrec_service.similar_cards_for(card.oracle_id)
        except EdhrecCatalogUnavailable:
            return [], "no EDHREC list — EDHREC had no similar cards for this one"
        if not similar.suggestions:
            return [], "no EDHREC list — EDHREC lists no similar cards for this one"
        return [suggestion.name for suggestion in similar.suggestions], None

    async def _inclusion(
        self,
        card: CardSearchResult,
        commander: CardSearchResult | None,
    ) -> str:
        """Report how often this card appears in decks led by this commander.

        Inclusion is meaningless without a commander to measure it against, so the
        absence of one is reported rather than guessed at.
        """

        if self._edhrec_service is None:
            return "unavailable — EDHREC lookups are switched off."
        if commander is None:
            return (
                "needs a commander — the deck's command zone is empty, and inclusion "
                "is always relative to one commander."
            )
        try:
            ranking = await self._edhrec_service.ranking_for(commander.oracle_id)
        except EdhrecCatalogUnavailable:
            return f"unavailable — EDHREC has no data for {commander.name}."
        association = ranking.associations.get(card.oracle_id)
        if association is None:
            return f"not among the cards EDHREC lists for {commander.name}."
        share = f"{association.inclusion * 100:.0f}%"
        detail = f"{share} of {association.num_decks:,} {commander.name} decks"
        if association.synergy is not None:
            detail += f", synergy {association.synergy:+.2f}"
        return detail

    async def _resolve_deck(
        self,
        deck: DeckAgentDeckSnapshot | None,
    ) -> tuple[list[_DeckEntry], list[UUID]]:
        """Resolve a posted snapshot into catalog cards, keeping what it could not.

        A printing the catalog does not know is reported rather than dropped: a deck
        list that is quietly one card short is worse than one that says so.
        """

        if deck is None or self._card_catalog is None:
            return [], []
        if not deck.cards:
            return [], []
        try:
            oracle_ids = await self._card_catalog.oracle_ids_by_scryfall_ids(
                [entry.scryfall_id for entry in deck.cards]
            )
            cards = await self._cards_by_oracle_id()
        except CardSearchUnavailable as exc:
            raise DeckAgentToolError(
                "The local card catalog is unavailable, so the deck cannot be read."
            ) from exc

        entries: list[_DeckEntry] = []
        unresolved: list[UUID] = []
        for entry in deck.cards:
            oracle_id = oracle_ids.get(entry.scryfall_id)
            card = cards.get(oracle_id) if oracle_id is not None else None
            if card is None:
                unresolved.append(entry.scryfall_id)
                continue
            entries.append(
                _DeckEntry(
                    card=card,
                    scryfall_id=entry.scryfall_id,
                    quantity=entry.quantity,
                    section=entry.section,
                )
            )
        return entries, unresolved

    async def _resolve_tokens(
        self,
        tokens: list[str],
        entries: list[_DeckEntry],
    ) -> tuple[list[CardSearchResult], list[str]]:
        """Resolve tokens to cards, each card once, keeping what resolved to nothing.

        The shape `see_cards` and `search_cards` want: a card asked for twice is
        reported once, and the tokens that matched nothing come back to be named.
        """

        cards = await self._resolve_token_cards(tokens, entries)
        resolved: list[CardSearchResult] = []
        missing: list[str] = []
        seen: set[UUID] = set()
        for token, card in zip(tokens, cards, strict=True):
            if card is None:
                missing.append(token)
                continue
            if card.oracle_id in seen:
                continue
            seen.add(card.oracle_id)
            resolved.append(card)
        return resolved, missing

    async def _resolve_token_cards(
        self,
        tokens: list[str],
        entries: list[_DeckEntry],
    ) -> list[CardSearchResult | None]:
        """Resolve names, full ids and read_deck short ids, one result per token.

        Aligned with the tokens given rather than deduplicated, because `edit_deck`
        has to know *which* change a card belongs to — and a token that resolved to
        nothing has to stay attached to the change that named it.
        """

        if self._card_catalog is None:
            raise DeckAgentToolError("The local card catalog is unavailable.")
        try:
            cards = await self._cards_by_oracle_id()
            names = await self._card_catalog.oracle_ids_by_names(tokens)
        except CardSearchUnavailable as exc:
            raise DeckAgentToolError(
                "The local card catalog is unavailable, so cards cannot be looked up."
            ) from exc

        # The short ids `read_deck` handed out only mean anything inside this deck,
        # so they resolve against the snapshot rather than the whole catalog.
        by_prefix = {
            prefix.casefold(): oracle_id
            for oracle_id, prefix in _short_ids(
                [entry.card.oracle_id for entry in entries]
            ).items()
        }
        by_scryfall = {
            str(card.scryfall_id).casefold(): card.oracle_id for card in cards.values()
        }

        resolved: list[CardSearchResult | None] = []
        for token in tokens:
            key = token.casefold()
            identity = _as_uuid(token)
            oracle_id = (
                names.get(key)
                or by_prefix.get(key)
                or (identity if identity in cards else None)
                or by_scryfall.get(key)
            )
            resolved.append(cards.get(oracle_id) if oracle_id is not None else None)
        return resolved

    async def _cards_by_oracle_id(self) -> dict[UUID, CardSearchResult]:
        """Index the catalog once per call.

        `card_by_oracle_id` scans every entry, so resolving a hundred-card deck one
        card at a time would walk the whole catalog a hundred times.
        """

        if self._card_catalog is None:
            raise DeckAgentToolError("The local card catalog is unavailable.")
        entries = await self._card_catalog.entries()
        return {entry.card.oracle_id: entry.card for entry in entries}


def _as_uuid(value: str) -> UUID | None:
    try:
        return UUID(value.strip())
    except (ValueError, AttributeError):
        return None


def _section_for_zone(zone: DeckEditZone | None) -> DeckSection | None:
    """Resolve the zone the model named to the section the browser files cards under.

    The one place the model's vocabulary and the deck's meet. `None` travels through as
    `None` and is never resolved to the mainboard: a change that says nothing about
    placement must leave it alone, or every quantity edit on a commander would quietly
    move it out of the command zone.
    """

    if zone is None:
        return None
    return "command_zone" if zone == "commander" else "mainboard"


def _as_section(value: str) -> DeckSection | None:
    """Read a snapshot's section, which arrives as the plain string the request carried."""

    return value if value in ("command_zone", "mainboard") else None  # type: ignore[return-value]


def _section_words(section: DeckSection | None) -> str:
    """Name a section in the words the deck listing uses for its headings."""

    return "command zone" if section == "command_zone" else "deck"


def _primary_type(card: CardSearchResult) -> str:
    """File a card under the first type its type line mentions."""

    type_line = card.type_line
    return next(
        (name for name in _PRIMARY_TYPE_PRECEDENCE if name in type_line),
        _OTHER_TYPE,
    )


def _short_ids(oracle_ids: list[UUID]) -> dict[UUID, str]:
    """Give every card a short, unambiguous handle for `see_cards`.

    A full UUID per card costs more tokens than the rest of the line. The prefix is
    lengthened until it is unique within this deck, so a handle can never resolve to
    two cards — rather than assuming eight characters is enough and being wrong.
    """

    unique = list(dict.fromkeys(oracle_ids))
    for length in range(_MINIMUM_ID_PREFIX, 33):
        prefixes = {str(oracle_id)[:length] for oracle_id in unique}
        if len(prefixes) == len(unique):
            return {oracle_id: str(oracle_id)[:length] for oracle_id in unique}
    return {oracle_id: str(oracle_id) for oracle_id in unique}


def _deck_line(
    entry: _DeckEntry,
    prefixes: dict[UUID, str],
    *,
    with_quantity: bool = True,
) -> str:
    prefix = prefixes.get(entry.card.oracle_id, str(entry.card.oracle_id))
    quantity = f"{entry.quantity}x " if with_quantity and entry.quantity > 1 else ""
    # No placement suffix: a card is either under the `Commander` heading or it is in the
    # deck, and the heading already says which.
    return f"  {quantity}{entry.card.name} [{prefix}]"


def _counts_toward_curve(entry: _DeckEntry) -> bool:
    """Report whether one entry belongs in the curve and in the average mana value.

    Two exclusions, both copied from the `statistics` memo in
    `frontend/src/hooks/useDeck.ts`: the command zone, and every card whose type line
    mentions `Land`. That land test is a plain substring match there and it is a plain
    substring match here, so that whenever the interface does start showing this figure
    the two cannot disagree. Note that it does **not** show it today — `averageMana` is
    computed at `useDeck.ts:419` and consumed nowhere, so this is agreement with a
    convention rather than with a number on screen. The deck's price is the figure that
    is actually rendered (`App.tsx:476`).

    The quirk that follows is deliberate. `"Land" in type_line` also excludes Dryad
    Arbor (`Legendary Creature — Land Dryad`) and every Legendary Land, which a
    curve arguably wants to count. `_primary_type` would classify those the same way
    the board does, and using it here would make the tool free to drift from the memo
    the moment someone taught `_primary_type` to split on the em dash. So: change both
    sides or neither.
    """

    return entry.section != "command_zone" and "Land" not in entry.card.type_line


def _curve_lines(entries: list[_DeckEntry]) -> list[str]:
    """Draw the mana curve of the cards a curve is about, quantity-weighted.

    `mana_value` is one number per card even for a split or modal double-faced card, so
    a card lands in exactly one bucket, chosen by the integer part of that value.
    """

    counted = [entry for entry in entries if _counts_toward_curve(entry)]
    if not counted:
        # A commander and nothing else is the common case here, and an all-zero
        # histogram would read as a deck full of nought-cost spells.
        return [
            "Curve — nothing to plot yet: every card in the deck is a land or sits in "
            "the command zone."
        ]

    buckets = [0] * (_CURVE_TOP_BUCKET + 1)
    for entry in counted:
        buckets[min(int(entry.card.mana_value), _CURVE_TOP_BUCKET)] += entry.quantity
    quantity = sum(entry.quantity for entry in counted)
    total_mana = sum(entry.card.mana_value * entry.quantity for entry in counted)

    widest = max(buckets)
    cells = [
        f"{_bucket_label(value):<2} {_curve_bar(count, widest)} {count}"
        for value, count in enumerate(buckets)
    ]
    # Two columns, so eight buckets cost four lines of every read_deck call rather than
    # eight. The left column is padded to its own widest cell so the pairs line up.
    rows = (len(cells) + 1) // 2
    left, right = cells[:rows], cells[rows:]
    width = max(len(cell) for cell in left)
    lines = ["Curve — non-land cards outside the command zone"]
    lines.extend(
        f"  {cell.ljust(width)}   {right[index] if index < len(right) else ''}".rstrip()
        for index, cell in enumerate(left)
    )
    lines.append(
        f"Average mana value {total_mana / quantity:.2f} across "
        f"{quantity} {_cards(quantity)}."
    )
    return lines


def _bucket_label(value: int) -> str:
    return f"{value}+" if value == _CURVE_TOP_BUCKET else str(value)


def _curve_bar(count: int, widest: int) -> str:
    """One block per card, or a proportional bar once that would run off the line.

    An empty bucket still gets a mark, so every row reads as the same three fields
    rather than collapsing into two numbers with a gap between them.
    """

    if count == 0:
        return "·"
    if widest <= _CURVE_BAR_MAX:
        return _CURVE_BLOCK * count
    return _CURVE_BLOCK * max(1, round(count * _CURVE_BAR_MAX / widest))


def _price_lines(entries: list[_DeckEntry], *, unresolved_count: int = 0) -> list[str]:
    """Total the deck's EUR estimate over every card, and say what is missing from it.

    Two different things can be missing, and they are reported separately because they
    lead somewhere different: a card the catalog holds but has no EUR estimate for, and a
    printing the catalog does not hold at all. Only resolved entries can be priced, so
    with any unresolved printing the total stops being a claim about *the deck* and says
    what it actually covers instead.

    The command zone is included, matching the price the `statistics` memo in
    `frontend/src/hooks/useDeck.ts` puts in the deck header. Two departures from it, both
    deliberate:

    - `getCardPrice` there reads a card with no EUR estimate as `0`, so the figure on
      screen quietly under-reports. A card with no price is not a free card, so the
      unpriced cards are counted in words here instead of being folded into the total.
    - The header prices the card details cached when each card was added; this prices the
      catalog as it stands now. The two can therefore differ honestly after a catalog
      refresh, which is why this states its figure plainly and never claims it matches
      what is on screen.
    """

    quantity = sum(entry.quantity for entry in entries)
    if not quantity:
        return []
    unpriced = sum(
        entry.quantity for entry in entries if entry.card.prices.eur is None
    )
    if unpriced == quantity:
        return [
            f"Price unknown: none of the {quantity} {_cards(quantity)} has a EUR "
            "estimate in the catalog, so there is no total to report."
        ]
    total = sum(
        (
            entry.card.prices.eur * entry.quantity
            for entry in entries
            if entry.card.prices.eur is not None
        ),
        Decimal(0),
    )
    line = (
        f"Price EUR {total:.2f} for the {quantity} {_cards(quantity)} the catalog "
        "resolved, command zone included."
        if unresolved_count
        else (
            f"Price EUR {total:.2f} for the deck's {quantity} {_cards(quantity)}, "
            "command zone included."
        )
    )
    if unresolved_count:
        line += (
            f" The {unresolved_count} listed above as not in the local catalog "
            f"{'is' if unresolved_count == 1 else 'are'} not in this total."
        )
    if unpriced:
        line += (
            f" {unpriced} of them {'has' if unpriced == 1 else 'have'} no price "
            "estimate, so the real total is higher."
        )
    return [line]


def _cards(count: int) -> str:
    return "card" if count == 1 else "cards"


def _copies(count: int) -> str:
    return "copy" if count == 1 else "copies"


@dataclass(frozen=True)
class _PlannedChange:
    """One resolved change: the count it wants, beside the count the deck held."""

    card: CardSearchResult
    scryfall_id: UUID
    quantity: int
    previous_quantity: int
    # The model's `zone` resolved to the browser's section, or `None` where the model
    # named none. `previous_section` is where the posted deck had the card, absent when
    # the deck does not hold it at all.
    section: DeckSection | None
    previous_section: DeckSection | None

    @property
    def effective(self) -> bool:
        """Report whether this actually changes the deck as posted.

        A count the deck already holds changes nothing, and neither does a zone the
        card already sits in. Dropping those is what makes the tool idempotent: it
        applies itself, so a model that retries the same call must not double-add.
        """

        moved = self.section is not None and self.section != self.previous_section
        return self.quantity != self.previous_quantity or moved

    @property
    def delta(self) -> int:
        return self.quantity - self.previous_quantity

    def emitted(self) -> DeckAgentDeckEditChange:
        """Project to the change the browser applies."""

        return DeckAgentDeckEditChange(
            scryfall_id=self.scryfall_id,
            name=self.card.name,
            quantity=self.quantity,
            previous_quantity=self.previous_quantity,
            section=self.section,
            # Only an add needs the payload: `addCard` reads the card's colours and
            # type line, and those are exactly what the browser cannot construct for a
            # card it has never held.
            card=self.card if self.delta > 0 else None,
        )


def _planned_changes(
    changes: list[DeckEditChange],
    resolved: list[CardSearchResult | None],
    entries: list[_DeckEntry],
) -> tuple[list[_PlannedChange], list[str]]:
    """Pair every change with what the deck already holds, one change per card.

    A card named twice in one call states two contradictory counts for it. The last
    one wins, because applying both in order would make it win anyway, and the
    collision is reported rather than refused: blocking it would be stricter than the
    board, and applying both silently would leave the model's own arithmetic wrong.
    """

    held = {entry.card.oracle_id: entry for entry in entries}
    planned: dict[UUID, _PlannedChange] = {}
    collapsed: list[str] = []
    for change, card in zip(changes, resolved, strict=True):
        assert card is not None  # every token resolved before this is reached
        if card.oracle_id in planned:
            collapsed.append(card.name)
        entry = held.get(card.oracle_id)
        planned[card.oracle_id] = _PlannedChange(
            card=card,
            # The snapshot's printing when the deck holds one, because that is the entry
            # the browser will look for. The catalog's own only for a card being added.
            scryfall_id=entry.scryfall_id if entry is not None else card.scryfall_id,
            quantity=change.quantity,
            previous_quantity=entry.quantity if entry is not None else 0,
            section=_section_for_zone(change.zone),
            previous_section=_as_section(entry.section) if entry is not None else None,
        )
    return list(planned.values()), collapsed


def _edit_warnings(
    changes: list[_PlannedChange],
    *,
    commander: CardSearchResult | None,
    after_total: int,
    collapsed: list[str],
) -> list[str]:
    """Name what the edit did that Commander frowns on, without refusing any of it.

    Every one of these is a warning on the board too: the interface lets a card
    outside the commander's identity be dragged in and says so, and it does not stop a
    deck growing past a hundred cards. So this reports and still applies — an agent
    that refused where the drag target allows would be inconsistent in a way the user
    cannot see. Command-zone legality — whether this card may legally be a commander at
    all, and whether it may share the zone — stays in `frontend/src/domain/deck.ts`,
    which is the one authority on it.
    """

    warnings: list[str] = []
    if collapsed:
        warnings.append(
            f"{_quoted_list(list(dict.fromkeys(collapsed)))} was named more than once, "
            "so only the last count for it was used."
        )
    for change in changes:
        if change.delta <= 0 or commander is None:
            continue
        outside = [
            color
            for color in change.card.color_identity
            if color not in commander.color_identity
        ]
        if outside:
            warnings.append(
                f"{_quoted(change.card.name)} needs {_identity_symbols(outside)}, "
                f"which is outside {commander.name}'s "
                f"{_identity_symbols(commander.color_identity)} identity. It is in the "
                "deck; the deck is now illegal."
            )
    for change in changes:
        if change.quantity > 1 and not _is_basic_land(change.card):
            warnings.append(
                f"{_quoted(change.card.name)} is now at {change.quantity} copies, and "
                "Commander is singleton outside basic lands."
            )
    if after_total > _COMMANDER_DECK_SIZE:
        over = after_total - _COMMANDER_DECK_SIZE
        warnings.append(
            f"The deck is at {after_total} cards, {over} over the "
            f"{_COMMANDER_DECK_SIZE} a Commander deck holds."
        )
    return warnings


def _is_basic_land(card: CardSearchResult) -> bool:
    """Report whether extra copies of this card are legal in a singleton deck."""

    return "Basic" in card.type_line and "Land" in card.type_line


def _edit_lines(
    *,
    deck_name: str,
    planned: list[_PlannedChange],
    effective: list[_PlannedChange],
    after_total: int,
    warnings: list[str],
) -> list[str]:
    """Render one edit: what it did, what it did not do, and what it broke.

    Short on purpose. The counts and the reason are still sitting in the model's own
    tool call, so echoing them back costs tokens to say what it already said. What it
    could not know is what the deck held before, and therefore which of its changes
    were no-ops, what the deck now holds, and which warnings the change introduced.
    """

    lines = ["## Edit"]
    if effective:
        added = sum(change.delta for change in effective if change.delta > 0)
        removed = -sum(change.delta for change in effective if change.delta < 0)
        moved = sum(1 for change in effective if change.delta == 0)
        parts = [
            *([f"{added} added"] if added else []),
            *([f"{removed} removed"] if removed else []),
            *([f"{moved} moved"] if moved else []),
        ]
        lines.append(
            f"Applied to {_quoted(deck_name)}: {', '.join(parts)}, {after_total} "
            f"{_cards(after_total)} now."
        )
        lines.extend(f"  {_change_line(change)}" for change in effective)
    else:
        lines.append(
            f"Nothing changed in {_quoted(deck_name)} — the deck was already exactly as "
            f"you asked for it. It still has {after_total} {_cards(after_total)}."
        )
    lines.extend(
        _noop_sentences([change for change in planned if not change.effective])
    )
    if warnings:
        lines.append("")
        lines.append("Warnings, and the edit was applied anyway:")
        lines.extend(f"  {warning}" for warning in warnings)
    return lines


def _change_line(change: _PlannedChange) -> str:
    """Render one applied change as a player would write a diff line."""

    name = change.card.name
    if change.quantity == 0:
        return f"{_REMOVED} {name} (was {change.previous_quantity})"
    if change.previous_quantity == 0:
        line = f"+ {name} ({change.quantity})"
    elif change.quantity > change.previous_quantity:
        line = f"+ {name} ({change.previous_quantity} → {change.quantity})"
    elif change.quantity < change.previous_quantity:
        line = f"{_REMOVED} {name} ({change.previous_quantity} → {change.quantity})"
    else:
        return f"{name} → {_section_words(change.section)}"
    if change.section is not None and change.section != change.previous_section:
        line += f"  [{_section_words(change.section)}]"
    return line


def _noop_sentences(noops: list[_PlannedChange]) -> list[str]:
    """Say which changes did nothing, and why, without listing a hundred of them."""

    if not noops:
        return []
    shown = noops[:_MAX_REPORTED_NOOPS]
    lines = [_noop_sentence(change) for change in shown]
    remaining = len(noops) - len(shown)
    if remaining:
        lines.append(f"{remaining} more of the changes did nothing either.")
    return lines


def _noop_sentence(change: _PlannedChange) -> str:
    if change.previous_quantity == 0:
        return (
            f"{_quoted(change.card.name)} is not in the deck, so there was nothing to "
            "remove."
        )
    placement = (
        " in the command zone" if change.previous_section == "command_zone" else ""
    )
    return (
        f"{_quoted(change.card.name)} was already in the deck at "
        f"{change.previous_quantity} {_copies(change.previous_quantity)}{placement}, so "
        "that change did nothing."
    )


def _recorded_edit_count(history: DeckAgentDeckHistory | None) -> int:
    """Count the edits the posted history holds, absent history counting as none."""

    if history is None:
        return 0
    return sum(len(session.edits) for session in history.sessions)


def _session_lines(session: DeckAgentDeckSession, *, newest_day: date) -> list[str]:
    """Render one recorded session: who, when, how much, and what moved.

    `You` and `Me` rather than `user` and `agent`, because the reader of this text *is*
    the agent. Printing its own edits under a third-person label is how it comes to
    describe its own work as somebody else's.
    """

    changes = [change for edit in session.edits for change in edit.cards]
    reasons = list(dict.fromkeys(edit.reason for edit in session.edits if edit.reason))
    header = (
        f"{_ACTOR_LABELS[session.actor]}, "
        f"{_session_time(session, newest_day=newest_day)} "
        f"({len(changes)} {'change' if len(changes) == 1 else 'changes'})"
    )
    # One reason for the whole session is the ordinary case, and it belongs on the line
    # naming the session. Several means the edits disagree about intent, so each keeps
    # its own rather than one of them speaking for the rest.
    if len(reasons) == 1:
        header += f" — {_quoted(reasons[0])}"
    lines = [header]
    for edit in session.edits:
        rendered = ", ".join(_history_change_text(change) for change in edit.cards)
        if not rendered:
            rendered = "no card changes recorded"
        if edit.reason is not None and len(reasons) > 1:
            rendered += f" — {_quoted(edit.reason)}"
        # Marked on the line rather than left to the reader to work out from the deck. An
        # undone edit is the one thing in this record that is *not* true of the deck now,
        # and reading it as applied is how an answer comes to describe a card as being in a
        # deck the user took it out of.
        lines.append(f"  {_UNDONE_MARKER} {rendered}" if edit.undone else f"  {rendered}")
    return lines


def _session_time(session: DeckAgentDeckSession, *, newest_day: date) -> str:
    """Print the clock face the user saw, dating it only when it was another day.

    The browser sends each time in its own offset, so this prints it as sent rather
    than converting: the point is agreement with what was on screen. A day is named
    whenever the session did not happen on the newest one's, because a bare `14:02`
    that silently means last Tuesday is worse than no time at all.
    """

    start = session.started_at
    stamp = (
        start.strftime("%H:%M")
        if start.date() == newest_day
        else start.strftime("%Y-%m-%d %H:%M")
    )
    if _is_later(session.ended_at, start):
        stamp += f"{_TIME_RANGE}{session.ended_at.strftime('%H:%M')}"
    return stamp


def _is_later(end: datetime, start: datetime) -> bool:
    """Compare two posted timestamps, treating an incomparable pair as one moment.

    A client that sends one of them with an offset and the other without would
    otherwise raise, and a session's clock is not worth failing an answered turn over.
    """

    try:
        return end > start
    except TypeError:
        return False


def _history_change_text(change: DeckAgentDeckHistoryChange) -> str:
    """Render one recorded card change in the shortest form that stays unambiguous."""

    before, after = change.before, change.after
    if after is None or after.quantity == 0:
        return f"{_REMOVED} {change.name}"
    if before is None or before.quantity == 0:
        return f"+ {change.name}"
    if after.quantity != before.quantity:
        return f"{change.name} {before.quantity} → {after.quantity}"
    if after.section != before.section:
        return f"{change.name} → {_section_words(after.section)}"
    return change.name


def _identity_lines(card: CardSearchResult) -> list[str]:
    """Name the card and its types as separate labelled fields.

    One run-on heading made the model guess where a name ended and a type began —
    `Ancient Den — Artifact Land` reads as three things or five. Every field is
    labelled and every free-text value quoted, so nothing has to be inferred from
    punctuation.
    """

    lines = [f"Name: {_quoted(card.name)}"]
    lines.extend(_type_lines(card.type_line))
    if card.mana_cost:
        lines.append(f"  Mana cost: {_quoted(card.mana_cost)}")
    return lines


def _type_lines(type_line: str) -> list[str]:
    """Split a type line into card types and subtypes, or keep it whole when it cannot be.

    Only the left-hand side is split into separate values: card types and supertypes
    are always single words, while a subtype need not be (`Time Lord`). A
    double-faced type line holds two of these joined by `//`, so it is reported as
    printed rather than mangled into one card's worth of fields.
    """

    if "//" in type_line:
        return [f"  Types: {_quoted(type_line)}"]
    types, _, subtypes = type_line.partition("—")
    named = ", ".join(_quoted(word) for word in types.split())
    lines = [f"  Types: {named}" if named else f"  Types: {_quoted(type_line)}"]
    if subtypes.strip():
        lines.append(f"  Subtypes: {_quoted(subtypes.strip())}")
    return lines


def _rules_lines(card: CardSearchResult) -> list[str]:
    lines = [f"  Mana value: {card.mana_value:g}"]
    if card.power is not None and card.toughness is not None:
        lines.append(f"  Power/toughness: {card.power}/{card.toughness}")
    text = card.oracle_text
    if card.card_faces:
        lines.append("  Faces:")
        lines.extend(
            f"    {_quoted(face.name)} — rules: "
            f"{_quoted(face.oracle_text) if face.oracle_text else 'none printed'}"
            for face in card.card_faces
        )
    elif text:
        lines.append(f"  Rules: {_quoted(' / '.join(text.splitlines()))}")
    else:
        lines.append("  Rules: none printed on this card.")
    return lines


def _merged_similar(related: dict[str, list[str]], edhrec: list[str]) -> list[str]:
    """One similar-card list from Tagger and EDHREC, each card named once.

    Tagger's own similar cards come first and keep their order, then whatever EDHREC
    adds. A card already named under a more specific relationship is left out entirely:
    reading `Fyndhorn Elves` under both `Outclasses` and `Similar cards` costs tokens to
    say something weaker the second time.
    """

    claimed = {
        name.casefold()
        for field in _MORE_SPECIFIC_THAN_SIMILAR
        for name in related.get(field, ())
    }
    merged: list[str] = []
    for name in (*related.get(_SIMILAR_FIELD, ()), *edhrec):
        key = name.casefold()
        if key in claimed:
            continue
        claimed.add(key)
        merged.append(name)
    return merged


def _restricted(arguments: SearchCardsArguments) -> bool:
    """Report whether this search actually applied a commander's colour identity."""

    return (
        arguments.commander is not None
        and arguments.commander.restrict_to_color_identity
    )


def _commander_lines(
    commander: _SearchCommander | None,
    *,
    restricted: bool,
) -> list[str]:
    """Report only what the model could not have predicted about the commander.

    Its name is something the model typed. Its colour identity is not, and neither is
    whether the EDHREC fetch landed — so the identity is stated when it removed cards,
    and EDHREC is mentioned only when it is *missing*, since a successful lookup is
    already visible on every card's own inclusion line.

    With no commander at all there is nothing to say: the model knows it named none,
    and an EDHREC ordering would have been refused outright.
    """

    if commander is None:
        return []
    lines: list[str] = []
    if restricted:
        identity = _identity_symbols(commander.card.color_identity)
        lines.append(f"Cards outside {commander.card.name}'s {identity} identity were removed.")
    if commander.note:
        lines.append(commander.note)
    return lines


def _theme_lines(themes: tuple[EdhrecDeckTheme, ...]) -> list[str]:
    """Name a commander's deck themes, with the deck count behind each.

    EDHREC orders these by popularity and the tail runs down to a single deck, so the
    count is reported alongside: sorting by synergy within a three-deck theme is
    evidence about three decks. Only the head is listed, because a commander can
    advertise sixty-odd and the rest are not worth their tokens — a slug past the cap
    still works, and getting one wrong is what lists every one of them.
    """

    if not themes:
        return []
    shown = themes[:_MAX_REPORTED_THEMES]
    named = ", ".join(
        f"{_quoted(theme.slug)} ({theme.deck_count:,} "
        f"{'deck' if theme.deck_count == 1 else 'decks'})"
        for theme in shown
    )
    line = f"  Deck themes, most played first: {named}"
    remaining = len(themes) - len(shown)
    if remaining:
        line += (
            f" — and {remaining} more, none in over {shown[-1].deck_count:,} decks."
        )
    else:
        line += "."
    return [line]


def _evidence_lines(
    candidate: AgentSearchCandidate,
    *,
    commander: _SearchCommander | None,
) -> list[str]:
    """Report why this card ranked where it did, in the same shape `see_cards` uses."""

    eur = candidate.card.prices.eur
    # One estimate, not the three-way breakdown `see_cards` gives when asked: in a
    # search the price is one selection signal among several, and this is the currency
    # every other price surface in the application leads with. A card with no reported
    # price is not a free card, so it must not render as one.
    lines = [
        f"  Price: EUR {eur}" if eur is not None else "  Price: none reported."
    ]
    if candidate.semantic_score is not None:
        lines.append(f"  Semantic closeness: {candidate.semantic_score:.3f} of 1")
    if commander is None or candidate.edhrec_inclusion is None:
        if commander is not None and commander.has_edhrec:
            # Said rather than left blank: a card EDHREC does not list scores zero for
            # inclusion, which is a real signal about the card and not missing data.
            lines.append(
                "  Inclusion: not among the cards EDHREC lists for "
                f"{commander.card.name}."
            )
        return lines
    share = f"{candidate.edhrec_inclusion * 100:.0f}%"
    decks = f"{candidate.edhrec_num_decks:,}" if candidate.edhrec_num_decks else "?"
    detail = f"  Inclusion: {share} of {decks} {commander.card.name} decks"
    if candidate.edhrec_synergy is not None:
        detail += f", synergy {candidate.edhrec_synergy:+.2f}"
    lines.append(detail)
    return lines


def _identity_symbols(colors: list[str] | tuple[str, ...]) -> str:
    """Write a colour identity the way the interface draws it, or name its absence."""

    return "".join(f"{{{color}}}" for color in colors) or "colorless"


def _quoted(value: str) -> str:
    return f'"{value}"'


def _quoted_list(values: list[str]) -> str:
    return ", ".join(_quoted(value) for value in values)


def _prices(card: CardSearchResult) -> str:
    """Report the daily estimates that exist, and say so when none do.

    A card with no reported price is not a free card, so it must not render as one.
    """

    parts = [
        _price_part("EUR", card.prices.eur),
        _price_part("EUR foil", card.prices.eur_foil),
        _price_part("USD", card.prices.usd),
    ]
    reported = [part for part in parts if part is not None]
    if not reported:
        return "no price reported for this printing."
    return ", ".join(reported)


def _price_part(label: str, value: Decimal | None) -> str | None:
    return None if value is None else f"{label} {value}"


def _commander_legality(card: CardSearchResult) -> str:
    legality = card.legalities.get("commander")
    return str(legality) if legality is not None else "not reported."


def _signature(name: object, arguments: dict[str, Any]) -> str:
    if name == READ_DECK:
        return f"{READ_DECK}()"
    if name == SEE_CARDS:
        cards = arguments.get("cards")
        count = len(cards) if isinstance(cards, list) else 0
        return f"{SEE_CARDS}({count} cards)"
    if name == SEARCH_CARDS:
        # Built from the raw arguments rather than a validated model, because this is
        # the path taken when validation is what failed.
        intent = arguments.get("semantic_sort") or arguments.get("name_sort")
        return _bounded(
            f"{SEARCH_CARDS}({_elided(str(intent)) if intent else 'filters only'})"
        )
    if name == EDIT_DECK:
        return _edit_deck_signature(_raw_edit_tokens(arguments.get("changes")))
    if name == READ_HISTORY:
        limit = arguments.get("limit")
        return _bounded(
            f"{READ_HISTORY}({limit} sessions)"
            if isinstance(limit, int)
            else f"{READ_HISTORY}(?)"
        )
    return _bounded(f"{name}(…)")


def _raw_edit_tokens(changes: object) -> list[str]:
    """Read the card tokens out of arguments that may not have validated.

    The tool line is shown for a failed call too — a rejected `quantity` is exactly
    the call worth being able to read — so this takes whatever arrived and names what
    it can.
    """

    if not isinstance(changes, list):
        return []
    return [
        str(change["card"])
        for change in changes
        if isinstance(change, dict) and change.get("card") is not None
    ]


def _bounded(signature: str) -> str:
    """Keep a tool line inside the field it is validated into."""

    if len(signature) <= _SIGNATURE_LIMIT:
        return signature
    return signature[: _SIGNATURE_LIMIT - 1] + "…"


def _search_cards_signature(
    arguments: SearchCardsArguments,
    *,
    commander: _SearchCommander | None,
) -> str:
    """Render the search the way the chat shows it: what for, how ordered, for whom."""

    parts: list[str] = []
    if arguments.semantic_sort is not None:
        parts.append(_elided(arguments.semantic_sort))
    if arguments.name_sort is not None:
        parts.append(f"name {arguments.name_sort}")
    if not parts:
        parts.append("filters only")
    parts.append(arguments.sort_by or DEFAULT_AGENT_SORT)
    if commander is not None:
        # The theme rides with the name, because after the commander it is the argument
        # that changes the result most and it is otherwise invisible in the transcript.
        theme = f" / {commander.theme_slug}" if commander.theme_slug else ""
        parts.append(f"{commander.card.name}{theme}")
    return _bounded(f"{SEARCH_CARDS}({' · '.join(parts)})")


def _elided(value: str) -> str:
    """Shorten one value to fit a tool line, marking that it was shortened."""

    collapsed = " ".join(value.split())
    if len(collapsed) <= _SIGNATURE_TEXT_LIMIT:
        return collapsed
    return collapsed[: _SIGNATURE_TEXT_LIMIT - 1].rstrip() + "…"


def _see_cards_signature(
    cards: list[str],
    details: list[CardDetail],
    *,
    dropped: int,
) -> str:
    """Render the call the way the chat shows it: what was asked, how deep."""

    shown = ", ".join(cards[:3])
    if len(cards) > 3:
        shown += f", +{len(cards) - 3} more"
    signature = f"{SEE_CARDS}({shown} · {', '.join(details)})"
    if dropped:
        signature += f" — {dropped} not read"
    return _bounded(signature)


def _edit_deck_signature(tokens: list[str]) -> str:
    """Render the edit the way the chat shows it: how many cards, and which of them.

    Clamped like every other tool line, and here it is not a formality: a hundred
    changes naming two-hundred-character cards is a valid call, and a signature that
    long would fail `ShortLabel` validation and take down a turn that had already
    changed the deck.
    """

    shown = ", ".join(tokens[:_SIGNATURE_NAMED_CARDS])
    if len(tokens) > _SIGNATURE_NAMED_CARDS:
        shown += f", +{len(tokens) - _SIGNATURE_NAMED_CARDS} more"
    label = f"{len(tokens)} {'change' if len(tokens) == 1 else 'changes'}"
    return _bounded(f"{EDIT_DECK}({label} · {shown})" if shown else f"{EDIT_DECK}({label})")


def _read_history_signature(limit: int) -> str:
    """Render the history read the way the chat shows it: how far back it looked."""

    return _bounded(f"{READ_HISTORY}(last {limit} sessions)")


def _first_error(exc: ValidationError) -> str:
    errors = exc.errors()
    if not errors:
        return "invalid arguments"
    first = errors[0]
    location = ".".join(str(part) for part in first.get("loc", ())) or "arguments"
    return f"{location}: {first.get('msg', 'invalid')}"
