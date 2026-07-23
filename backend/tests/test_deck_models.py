from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from mtg_deck_builder.domain import CardReference, Deck, DeckCardEntry, DeckSection


def make_card() -> CardReference:
    return CardReference(
        oracle_id=uuid4(),
        scryfall_id=uuid4(),
        name=" Sol Ring ",
    )


def test_commander_deck_contract_normalizes_names_and_categories() -> None:
    now = datetime.now(UTC)
    entry = DeckCardEntry(
        card=make_card(),
        quantity=1,
        section=DeckSection.COMMAND_ZONE,
        categories=[" Commander "],
    )

    deck = Deck(
        id=uuid4(),
        name=" Artifacts ",
        cards=[entry],
        created_at=now,
        updated_at=now,
    )

    assert deck.name == "Artifacts"
    assert deck.format == "commander"
    assert deck.cards[0].card.name == "Sol Ring"
    assert deck.cards[0].categories == ["Commander"]
    assert deck.cards[0].section == DeckSection.COMMAND_ZONE


@pytest.mark.parametrize("quantity", [0, -1])
def test_card_entry_rejects_non_positive_quantity(quantity: int) -> None:
    with pytest.raises(ValidationError):
        DeckCardEntry(
            card=make_card(),
            quantity=quantity,
            section=DeckSection.MAINBOARD,
        )


@pytest.mark.parametrize("name", ["", "   "])
def test_deck_rejects_empty_name(name: str) -> None:
    now = datetime.now(UTC)
    with pytest.raises(ValidationError):
        Deck(
            id=uuid4(),
            name=name,
            created_at=now,
            updated_at=now,
        )


def test_contract_rejects_unsupported_format_and_extra_fields() -> None:
    now = datetime.now(UTC)
    with pytest.raises(ValidationError):
        Deck.model_validate(
            {
                "id": uuid4(),
                "name": "Artifacts",
                "format": "modern",
                "created_at": now,
                "updated_at": now,
                "owner_id": uuid4(),
            }
        )


def test_card_entry_rejects_duplicate_categories_after_normalization() -> None:
    with pytest.raises(ValidationError):
        DeckCardEntry(
            card=make_card(),
            quantity=1,
            section=DeckSection.MAYBEBOARD,
            categories=["Ramp", "Ramp"],
        )
