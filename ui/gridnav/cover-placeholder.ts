/**
 * Copy each cover's `data-lqip` code into `--lqip` for ui/styles/lqip.css, and each card's
 * `data-ratio` into `--cover-ratio`. The shell CSP (`style-src 'self'`) blocks the same
 * values as style attributes; CSSOM writes pass.
 */
export function applyCoverStyles(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("[data-lqip]").forEach((cover) => {
    cover.style.setProperty("--lqip", cover.dataset.lqip ?? "");
  });
  root.querySelectorAll<HTMLElement>("[data-ratio]").forEach((card) => {
    card.style.setProperty("--cover-ratio", card.dataset.ratio ?? "");
  });
}

/** Remove a cover image that failed to load, so its placeholder shows instead of a broken-image icon. Attach once. */
export function dropBrokenCovers(): void {
  // `error` does not bubble, so one document listener has to capture it.
  document.addEventListener(
    "error",
    (e) => {
      if (e.target instanceof HTMLImageElement && e.target.parentElement?.hasAttribute("data-lqip")) {
        e.target.remove();
      }
    },
    true,
  );
}
