/*
  Gridnav — keyboard 2D navigation for the card grid.
  Based on the original by Christian Heilmann (c) 2016, MIT license.
  Arrow keys / WASD move focus; movement stops at grid edges (no wrap).
*/

export type GridKey = "left" | "right" | "up" | "down";

export interface CardPosition {
  readonly x: number;
  readonly y: number;
}

export function gridKey(code: string): GridKey | null {
  switch (code) {
    case "ArrowRight":
    case "KeyD":
      return "right";
    case "ArrowLeft":
    case "KeyA":
      return "left";
    case "ArrowUp":
    case "KeyW":
      return "up";
    case "ArrowDown":
    case "KeyS":
      return "down";
    default:
      return null;
  }
}

export function nextCard(cards: readonly CardPosition[], current: number, key: GridKey): number | null {
  if (current === -1) return cards.length > 0 ? 0 : null;

  const currentCard = cards[current];

  if (!currentCard) return null;

  if (key === "right" || key === "left") {
    const next = current + (key === "right" ? 1 : -1);

    return cards[next]?.y === currentCard.y ? next : null;
  }

  const step = key === "down" ? 1 : -1;

  for (let index = current + step; cards[index]; index += step) {
    const card = cards[index]!;

    if (card.x === currentCard.x && card.y !== currentCard.y) return index;
  }

  return null;
}
