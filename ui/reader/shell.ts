import { BOOK_EXTENSIONS, VIEWABLE_FORMATS } from "../../src/types.ts";
import { parseFragment } from "./fragment.ts";

type TocItem = { label?: string; href?: string; subitems?: TocItem[] | null };

type RelocateDetail = {
  fraction?: number;
  location?: { current?: number; total?: number };
};

interface FoliateView extends HTMLElement {
  open(book: string | File | object): Promise<void>;
  prev(): unknown;
  next(): unknown;
  goTo(target: string): Promise<unknown>;
  book: {
    metadata?: { title?: unknown };
    toc?: TocItem[] | null;
  };
  renderer: HTMLElement & { next(): Promise<void> };
}

/** Byte-range-backed file foliate's makePDF consumes — streams instead of downloading whole. */
interface RangeFile {
  size: number;
  slice(begin: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** A validated book to render: a same-origin URL (production) or a File (playground smoke). */
export interface ShellSource {
  source: string | File;
  filename: string;
  folderPath: string;
  downloadHref?: string;
  /** Fragment extension (production only); enables byte-range streaming for `pdf`. */
  ext?: string;
}

/**
 * Probe the URL for range support and, if present, return a file-like that fetches each
 * slice over HTTP `Range` (R10/206). Returns null when the server answers a plain 200 —
 * the caller then falls back to foliate's whole-file fetch.
 */
async function makeRangeFile(url: string): Promise<RangeFile | null> {
  let total: number;
  try {
    const probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
    if (probe.status !== 206) return null;
    total = Number(probe.headers.get("content-range")?.split("/")[1]);
  } catch {
    return null;
  }
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    size: total,
    slice(begin, end) {
      return {
        async arrayBuffer() {
          // HTTP Range is inclusive; foliate/pdf.js pass a half-open [begin, end).
          const res = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` } });
          return res.arrayBuffer();
        },
      };
    },
  };
}

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`reader: missing #${id}`);
  return found as T;
};

function showError(message: string, backHref: string): void {
  el<HTMLDivElement>("reader").hidden = true;
  el<HTMLParagraphElement>("reader-error-message").textContent = message;
  el<HTMLAnchorElement>("reader-error-return").href = backHref;
  el<HTMLDivElement>("reader-error").hidden = false;
}

/** foliate metadata titles are either strings or {lang: title} maps. */
function bookTitle(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw) return raw;
  if (raw && typeof raw === "object") {
    const first = Object.values(raw)[0];
    if (typeof first === "string" && first) return first;
  }
  return undefined;
}

/** Book-controlled labels go through textContent only — never markup. */
function renderToc(items: TocItem[], view: FoliateView, onNavigate: () => void): HTMLOListElement {
  const list = document.createElement("ol");
  for (const item of items) {
    const li = document.createElement("li");
    if (item.href !== undefined) {
      const link = document.createElement("a");
      link.href = "#";
      link.textContent = item.label?.trim() || "Untitled";
      const href = item.href;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        void view.goTo(href).catch(() => {});
        onNavigate();
      });
      li.append(link);
    } else {
      const span = document.createElement("span");
      span.textContent = item.label?.trim() || "Untitled";
      li.append(span);
    }
    if (item.subitems?.length) li.append(renderToc(item.subitems, view, onNavigate));
    list.append(li);
  }
  return list;
}

function onRelocate(detail: RelocateDetail, positionEl: HTMLElement): void {
  const parts: string[] = [];
  if (typeof detail.fraction === "number") parts.push(`${Math.round(detail.fraction * 100)}%`);
  const { current, total } = detail.location ?? {};
  if (typeof current === "number" && typeof total === "number") parts.push(`${current + 1} / ${total}`);
  positionEl.textContent = parts.join(" · ");
}

interface KeyActions {
  onPrev: () => void;
  onNext: () => void;
  onReturn: () => void;
}

function bindKeys(doc: Document | Window, actions: KeyActions): void {
  doc.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "ArrowLeft") actions.onPrev();
    else if (key === "ArrowRight") actions.onNext();
    else if (key === "Escape") actions.onReturn();
  });
}

/**
 * The shell boundary layer (Shell / foliate boundary): everything inside the book is
 * foliate's; this wires chrome (arrows/Esc, TOC, position), the download/return actions,
 * focus, and the failure states. Shared verbatim by production and the playground smoke.
 */
