import type { Crumb } from "./breadcrumbs.ts";
import { renderHtml } from "./feed-html.ts";
import type { FeedModel } from "./feed-model.ts";
import { frag, interleave } from "./frag.ts";
import { renderHeader } from "./header.ts";

const SKELETON_CARD_COUNT = 6;

export type ShellState =
  | { kind: "skeleton" }
  | { kind: "starting"; retryInSeconds: number }
  | { kind: "not-found" }
  | { kind: "http-error"; status: number }
  | { kind: "error"; message?: string }
  | { kind: "ready"; model: FeedModel };

/** Body HTML for the browser shell's current state. */
export function renderShellState(state: ShellState, crumbs: Crumb[]): string {
  switch (state.kind) {
    case "skeleton":
      return renderSkeleton(crumbs);
    case "starting":
      return renderStatus("app-state--starting", `Server is starting, retrying in ${state.retryInSeconds} s…`);
    case "not-found":
      return renderStatus("app-state--not-found", "Folder not found", true);
    case "http-error":
      return renderStatus("app-state--error", `Could not load this folder (status ${state.status})`, true);
    case "error":
      return renderStatus("app-state--error", state.message ?? "Could not load this folder", true);
    case "ready":
      return renderHtml(state.model, crumbs);
  }
}

function renderStatus(className: string, message: string, withHome = false): string {
  const home = withHome ? frag`<a href="/">Home</a>` : "";

  return String(frag`<section class="app-state ${className}">${message}${home}</section>`);
}

function renderSkeleton(crumbs: Crumb[]): string {
  const cards = Array.from(
    { length: SKELETON_CARD_COUNT },
    () => frag`
      <div>
        <article class="card card--skeleton" aria-hidden="true">
          <div class="book"><div class="book__cover"></div></div>
          <div class="card__info"><span class="skeleton__label"></span></div>
        </article>
      </div>`,
  );

  const cardsWithSeparators = interleave(cards, "\n");

  return String(frag`
     ${renderHeader({ title: "" }, crumbs, true)}
     <main class="books-grid">${cardsWithSeparators}
     </main>`);
}
