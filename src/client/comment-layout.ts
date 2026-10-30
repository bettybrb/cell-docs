/** A comment card to place in the margin: where it wants to be and how tall it is (pixels). */
export interface CardSize {
  id: number;
  desired: number;
  height: number;
}

export const CARD_GAP = 8;

/**
 * Places margin cards (given in display order) as near their text as they
 * can be without overlapping, like Google Docs: the active card sits exactly
 * beside its text, the cards above it move up to make room and the cards
 * below move down. No card goes above the top of the margin. Returns each
 * card's top, in the same order.
 */
export function layoutCards(cards: CardSize[], activeId: number | null): number[] {
  const tops = cards.map((card) => card.desired);
  const active = cards.findIndex((card) => card.id === activeId);
  for (let i = active - 1; i >= 0; i--) tops[i] = Math.min(tops[i]!, tops[i + 1]! - CARD_GAP - cards[i]!.height);
  // From the top down, each card goes below the one before it.
  for (let i = 0; i < cards.length; i++) {
    const below = i === 0 ? 0 : tops[i - 1]! + cards[i - 1]!.height + CARD_GAP;
    tops[i] = Math.max(tops[i]!, below);
  }
  return tops;
}