export async function openInShell({ source, filename, folderPath, downloadHref, ext }: ShellSource): Promise<void> {
  const reader = el<HTMLDivElement>("reader");
  const returnLink = el<HTMLAnchorElement>("reader-return");
  const downloadLink = el<HTMLAnchorElement>("reader-download");
  const titleEl = el<HTMLSpanElement>("reader-title");
  const tocToggle = el<HTMLButtonElement>("reader-toc-toggle");
  const tocNav = el<HTMLElement>("reader-toc");
  const viewSlot = el<HTMLElement>("reader-view");
  const positionEl = el<HTMLSpanElement>("reader-position");
  const prevBtn = el<HTMLButtonElement>("reader-prev");
  const nextBtn = el<HTMLButtonElement>("reader-next");

  returnLink.href = folderPath;
  el<HTMLAnchorElement>("reader-error-return").href = folderPath;
  if (downloadHref) {
    downloadLink.href = downloadHref;
    downloadLink.hidden = false;
  }
  titleEl.textContent = filename;
  document.title = filename;
  reader.hidden = false;

  const base = document.querySelector('meta[name="foliate-base"]')?.getAttribute("content");
  if (!base) {
    showError("Couldn't load this book.", folderPath);
    return;
  }

  let view: FoliateView;
  try {
    await import(/* @vite-ignore */ `${base}/view.js`);
    view = document.createElement("foliate-view") as FoliateView;
    viewSlot.append(view);
    await view.open(await resolveBook(source, ext, base));
  } catch (error) {
    console.error("reader: failed to open book", error);
    showError("Couldn't load this book.", folderPath);
    return;
  }

  const title = bookTitle(view.book.metadata?.title) ?? filename;
  document.title = title;
  titleEl.textContent = title;

  // Serialize page turns: rapid key-repeat / clicks otherwise overlap foliate's async
  // prev()/next() and leave the position indicator and focus out of order.
  let navBusy = false;
  const navigate = (move: () => unknown): void => {
    if (navBusy) return;
    navBusy = true;
    Promise.resolve(move())
      .catch(() => {})
      .finally(() => {
        navBusy = false;
      });
  };
  const actions: KeyActions = {
    onPrev: () => navigate(() => view.prev()),
    onNext: () => navigate(() => view.next()),
    onReturn: () => window.location.assign(folderPath),
  };

  view.addEventListener("relocate", (event) => onRelocate((event as CustomEvent<RelocateDetail>).detail, positionEl));
  view.addEventListener("load", (event) => {
    const { doc } = (event as CustomEvent<{ doc: Document }>).detail;
    bindKeys(doc, actions);
  });
  bindKeys(window, actions);

  prevBtn.hidden = false;
  nextBtn.hidden = false;
  prevBtn.addEventListener("click", actions.onPrev);
  nextBtn.addEventListener("click", actions.onNext);

  const closeToc = (): void => {
    tocNav.hidden = true;
    tocToggle.setAttribute("aria-expanded", "false");
  };
  const toc = view.book.toc;
  if (toc?.length) {
    tocNav.append(renderToc(toc, view, closeToc));
    tocToggle.hidden = false;
    tocToggle.addEventListener("click", () => {
      tocNav.hidden = !tocNav.hidden;
      tocToggle.setAttribute("aria-expanded", String(!tocNav.hidden));
    });
  }

  try {
    await view.renderer.next();
  } catch (error) {
    // First-page render can reject after open() resolved (e.g. a corrupt page stream);
    // fall back to the error state instead of stranding a half-open reader.
    console.error("reader: first render failed", error);
    showError("Couldn't load this book.", folderPath);
    return;
  }

  // Focus lands on the book view, not the address bar (shell boundary contract).
  viewSlot.tabIndex = -1;
  viewSlot.focus();
}

/**
 * A PDF opened from a same-origin URL streams over byte ranges (large scanned PDFs
 * otherwise block first paint and hold the whole file in memory); everything else uses
 * foliate's own loader. Playground File sources and 200-only servers fall back to it too.
 */
async function resolveBook(source: string | File, ext: string | undefined, base: string): Promise<string | File | object> {
  if (ext !== "pdf" || typeof source !== "string") return source;
  const rangeFile = await makeRangeFile(source);
  if (!rangeFile) return source;
  const { makePDF } = (await import(/* @vite-ignore */ `${base}/pdf.js`)) as { makePDF: (file: RangeFile) => Promise<object> };
  return makePDF(rangeFile);
}

/** Production entry: validate the URL fragment (R15), then hand a same-origin URL to the shell. */
export function startReader(): void {
  const result = parseFragment(window.location.hash, VIEWABLE_FORMATS, BOOK_EXTENSIONS);
  if (result.kind === "invalid") {
    showError("This reader link is invalid.", "/");
    return;
  }
  if (result.kind === "unsupported") {
    showError("This format isn't supported in the viewer.", result.folderPath);
    return;
  }

  // R15 belt-and-braces against the live origin before any network request.
  const target = new URL(result.fetchPath, window.location.origin);
  if (target.origin !== window.location.origin) {
    showError("This reader link is invalid.", "/");
    return;
  }

  // read.html is one document per book; a same-document fragment change (URL-bar edit,
  // a link into an already-open reader tab) would otherwise keep the old book silently.
  window.addEventListener("hashchange", () => location.reload());

  void openInShell({
    source: result.fetchPath,
    filename: result.filename,
    folderPath: result.folderPath,
    downloadHref: result.fetchPath,
    ext: result.ext,
  }).catch((error: unknown) => {
    console.error("reader: unexpected failure", error);
    showError("Couldn't load this book.", result.folderPath);
  });
}
