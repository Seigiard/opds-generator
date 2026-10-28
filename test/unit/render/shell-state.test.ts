import { describe, expect, test } from "bun:test";
import { breadcrumbsFor } from "../../../src/render/breadcrumbs.ts";
import type { Crumb } from "../../../src/render/breadcrumbs.ts";
import { renderHtml } from "../../../src/render/feed-html.ts";
import type { FeedModel } from "../../../src/render/feed-model.ts";
import { parseFeed } from "../../../src/render/parse-feed.ts";
import { allElements, byClass, parseHtml } from "../../helpers/html-query.ts";

const ROOT_FEED = await Bun.file(new URL("../../fixtures/feeds/root.xml", import.meta.url)).text();

const SHELL_STATE_MODULE = "../../../src/render/shell-state.ts";

type ShellState =
  | { kind: "skeleton" }
  | { kind: "starting"; retryInSeconds: number }
  | { kind: "not-found" }
  | { kind: "http-error"; status: number }
  | { kind: "error"; message?: string }
  | { kind: "ready"; model: FeedModel };

type ShellStateModule = {
  readonly renderShellState: (state: ShellState, crumbs: Crumb[]) => string;
};

function shellRenderer(): Promise<ShellStateModule> {
  return import(SHELL_STATE_MODULE);
}

describe("renderShellState", () => {
  test("renders the starting state without a Home link", async () => {
    // #given the specified retry countdown
    const { renderShellState } = await shellRenderer();

    // #when its state is rendered
    const roots = parseHtml(renderShellState({ kind: "starting", retryInSeconds: 5 }, []));

    // #then the status text and class are preserved without navigation
    expect({
      homes: allElements(roots).filter((element) => element.tag === "a"),
      state: byClass(roots, "app-state app-state--starting"),
    }).toEqual({
      homes: [],
      state: [
        {
          attrs: { class: "app-state app-state--starting" },
          children: [],
          tag: "section",
          text: "Server is starting, retrying in 5 s…",
        },
      ],
    });
  });

  test("renders the not-found state with a Home link", async () => {
    // #given a missing folder state
    const { renderShellState } = await shellRenderer();

    // #when its state is rendered
    const roots = parseHtml(renderShellState({ kind: "not-found" }, []));

    // #then the literal message and root navigation follow the state section
    expect({
      homes: allElements(roots)
        .filter((element) => element.tag === "a")
        .map((element) => ({ href: element.attrs.href, text: element.text })),
      state: byClass(roots, "app-state app-state--not-found")[0]?.text,
    }).toEqual({
      homes: [{ href: "/", text: "Home" }],
      state: "Folder not foundHome",
    });
  });

  test("renders an HTTP error status with a Home link", async () => {
    // #given an unsuccessful status returned by the feed server
    const { renderShellState } = await shellRenderer();

    // #when its state is rendered
    const roots = parseHtml(renderShellState({ kind: "http-error", status: 500 }, []));

    // #then the status remains visible with root navigation
    expect({
      homes: allElements(roots)
        .filter((element) => element.tag === "a")
        .map((element) => element.attrs.href),
      state: byClass(roots, "app-state app-state--error")[0]?.text,
    }).toEqual({
      homes: ["/"],
      state: "Could not load this folder (status 500)Home",
    });
  });

  test("renders a hostile error message as text instead of markup", async () => {
    // #given an error message containing an element-like value
    const { renderShellState } = await shellRenderer();

    // #when its state is rendered
    const roots = parseHtml(renderShellState({ kind: "error", message: "Network <offline> & unavailable" }, []));

    // #then the message is text in the error state and produces no injected element
    expect({
      elements: allElements(roots).map((element) => element.tag),
      state: byClass(roots, "app-state app-state--error")[0]?.text,
    }).toEqual({
      elements: ["section", "a"],
      state: "Network <offline> & unavailableHome",
    });
  });

  test("uses the generic error copy when an error has no message", async () => {
    // #given a thrown value that was not an Error
    const { renderShellState } = await shellRenderer();

    // #when its state is rendered
    const roots = parseHtml(renderShellState({ kind: "error" }, []));

    // #then the generic error copy remains visible with Home navigation
    expect({
      home: allElements(roots).find((element) => element.tag === "a")?.attrs.href,
      state: byClass(roots, "app-state app-state--error")[0]?.text,
    }).toEqual({
      home: "/",
      state: "Could not load this folderHome",
    });
  });

  test("renders the skeleton header breadcrumbs and six hidden cards", async () => {
    // #given a nested folder breadcrumb path
    const { renderShellState } = await shellRenderer();
    const crumbs = breadcrumbsFor("/%D0%9A%D0%BD%D0%B8%D0%B3%D0%B8/%D0%9D%D0%B0%D1%83%D0%BA%D0%B0/");

    // #when the loading skeleton is rendered
    const roots = parseHtml(renderShellState({ kind: "skeleton" }, crumbs));

    // #then it keeps the supplied breadcrumbs and the six-card loading grid
    expect({
      breadcrumbs: byClass(roots, "header__breadcrumb")[0]?.text,
      cards: byClass(roots, "card card--skeleton").map((card) => card.attrs["aria-hidden"]),
      title: byClass(roots, "header__title skeleton__title")[0]?.text,
    }).toEqual({
      breadcrumbs: "/Книги/",
      cards: ["true", "true", "true", "true", "true", "true"],
      title: "",
    });
  });

  test("delegates the ready state to the existing folder renderer", async () => {
    // #given a parsed folder and its breadcrumb context
    const { renderShellState } = await shellRenderer();
    const model = parseFeed(ROOT_FEED);
    const crumbs = breadcrumbsFor("/fiction/");

    // #when the ready state is rendered
    const html = renderShellState({ kind: "ready", model }, crumbs);

    // #then the existing folder fragment is returned byte-for-byte
    expect(html).toBe(renderHtml(model, crumbs));
  });
});
