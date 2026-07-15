/// <reference types="vite/client" />
import "../reader/reader.css";
import { openInShell } from "../reader/shell.ts";

// Fixtures are opened as File objects so the smoke page needs no nginx/static routing;
// the shell chrome, foliate load path, and CSP-relevant rendering are identical to prod.
const fixtures = import.meta.glob("./fixtures/*.epub", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

const select = document.getElementById("fixture") as HTMLSelectElement;
const paths = Object.keys(fixtures).sort();

for (const path of paths) {
  const option = document.createElement("option");
  option.value = path;
  option.textContent = path.split("/").pop() ?? path;
  select.append(option);
}

// ?fixture=<name> deep-links a specific book (used by the SMOKE.md checklist).
const wanted = new URLSearchParams(location.search).get("fixture");
const initial = paths.find((p) => p.endsWith(`/${wanted}`)) ?? paths[0];
if (initial) select.value = initial;

async function open(path: string): Promise<void> {
  const filename = path.split("/").pop() ?? "book.epub";
  const response = await fetch(fixtures[path]!);
  const file = new File([await response.blob()], filename, { type: "application/epub+zip" });
  await openInShell({ source: file, filename, folderPath: "/" });
}

select.addEventListener("change", () => {
  const name = select.value.split("/").pop() ?? "";
  location.search = `?fixture=${encodeURIComponent(name)}`;
});
if (select.value) void open(select.value);
