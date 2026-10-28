export type PopupInput =
  | { readonly kind: "render" }
  | { readonly kind: "hash-changed" }
  | { readonly kind: "close-requested" }
  | { readonly kind: "dialog-closed"; readonly dialogId: string };

export interface PopupView {
  readonly hash: string;
  readonly deepLinkEntry: boolean;
  readonly openDialogId: string | null;
  readonly hashDialogId: string | null;
  readonly closePending: boolean;
}

export type PopupAction =
  | { readonly kind: "stamp-deep-link-entry" }
  | { readonly kind: "close-through-back" }
  | { readonly kind: "close-through-replace" }
  | { readonly kind: "close-dialog"; readonly dialogId: string }
  | { readonly kind: "restore-focus"; readonly dialogId: string }
  | { readonly kind: "show-dialog"; readonly dialogId: string };

export interface PopupDecision {
  readonly actions: readonly PopupAction[];
  readonly closePending: boolean;
}

/** True for a popup hash: starts with "#book-". */
export function isPopupHash(hash: string): boolean {
  return hash.startsWith("#book-");
}

export function decidePopup(input: PopupInput, view: PopupView): PopupDecision {
  if (input.kind === "close-requested") return closePopup(view);

  if (input.kind === "dialog-closed") {
    return view.hash.slice(1) === input.dialogId ? closePopup(view) : noAction(view.closePending);
  }

  const actions: PopupAction[] = [];

  if (input.kind === "render" && isPopupHash(view.hash)) actions.push({ kind: "stamp-deep-link-entry" });
  actions.push(...syncPopup(view));

  return { actions, closePending: false };
}

function closePopup(view: PopupView): PopupDecision {
  if (!isPopupHash(view.hash) || view.closePending) return noAction(view.closePending);

  if (view.deepLinkEntry) return { actions: [{ kind: "close-through-replace" }], closePending: view.closePending };

  return { actions: [{ kind: "close-through-back" }], closePending: true };
}

function syncPopup(view: PopupView): PopupAction[] {
  const actions: PopupAction[] = [];
  const { hashDialogId: target, openDialogId: open } = view;

  if (open !== null && open !== target) {
    actions.push({ kind: "close-dialog", dialogId: open });

    if (target === null) actions.push({ kind: "restore-focus", dialogId: open });
  }

  if (target !== null && target !== open) actions.push({ kind: "show-dialog", dialogId: target });

  return actions;
}

function noAction(closePending: boolean): PopupDecision {
  return { actions: [], closePending };
}
