/*
  Gridnav — keyboard 2D navigation for the card grid.
  Based on the original by Christian Heilmann (c) 2016, MIT license.
  Arrow keys / WASD move focus; movement stops at grid edges (no wrap).
*/

type Move = number | "up" | "down";

export class Gridnav {
  private list: HTMLElement;
  private selector: string;
  private items: HTMLElement[];
  private keyMoves: Record<string, Move>;

  constructor(list: HTMLElement, isBlocked: () => boolean = () => false) {
    this.list = list;
    this.selector = list.getAttribute("data-element") || ".card__title a";
    this.items = Array.from(list.querySelectorAll<HTMLElement>(this.selector));

    const amount = list.getAttribute("data-amount") ? Number(list.getAttribute("data-amount")) : null;
    this.keyMoves = {
      ArrowRight: 1,
      KeyD: 1,
      ArrowLeft: -1,
      KeyA: -1,
      ArrowUp: amount ? -amount : "up",
      KeyW: amount ? -amount : "up",
      ArrowDown: amount ? amount : "down",
      KeyS: amount ? amount : "down",
    };

    this.isBlocked = isBlocked;
    list.addEventListener("keydown", this.onKeydown);
  }

  private isBlocked: () => boolean;

  destroy(): void {
    this.list.removeEventListener("keydown", this.onKeydown);
  }

  private card(el: HTMLElement): HTMLElement {
    return (el.closest(".card") as HTMLElement) || el;
  }

  private position(el: HTMLElement): { x: number; y: number } {
    const card = this.card(el);
    return { x: card.offsetLeft, y: card.offsetTop };
  }

  private focusWithScroll(el: HTMLElement): void {
    const card = this.card(el);
    const rect = card.getBoundingClientRect();
    const isAbove = rect.top < 0;
    const isBelow = rect.bottom > window.innerHeight;

    if (!isAbove && !isBelow) {
      el.focus();
      return;
    }

    card.scrollIntoView({ block: isBelow ? "end" : "start", behavior: "smooth" });
    if ("onscrollend" in window) {
      window.addEventListener("scrollend", () => el.focus(), { once: true });
    } else {
      setTimeout(() => el.focus(), 300);
    }
  }

  private onKeydown = (ev: KeyboardEvent): void => {
    if (this.isBlocked()) return;
    const target = ev.target as HTMLElement;
    if (!target.matches?.(this.selector)) return;

    const move = this.keyMoves[ev.code];
    if (move === undefined) return;

    const currentIndex = this.items.indexOf(target);
    if (currentIndex === -1) return;

    ev.preventDefault();

    if (typeof move === "number") {
      const next = this.items[currentIndex + move];
      if (!next) return;
      // Horizontal steps stop at the row edge instead of wrapping to the next row.
      if (Math.abs(move) === 1 && this.position(next).y !== this.position(target).y) return;
      this.focusWithScroll(next);
      return;
    }

    const pos = this.position(this.items[currentIndex]!);
    const direction = move === "up" ? -1 : 1;
    for (let i = currentIndex + direction; this.items[i]; i += direction) {
      const targetPos = this.position(this.items[i]!);
      if (targetPos.x === pos.x && targetPos.y !== pos.y) {
        this.focusWithScroll(this.items[i]!);
        break;
      }
    }
  };
}
