import { describe, expect, test } from "bun:test";
import { gridKey, nextCard, type CardPosition } from "../../../ui/gridnav/gridnav.ts";

interface GridLayout {
  readonly cards: number;
  readonly columns: number;
  readonly xStep: number;
  readonly yStep: number;
}

function gridLayout(overrides: Partial<GridLayout> = {}): CardPosition[] {
  const { cards = 6, columns = 3, xStep = 100, yStep = 100 } = overrides;

  return Array.from({ length: cards }, (_, index) => ({
    x: (index % columns) * xStep,
    y: Math.floor(index / columns) * yStep,
  }));
}

describe("gridKey", () => {
  test("maps arrow and WASD codes to directions", () => {
    // #given navigation key codes from the browser
    const codes = ["ArrowRight", "KeyD", "ArrowLeft", "KeyA", "ArrowUp", "KeyW", "ArrowDown", "KeyS"];

    // #when each code is classified
    const result = codes.map((code) => gridKey(code));

    // #then each code has its defined movement direction
    expect(result).toEqual(["right", "right", "left", "left", "up", "up", "down", "down"]);
  });

  test("ignores non-navigation codes", () => {
    // #given key codes that do not navigate the card grid
    const codes = ["Enter", "Tab", "KeyQ", ""];

    // #when each code is classified
    const result = codes.map((code) => gridKey(code));

    // #then none of them produces a grid movement
    expect(result).toEqual([null, null, null, null]);
  });
});

describe("nextCard", () => {
  test("enters the first card when focus is outside a non-empty grid", () => {
    // #given non-empty and empty grids while focus is not on a card
    const cards = [gridLayout(), []] as const;

    // #when either navigation key is pressed
    const result = [nextCard(cards[0], -1, "left"), nextCard(cards[1], -1, "right")];

    // #then the non-empty grid enters at its first card and the empty grid has no destination
    expect(result).toEqual([0, null]);
  });

  test("moves left and right by one card within a row", () => {
    // #given focus on the middle card of the first row
    const cards = gridLayout();

    // #when horizontal navigation is requested
    const result = [nextCard(cards, 1, "right"), nextCard(cards, 1, "left")];

    // #then it moves to the adjacent card in that row
    expect(result).toEqual([2, 0]);
  });

  test("stops horizontal movement at row edges", () => {
    // #given focus on the two inner row edges of a two-row grid
    const cards = gridLayout();

    // #when navigation would cross into another row
    const result = [nextCard(cards, 2, "right"), nextCard(cards, 3, "left")];

    // #then neither move has a destination
    expect(result).toEqual([null, null]);
  });

  test("stops horizontal movement at the first and last grid cards", () => {
    // #given a single-row grid with focus on either grid end
    const cards = gridLayout({ cards: 3 });

    // #when navigation would leave the grid
    const result = [nextCard(cards, 2, "right"), nextCard(cards, 0, "left")];

    // #then neither move has a destination
    expect(result).toEqual([null, null]);
  });

  test("moves vertically to the matching column", () => {
    // #given focus on matching-column cards in a three-column grid
    const cards = gridLayout();

    // #when vertical navigation scans past cards in other columns
    const result = [nextCard(cards, 1, "down"), nextCard(cards, 4, "up")];

    // #then it finds the card in the same column of the adjacent row
    expect(result).toEqual([4, 1]);
  });

  test("stops vertical movement above the first row and below a short final row", () => {
    // #given a final row without a card in the rightmost column
    const cards = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ];

    // #when navigation would leave the first row or enter the missing final-row card
    const result = [nextCard(cards, 1, "up"), nextCard(cards, 2, "down")];

    // #then neither move has a destination
    expect(result).toEqual([null, null]);
  });
});
