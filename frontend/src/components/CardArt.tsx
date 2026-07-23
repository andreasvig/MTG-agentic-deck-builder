import { ImageOff } from "lucide-react";

import type { CardSearchResult } from "../domain/card";
import { getCardImage } from "../domain/card";

interface CardArtProps {
  card: CardSearchResult;
  size?: "small" | "normal" | "large";
  loading?: "eager" | "lazy";
}

export function CardArt({
  card,
  size = "normal",
  loading = "lazy",
}: CardArtProps) {
  const source = getCardImage(card, size);

  if (!source) {
    return (
      <span className="card-art card-art--missing" aria-label="Card image unavailable">
        <ImageOff aria-hidden="true" size={22} />
        <span>{card.name}</span>
      </span>
    );
  }

  return (
    <img
      className="card-art"
      src={source}
      alt={`${card.name} card`}
      loading={loading}
      decoding="async"
    />
  );
}
