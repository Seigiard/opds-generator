import { describe, test, expect } from "bun:test";
import { join } from "node:path";

const FOLIATE_DIR = join(import.meta.dir, "../../../ui/vendor/foliate-js");

// R9: the reader CSP is the load-bearing script control — upstream foliate combines
// allow-same-origin with allow-scripts on its book iframes (WebKit bug 218086), so the
// sandbox provides no isolation on its own. This pin exists to force a security
// re-review whenever a submodule bump changes the iframe posture or the pdf.js eval
// setting. See ui/vendor/VENDOR.md.
describe("vendored foliate-js security posture", () => {
  test.each(["paginator.js", "fixed-layout.js"])("%s iframe sandbox attribute is exactly the reviewed token set", async (file) => {
    const source = await Bun.file(join(FOLIATE_DIR, file)).text();
    const sandboxes = [...source.matchAll(/setAttribute\('sandbox', '([^']*)'\)/g)].map((m) => m[1]);
    expect(sandboxes).toEqual(["allow-same-origin allow-scripts"]);
  });

  test("pdf adapter keeps isEvalSupported: false (KTD-6: never 'unsafe-eval')", async () => {
    const source = await Bun.file(join(FOLIATE_DIR, "pdf.js")).text();
    expect(source).toContain("isEvalSupported: false");
  });

  test("pdf adapter loads its worker as a real file, not a blob: worker (KTD-6 worker-src 'self')", async () => {
    const source = await Bun.file(join(FOLIATE_DIR, "pdf.js")).text();
    expect(source).toContain("GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.mjs')");
  });
});
