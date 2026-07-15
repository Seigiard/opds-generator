import { initGlobal, wire } from "./viewer.ts";

function boot(): void {
  initGlobal();
  wire(document);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
