import { describe, expect, it } from "vitest";
import { CARD_GAP, layoutCards } from "../../src/client/comment-layout";

const card = (id: number, desired: number, height = 50) => ({ id, desired, height });

describe("layoutCards", () => {
  it("puts each card beside its text when there is room", () => {
    expect(layoutCards([card(1, 0), card(2, 100), card(3, 300)], null)).toEqual([0, 100, 300]);
  });

  it("moves cards down so they never overlap", () => {
    expect(layoutCards([card(1, 0), card(2, 10), card(3, 20)], null)).toEqual([0, 50 + CARD_GAP, 2 * (50 + CARD_GAP)]);
  });

  it("puts the active card beside its text and moves the cards above it up", () => {
    expect(layoutCards([card(1, 100), card(2, 110), card(3, 120)], 2)).toEqual([110 - CARD_GAP - 50, 110, 110 + 50 + CARD_GAP]);
  });

  it("never moves a card above the top of the margin", () => {
    expect(layoutCards([card(1, 0), card(2, 10)], 2)).toEqual([0, 50 + CARD_GAP]);
  });
});
