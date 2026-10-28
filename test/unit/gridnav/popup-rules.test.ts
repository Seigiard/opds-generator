import { describe, expect, test } from "bun:test";
import { decidePopup, isPopupHash, type PopupInput, type PopupView } from "../../../ui/gridnav/popup-rules.ts";

function popupView(overrides: Partial<PopupView> = {}): PopupView {
  return {
    closePending: false,
    deepLinkEntry: false,
    hash: "",
    hashDialogId: null,
    openDialogId: null,
    ...overrides,
  };
}

function decide(input: PopupInput, overrides: Partial<PopupView> = {}) {
  return decidePopup(input, popupView(overrides));
}

describe("decidePopup", () => {
  test("opens the dialog named by a new popup hash", () => {
    // #given a card hash with its matching dialog available and no dialog open
    const input: PopupInput = { kind: "hash-changed" };

    // #when the hash change is decided
    const result = decide(input, { hash: "#book-1", hashDialogId: "book-1" });

    // #then the matching dialog is shown without a pending close
    expect(result).toEqual({ actions: [{ kind: "show-dialog", dialogId: "book-1" }], closePending: false });
  });

  test("closes an in-folder popup through Back", () => {
    // #given an open popup reached from a card link in the same folder
    const input: PopupInput = { kind: "close-requested" };

    // #when Esc or the close button requests closure
    const result = decide(input, { hash: "#book-1", hashDialogId: "book-1", openDialogId: "book-1" });

    // #then the adapter goes Back and blocks another close until the hash changes
    expect(result).toEqual({ actions: [{ kind: "close-through-back" }], closePending: true });
  });

  test("does not navigate again while a close through Back is pending", () => {
    // #given the first close request is waiting for its asynchronous hash change
    const input: PopupInput = { kind: "close-requested" };

    // #when another Esc press or close-button click arrives
    const result = decide(input, { closePending: true, hash: "#book-1", hashDialogId: "book-1", openDialogId: "book-1" });

    // #then it leaves the pending close unchanged without another navigation
    expect(result).toEqual({ actions: [], closePending: true });
  });

  test("closes the dialog and restores its trigger after Back clears the hash", () => {
    // #given Back has cleared an open popup hash after a close was pending
    const input: PopupInput = { kind: "hash-changed" };

    // #when the hash change is decided
    const result = decide(input, { closePending: true, openDialogId: "book-1" });

    // #then the old dialog closes, its card regains focus, and the pending state clears
    expect(result).toEqual({
      actions: [
        { kind: "close-dialog", dialogId: "book-1" },
        { kind: "restore-focus", dialogId: "book-1" },
      ],
      closePending: false,
    });
  });

  test("stamps and opens a deep-link popup during render", () => {
    // #given page load has a popup hash with its matching dialog available
    const input: PopupInput = { kind: "render" };

    // #when the viewer markup is wired
    const result = decide(input, { hash: "#book-3", hashDialogId: "book-3" });

    // #then it stamps the history entry before showing the deep-link dialog
    expect(result).toEqual({
      actions: [{ kind: "stamp-deep-link-entry" }, { kind: "show-dialog", dialogId: "book-3" }],
      closePending: false,
    });
  });

  test("clears a deep-link popup through replace", () => {
    // #given an open popup loaded directly with no in-folder history entry behind it
    const input: PopupInput = { kind: "close-requested" };

    // #when Esc or the close button requests closure
    const result = decide(input, { deepLinkEntry: true, hash: "#book-3", hashDialogId: "book-3", openDialogId: "book-3" });

    // #then the adapter replaces the fragment rather than leaving the folder through Back
    expect(result).toEqual({ actions: [{ kind: "close-through-replace" }], closePending: false });
  });

  test("uses the close rule when the user agent force-closes the hashed dialog", () => {
    // #given Chrome has force-closed a dialog while its popup hash remains
    const input: PopupInput = { kind: "dialog-closed", dialogId: "book-1" };

    // #when the dialog close event is decided
    const result = decide(input, { hash: "#book-1", hashDialogId: "book-1" });

    // #then it follows the in-folder close path and blocks another Back until hash change
    expect(result).toEqual({ actions: [{ kind: "close-through-back" }], closePending: true });
  });

  test("clears a deep-link hash when the user agent force-closes its dialog", () => {
    // #given the user agent closed a directly loaded dialog while its popup hash remains
    const input: PopupInput = { kind: "dialog-closed", dialogId: "book-3" };

    // #when the dialog close event is decided
    const result = decide(input, { deepLinkEntry: true, hash: "#book-3", hashDialogId: "book-3" });

    // #then it follows the deep-link close path instead of going Back out of the folder
    expect(result).toEqual({ actions: [{ kind: "close-through-replace" }], closePending: false });
  });

  test("ignores a close event after its dialog hash has already moved", () => {
    // #given the adapter closed a dialog after navigation cleared its hash
    const input: PopupInput = { kind: "dialog-closed", dialogId: "book-1" };

    // #when that dialog emits its close event
    const result = decide(input);

    // #then it does not start another close operation
    expect(result).toEqual({ actions: [], closePending: false });
  });

  test("switches dialogs without restoring focus to the prior card", () => {
    // #given a Forward navigation or card hash selects another existing popup
    const input: PopupInput = { kind: "hash-changed" };

    // #when the second popup hash is decided while the first dialog is open
    const result = decide(input, { hash: "#book-2", hashDialogId: "book-2", openDialogId: "book-1" });

    // #then it closes the prior dialog and opens the target without a focus restore
    expect(result).toEqual({
      actions: [
        { kind: "close-dialog", dialogId: "book-1" },
        { kind: "show-dialog", dialogId: "book-2" },
      ],
      closePending: false,
    });
  });

  test("ignores a close request when no popup hash is active", () => {
    // #given no popup is named by the current URL hash
    const input: PopupInput = { kind: "close-requested" };

    // #when a close request arrives
    const result = decide(input);

    // #then it takes no action
    expect(result).toEqual({ actions: [], closePending: false });
  });

  test("does not stamp history during render without a popup hash", () => {
    // #given the viewer renders without a popup fragment
    const input: PopupInput = { kind: "render" };

    // #when the render is decided
    const result = decide(input);

    // #then it neither stamps history nor changes dialog state
    expect(result).toEqual({ actions: [], closePending: false });
  });

  test("stamps a popup entry again when a render keeps its dialog open", () => {
    // #given a re-render keeps an already stamped deep-link dialog open
    const input: PopupInput = { kind: "render" };

    // #when the viewer wiring runs again
    const result = decide(input, {
      deepLinkEntry: true,
      hash: "#book-3",
      hashDialogId: "book-3",
      openDialogId: "book-3",
    });

    // #then it stamps the current popup history entry without reopening the dialog
    expect(result).toEqual({ actions: [{ kind: "stamp-deep-link-entry" }], closePending: false });
  });

  test("closes and restores focus when a popup hash names no dialog", () => {
    // #given an open popup while the hash names a deleted or unavailable dialog
    const input: PopupInput = { kind: "hash-changed" };

    // #when the missing target hash is decided
    const result = decide(input, { hash: "#book-99", openDialogId: "book-1" });

    // #then it closes the open dialog and returns focus to its original card
    expect(result).toEqual({
      actions: [
        { kind: "close-dialog", dialogId: "book-1" },
        { kind: "restore-focus", dialogId: "book-1" },
      ],
      closePending: false,
    });
  });
});

describe("isPopupHash", () => {
  test("recognizes only hashes that start with the popup prefix", () => {
    // #given popup and non-popup hash values from the browser location
    const hashes = ["#book-1", "", "#", "#other", "#books"];

    // #when each hash is classified
    const result = hashes.map((hash) => isPopupHash(hash));

    // #then only the defined popup-prefix hash is accepted
    expect(result).toEqual([true, false, false, false, false]);
  });
});
