import { createFocusTrap } from "focus-trap";
import type { FocusTrap } from "focus-trap";
import { Gridnav } from "./gridnav.ts";

const POPUP_HASH = /^#book-/;

function popupIsOpen(): boolean {
  return POPUP_HASH.test(location.hash);
}

let activeTrap: FocusTrap | null = null;
let lastTrigger: HTMLElement | null = null;

function closePopup(): void {
  if (popupIsOpen()) history.back();
}

function syncPopup(): void {
  const id = location.hash.slice(1);
  const popup = id ? document.getElementById(id) : null;

  if (popup?.classList.contains("popup")) {
    lastTrigger = (document.querySelector(`a[href="#${id}"]`) as HTMLElement) ?? lastTrigger;
    popup.setAttribute("tabindex", "-1");
    activeTrap?.deactivate();
    activeTrap = createFocusTrap(popup, {
      escapeDeactivates: false,
      clickOutsideDeactivates: false,
      initialFocus: popup,
      fallbackFocus: popup,
      returnFocusOnDeactivate: false,
    });
    activeTrap.activate();
    return;
  }

  activeTrap?.deactivate();
  activeTrap = null;
  if (lastTrigger) {
    lastTrigger.focus();
    lastTrigger = null;
  }
}

function init(): void {
  const grid = document.querySelector<HTMLElement>(".books-grid");
  if (grid) new Gridnav(grid, popupIsOpen);

  window.addEventListener("hashchange", syncPopup);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && popupIsOpen()) {
      e.preventDefault();
      closePopup();
    }
  });

  document.addEventListener("click", (e) => {
    const close = (e.target as HTMLElement).closest?.(".popup__close-button");
    if (close) {
      e.preventDefault();
      closePopup();
    }
  });

  syncPopup();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
