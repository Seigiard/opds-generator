/// <reference types="vite/client" />
import "../styles/reset.css";
import "../styles/index.css";
import "../styles/header.css";
import "../styles/variations.css";
import { parseFeed } from "../../src/render/parse-feed.ts";
import { renderHtml } from "../../src/render/feed-html.ts";
import { initGlobal, wire } from "../gridnav/viewer.ts";

const cassettes = import.meta.glob("../../test/fixtures/feeds/*.xml", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const select = document.getElementById("cassette") as HTMLSelectElement;
const preview = document.getElementById("preview") as HTMLElement;

for (const path of Object.keys(cassettes).sort()) {
  const option = document.createElement("option");
  option.value = path;
  option.textContent = path.split("/").pop() ?? path;
  select.append(option);
}

function render(): void {
  const xml = cassettes[select.value];
  if (!xml) return;
  // Drop a stale #book-N so switching cassettes does not reopen a popup in the new feed.
  // replaceState fires no hashchange, so the global sync stays quiet until wire() runs.
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  preview.innerHTML = renderHtml(parseFeed(xml));
  wire(preview);
}

initGlobal();
select.addEventListener("change", render);
render();

if (import.meta.hot) import.meta.hot.accept();
