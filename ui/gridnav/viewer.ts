import { Gridnav } from "./gridnav.ts";

const POPUP_HASH = /^#book-/;
const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD"]);

function popupIsOpen(): boolean {
  return POPUP_HASH.test(location.hash);
}

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
    // A deep-link entry has nothing behind it. location.replace navigates without
    // adding a history entry; empty-fragment navigation resets scroll, so restore it.
    const { scrollX, scrollY } = window;
    location.replace("#");
    scrollTo(scrollX, scrollY);
    return;
  }
  closing = true;
  history.back();
}

function popupDialog(id: string): HTMLDialogElement | null {
  const el = id ? document.getElementById(id) : null;
  return el instanceof HTMLDialogElement && el.classList.contains("popup") ? el : null;
}

function openDialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>("dialog.popup[open]");
}

// UA focus restore targets the previously focused element, which is body for
// Safari/macOS-Firefox mouse opens and for deep-link opens — so restore explicitly.
function restoreTrigger(dialogId: string): void {
  document.querySelector<HTMLElement>(`a[href="#${dialogId}"]`)?.focus();
}

function syncPopup(): void {
  closing = false;
  const target = popupDialog(location.hash.slice(1));
  const open = openDialog();

  if (open && open !== target) {
    const closedId = open.id;
    open.close();
    if (!target) restoreTrigger(closedId);
  }

  if (target && !target.open) target.showModal();
}

let activeGrid: Gridnav | null = null;

/** Attach document/window listeners once. They survive innerHTML swaps, so re-calling would leak duplicates. */
export function initGlobal(): void {
  window.addEventListener("hashchange", syncPopup);

  // First arrow/WASD press anywhere on the page enters the grid at its first card.
  // Looks the grid up fresh each press so it keeps working after the playground re-renders.
  document.addEventListener("keydown", (e) => {
    if (!NAV_KEYS.has(e.code) || popupIsOpen()) return;
    const grid = document.querySelector<HTMLElement>(".books-grid");
    if (!grid) return;
    const selector = grid.getAttribute("data-element") || ".card__title a";
    const target = e.target as HTMLElement;
    if (target.matches?.(selector)) return;
    if (target.closest?.("input, textarea, select, [contenteditable]")) return;
    const first = grid.querySelector<HTMLElement>(selector);
    if (first) {
      e.preventDefault();
      first.focus();
    }
  });

  document.addEventListener("click", (e) => {
    const close = (e.target as HTMLElement).closest?.(".popup__close-button");
    if (close) {
      e.preventDefault();
      closePopup();
    }
  });
}

/**
 * Wire the (re)rendered viewer markup under `root`: grid navigation and per-dialog
 * listeners live on elements the playground replaces on each cassette, so this re-runs.
 * Esc does not close the dialog directly — its cancel event is converted into a history
 * navigation so Esc/close-button/Back share one close path and the hash never desyncs.
 * The close listener re-syncs if the UA force-closes the dialog (Chrome two-Esc).
 */
export function wire(root: ParentNode = document): void {
  activeGrid?.destroy();
  const grid = root.querySelector<HTMLElement>(".books-grid");
  activeGrid = grid ? new Gridnav(grid, popupIsOpen) : null;

  root.querySelectorAll<HTMLDialogElement>("dialog.popup").forEach((dialog) => {
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      closePopup();
    });
    dialog.addEventListener("close", () => {
      if (location.hash.slice(1) === dialog.id) closePopup();
    });
  });

  stampEntryPopup();
  syncPopup();
}
