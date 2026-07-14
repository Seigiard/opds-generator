import { createFocusTrap } from "focus-trap";
import type { FocusTrap } from "focus-trap";
import { Gridnav } from "./gridnav.ts";

const POPUP_HASH = /^#book-/;

function popupIsOpen(): boolean {
  return POPUP_HASH.test(location.hash);
}

let activeTrap: FocusTrap | null = null;
let lastTrigger: HTMLElement | null = null;

// A #book-N hash present at page load (deep link, reload) has no in-page history
// entry behind it — history.back() would leave the site. Stamp that entry so
// closePopup clears the hash in place instead; card-click entries carry null state.
function stampEntryPopup(): void {
  if (popupIsOpen()) history.replaceState({ popupEntry: true }, "");
}

// history.back() resolves asynchronously; block repeat Esc / double-click until
// the resulting hashchange runs syncPopup, or the second back() leaves the folder.
let closing = false;

function closePopup(): void {
  if (!popupIsOpen() || closing) return;
  if ((history.state as { popupEntry?: boolean } | null)?.popupEntry) {
    // :target only re-evaluates on real fragment navigation — replaceState hides the
    // hash but leaves the popup visible. location.replace navigates without adding a
    // history entry; empty-fragment navigation resets scroll, so restore it.
    const { scrollX, scrollY } = window;
    location.replace("#");
    scrollTo(scrollX, scrollY);
    return;
  }
  closing = true;
  history.back();
}

function syncPopup(): void {
  closing = false;
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

  stampEntryPopup();
  syncPopup();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
