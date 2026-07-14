/// <reference types="vite/client" />
import "../styles/reset.css";
import "../styles/index.css";
import "../styles/header.css";
import "../styles/variations.css";
import { parseFeed } from "../../src/render/parse-feed.ts";
import { renderHtml } from "../../src/render/feed-html.ts";

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
  if (xml) preview.innerHTML = renderHtml(parseFeed(xml));
}

select.addEventListener("change", render);
render();

if (import.meta.hot) import.meta.hot.accept();
