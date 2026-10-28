import * as v from "valibot";
import { Gridnav } from "./gridnav.ts";
import { decidePopup, isPopupHash, type PopupAction, type PopupInput, type PopupView } from "./popup-rules.ts";

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD"]);

function popupIsOpen(): boolean {
  return isPopupHash(location.hash);
}

let closePending = false;

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

function popupView(): PopupView {
  const state = v.safeParse(v.object({ popupEntry: v.optional(v.boolean()) }), history.state);
  const open = openDialog();
  const target = popupDialog(location.hash.slice(1));

  return {
    closePending,
    deepLinkEntry: state.success && state.output.popupEntry === true,
    hash: location.hash,
    hashDialogId: target?.id ?? null,
    openDialogId: open?.id ?? null,
  };
}

function executePopupAction(action: PopupAction): void {
  switch (action.kind) {
    case "stamp-deep-link-entry":
      // A #book-N hash present at page load (deep link, reload) has no in-page history
      // entry behind it — history.back() would leave the site. Stamp that entry so
      // close through replace clears the hash in place; card-click entries carry null state.
      history.replaceState({ popupEntry: true }, "");
      break;
    case "close-through-back":
      // history.back() resolves asynchronously; block repeat Esc / double-click until the
      // resulting hashchange runs, or the second back() leaves the folder.
      history.back();
      break;
    case "close-through-replace": {
      // A deep-link entry has nothing behind it. location.replace navigates without
      // adding a history entry; empty-fragment navigation resets scroll, so restore it.
      const { scrollX, scrollY } = window;
      location.replace("#");
      scrollTo(scrollX, scrollY);
      break;
    }

    case "close-dialog":
      popupDialog(action.dialogId)?.close();
      break;
    case "restore-focus":
      restoreTrigger(action.dialogId);
      break;
    case "show-dialog":
      popupDialog(action.dialogId)?.showModal();
      break;
  }
}

function handlePopup(input: PopupInput): void {
  const decision = decidePopup(input, popupView());
  closePending = decision.closePending;
  decision.actions.forEach(executePopupAction);
}

let activeGrid: Gridnav | null = null;

/** Attach document/window listeners once. They survive innerHTML swaps, so re-calling would leak duplicates. */
export function initGlobal(): void {
  window.addEventListener("hashchange", () => handlePopup({ kind: "hash-changed" }));

  // First arrow/WASD press anywhere on the page enters the grid at its first card.
  // Looks the grid up fresh each press so it keeps working after the playground re-renders.
  document.addEventListener("keydown", (e) => {
    if (!NAV_KEYS.has(e.code) || popupIsOpen()) return;
    const grid = document.querySelector<HTMLElement>(".books-grid");

    if (!grid) return;
    const selector = grid.getAttribute("data-element") || ".card__title a";
    const target = e.target;

    if (target instanceof Element && target.matches(selector)) return;

    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]")) return;
    const first = grid.querySelector<HTMLElement>(selector);

    if (first) {
      e.preventDefault();
      first.focus();
    }
  });

  document.addEventListener("click", (e) => {
    const close = e.target instanceof Element ? e.target.closest(".popup__close-button") : null;

    if (close) {
      e.preventDefault();
      handlePopup({ kind: "close-requested" });
    }
  });
}

/**
 * Wire the (re)rendered viewer markup under `root`: grid navigation and per-dialog
 * listeners live on elements the viewer replaces on each render, so this re-runs.
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
      handlePopup({ kind: "close-requested" });
    });
    dialog.addEventListener("close", () => {
      handlePopup({ kind: "dialog-closed", dialogId: dialog.id });
    });
  });

  handlePopup({ kind: "render" });
}
