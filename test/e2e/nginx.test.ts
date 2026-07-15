import { describe, test, expect, beforeAll } from "bun:test";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8080";

// Wait for a URL to return 200
async function waitFor(path: string, maxWaitMs = 45000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const response = await fetch(`${BASE_URL}${path}`);
      if (response.status === 200) return;
    } catch {
      // Connection refused
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Not ready: ${path}`);
}

async function waitForServer(): Promise<void> {
  await waitFor("/feed.xml");
  // index.html is written by the cascade after feed.xml — wait for the browser view too
  await waitFor("/index.html");
  await waitFor("/test/");
}

// Decode the handful of HTML entities that appear in escaped attribute values, as a
// browser does before it uses the URL (paths are otherwise percent-encoded).
function htmlDecode(value: string): string {
  return value.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

// Check if /resync is enabled
async function isResyncEnabled(): Promise<boolean> {
  const response = await fetch(`${BASE_URL}/resync`);
  return response.status === 401;
}

describe("nginx integration", () => {
  beforeAll(async () => {
    await waitForServer();
  });

  describe("redirects", () => {
    test("GET / redirects to /index.html (browsers get HTML)", async () => {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/index.html");
    });

    test("GET /opds redirects to /feed.xml (readers get feeds)", async () => {
      const response = await fetch(`${BASE_URL}/opds`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/feed.xml");
    });
  });

  describe("browser HTML routing", () => {
    test("GET /index.html returns 200 text/html", async () => {
      const response = await fetch(`${BASE_URL}/index.html`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") || "").toContain("text/html");
      const body = await response.text();
      expect(body).toContain("<!DOCTYPE html>");
      expect(body).toContain('class="books-grid"');
    });

    test("GET /test/ returns 200 text/html (folder URL → index.html)", async () => {
      const response = await fetch(`${BASE_URL}/test/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") || "").toContain("text/html");
    });

    test("GET /test/feed.xml still returns 200 XML (readers)", async () => {
      const response = await fetch(`${BASE_URL}/test/feed.xml`);
      expect(response.status).toBe(200);
      expect((response.headers.get("content-type") || "").toLowerCase()).toContain("xml");
    });

    test("AE2: book download returns 200 with Content-Disposition", async () => {
      // discover an acquisition href from a real feed
      const feed = await (await fetch(`${BASE_URL}/test/feed.xml`)).text();
      const match = feed.match(/acquisition[^>]*href="([^"]+)"/);
      expect(match).not.toBeNull();
      const downloadUrl = match![1]!;
      const response = await fetch(`${BASE_URL}${downloadUrl}`, { redirect: "manual" });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition") || "").toContain("attachment");
    });
  });

  describe("byte-range delivery (reader streaming contract)", () => {
    async function discoverBookUrl(): Promise<string> {
      const feed = await (await fetch(`${BASE_URL}/test/feed.xml`)).text();
      const match = feed.match(/acquisition[^>]*href="([^"]+)"/);
      expect(match).not.toBeNull();
      return match![1]!;
    }

    test("AE2: Range bytes=0-1023 on a book file returns 206 with Content-Range and 1024 bytes", async () => {
      // #given
      const bookUrl = await discoverBookUrl();

      // #when
      const response = await fetch(`${BASE_URL}${bookUrl}`, {
        headers: { Range: "bytes=0-1023" },
      });

      // #then
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range") || "").toMatch(/^bytes 0-1023\/\d+$/);
      expect((await response.arrayBuffer()).byteLength).toBe(1024);
    });

    test("open-ended range (bytes=0-) returns 206 with the full remainder", async () => {
      // #given
      const bookUrl = await discoverBookUrl();
      const full = await fetch(`${BASE_URL}${bookUrl}`);
      const fullLength = (await full.arrayBuffer()).byteLength;

      // #when
      const response = await fetch(`${BASE_URL}${bookUrl}`, {
        headers: { Range: "bytes=0-" },
      });

      // #then — nginx answers open-ended ranges with 206 (recorded per plan U1;
      // pdf.js accepts either 206 or a plain 200)
      expect(response.status).toBe(206);
      expect((await response.arrayBuffer()).byteLength).toBe(fullLength);
    });

    test("AE4 guard: plain GET on the same book still forces attachment", async () => {
      // #given
      const bookUrl = await discoverBookUrl();

      // #when
      const response = await fetch(`${BASE_URL}${bookUrl}`, { redirect: "manual" });

      // #then
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition") || "").toContain("attachment");
    });
  });

  describe("feed.xml", () => {
    test("GET /feed.xml returns 200 with XML content", async () => {
      const response = await fetch(`${BASE_URL}/feed.xml`);
      expect(response.status).toBe(200);
      const contentType = response.headers.get("content-type");
      expect(contentType).toContain("xml");
    });

    test("response includes charset utf-8", async () => {
      const response = await fetch(`${BASE_URL}/feed.xml`);
      expect(response.status).toBe(200);
      const contentType = response.headers.get("content-type") || "";
      expect(contentType.toLowerCase()).toContain("utf-8");
    });
  });

  describe("static files", () => {
    test("GET /static/style.css returns 200 and revalidates (no stale immutable cache)", async () => {
      const response = await fetch(`${BASE_URL}/static/style.css`);
      expect(response.status).toBe(200);
      // Unversioned asset URLs must revalidate: "immutable" left browsers on
      // day-old CSS/JS mismatched with freshly regenerated index.html.
      expect(response.headers.get("cache-control") || "").toContain("no-cache");
      expect(response.headers.get("etag")).toBeTruthy();
    });

    test("GET /static/favicon/*.png served from /app/static, not captured by the /data image regex", async () => {
      const response = await fetch(`${BASE_URL}/static/favicon/favicon-96x96.png`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") || "").toContain("image/png");
    });

    test("GET /static/layout.xsl returns 404 (XSLT removed)", async () => {
      const response = await fetch(`${BASE_URL}/static/layout.xsl`);
      expect(response.status).toBe(404);
    });
  });

  describe("reader surface (CSP + caching)", () => {
    // KTD-6 pinned verbatim: a drive-by widening of any directive fails this test.
    const READER_CSP =
      "default-src 'none'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; " +
      "frame-ancestors 'self'; connect-src 'self'; worker-src 'self'; frame-src blob:; " +
      "img-src blob: data:; style-src 'unsafe-inline' blob: data:";

    async function foliateBase(): Promise<string> {
      const html = await (await fetch(`${BASE_URL}/static/read.html`)).text();
      const match = html.match(/name="foliate-base" content="([^"]+)"/);
      expect(match).not.toBeNull();
      return match![1]!;
    }

    test("R8: /static/read.html carries the exact KTD-6 policy and stays no-cache", async () => {
      const response = await fetch(`${BASE_URL}/static/read.html`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBe(READER_CSP);
      // add_header replaces inherited headers — this guards the no-cache re-declaration
      expect(response.headers.get("cache-control") || "").toContain("no-cache");
      expect(response.headers.get("content-type") || "").toContain("text/html");
    });

    test("R8: catalog and feed routes carry no CSP", async () => {
      for (const path of ["/index.html", "/feed.xml", "/test/"]) {
        const response = await fetch(`${BASE_URL}${path}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-security-policy")).toBeNull();
      }
    });

    test("R13: hashed foliate runtime is immutable-cacheable with module-safe MIME", async () => {
      const base = await foliateBase();
      for (const file of ["/view.js", "/vendor/pdfjs/pdf.mjs", "/vendor/pdfjs/pdf.worker.mjs"]) {
        const response = await fetch(`${BASE_URL}${base}${file}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        // strict module MIME: octet-stream would make the browser reject the import
        expect(response.headers.get("content-type") || "").toContain("javascript");
      }
    });

    test("unversioned static assets stay no-cache (main.js, reader.js)", async () => {
      for (const file of ["/static/main.js", "/static/reader.js"]) {
        const response = await fetch(`${BASE_URL}${file}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control") || "").toContain("no-cache");
        expect(response.headers.get("content-security-policy")).toBeNull();
      }
    });
  });

  describe("directory index", () => {
    test("GET /nonexistent.file returns 404 (non-directory miss)", async () => {
      const response = await fetch(`${BASE_URL}/nonexistent.file`, { redirect: "manual" });
      expect(response.status).toBe(404);
    });

    test("GET /nonexistent-folder/ returns 404 once the catalog is built", async () => {
      // Steady state (root feed exists): a folder that will never exist is a real
      // 404, not a retry-forever 503. Mid-cascade states (dir exists, index.html
      // pending) and cold start (no root feed yet) still answer 503.
      const response = await fetch(`${BASE_URL}/nonexistent-folder/`, { redirect: "manual" });
      expect(response.status).toBe(404);
    });

    test("GET /opds/ (trailing slash) redirects to /feed.xml like /opds", async () => {
      const response = await fetch(`${BASE_URL}/opds/`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/feed.xml");
    });
  });

  describe("internal endpoints are blocked", () => {
    test("POST /events returns 404", async () => {
      const response = await fetch(`${BASE_URL}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true }),
      });
      expect(response.status).toBe(404);
    });
  });

  describe("initial sync", () => {
    test("creates root feed.xml with valid OPDS structure", async () => {
      const response = await fetch(`${BASE_URL}/feed.xml`);
      expect(response.status).toBe(200);

      const feedContent = await response.text();
      expect(feedContent).toContain('<?xml version="1.0"');
      expect(feedContent).toContain("<feed");
      expect(feedContent).toContain('xmlns="http://www.w3.org/2005/Atom"');
      expect(feedContent).toContain("kind=navigation");
      expect(feedContent).toContain('rel="self"');
      expect(feedContent).toContain("</feed>");
    });
  });

  // R15 smoke: crawl the whole feed graph, every folder must render HTML and links must resolve
  describe("R15 smoke", () => {
    test("every folder renders index.html and internal links resolve", async () => {
      const visited = new Set<string>();
      const queue: string[] = ["/feed.xml"];
      const assets = new Set<string>();

      while (queue.length > 0) {
        const feedPath = queue.shift()!;
        if (visited.has(feedPath)) continue;
        visited.add(feedPath);

        const feedRes = await fetch(`${BASE_URL}${feedPath}`);
        expect(feedRes.status).toBe(200);
        const xml = await feedRes.text();

        // the folder that owns this feed must serve an HTML index
        const dir = feedPath.replace(/feed\.xml$/, "");
        const htmlRes = await fetch(`${BASE_URL}${dir}`);
        expect(htmlRes.status).toBe(200);
        expect((htmlRes.headers.get("content-type") || "").toLowerCase()).toContain("text/html");

        // the links a browser actually clicks (folder cards, home) must resolve to HTML, not XML
        const html = await htmlRes.text();
        const cardHrefs = [...html.matchAll(/class="card__title"><a href="([^"]+)"/g)]
          .map((m) => m[1]!)
          .filter((href) => !href.startsWith("#"));
        for (const href of cardHrefs) {
          expect(href).not.toMatch(/feed\.xml$/);
          const cardRes = await fetch(`${BASE_URL}${href}`);
          expect(cardRes.status).toBe(200);
          expect((cardRes.headers.get("content-type") || "").toLowerCase()).toContain("text/html");
        }

        // Every generated View link must point at the shared reader page and carry a
        // book path that actually resolves — a broken View button would 404 the book.
        // The href is an HTML attribute, so entity-decode it the way a browser would
        // before navigating (apostrophes render as &#39; in the markup).
        for (const m of html.matchAll(/href="([^"]+)" class="popup__view-btn"/g)) {
          const viewHref = htmlDecode(m[1]!);
          expect(viewHref.startsWith("/static/read.html#/")).toBe(true);
          const bookPath = viewHref.slice("/static/read.html#".length);
          assets.add(bookPath);
        }

        for (const m of xml.matchAll(/rel="subsection"\s+href="([^"]+)"/g)) queue.push(m[1]!);
        const image = xml.match(/opds-spec\.org\/image"\s+href="([^"]+)"/);
        if (image) assets.add(image[1]!);
        const acquisition = xml.match(/acquisition[^>]*href="([^"]+)"/);
        if (acquisition) assets.add(acquisition[1]!);
      }

      // a real library has several nested folders
      expect(visited.size).toBeGreaterThan(3);

      // every sampled cover and download link resolves
      for (const asset of assets) {
        const res = await fetch(`${BASE_URL}${asset}`);
        expect(res.status).toBe(200);
      }
    });
  });

  // /resync tests last - they trigger async operations that affect other tests
  describe("/resync endpoint", () => {
    test("GET /resync without auth returns 401 (when enabled)", async () => {
      const enabled = await isResyncEnabled();
      if (!enabled) {
        console.log("Skipping: /resync not configured");
        return;
      }
      const response = await fetch(`${BASE_URL}/resync`);
      expect(response.status).toBe(401);
    });

    test("GET /resync with wrong auth returns 401 (when enabled)", async () => {
      const enabled = await isResyncEnabled();
      if (!enabled) {
        console.log("Skipping: /resync not configured");
        return;
      }
      const credentials = Buffer.from("wrong:credentials").toString("base64");
      const response = await fetch(`${BASE_URL}/resync`, {
        headers: { Authorization: `Basic ${credentials}` },
      });
      expect(response.status).toBe(401);
    });

    test("CSRF guard: a browser navigation to /resync is rejected before auth (403, not 401)", async () => {
      // #given /resync is enabled
      const enabled = await isResyncEnabled();
      if (!enabled) {
        console.log("Skipping: /resync not configured");
        return;
      }
      // #when a request arrives with browser-navigation fetch metadata (as a malicious
      // book frame's meta-refresh/window.location would carry), even with valid auth
      const credentials = Buffer.from("admin:secret").toString("base64");
      const response = await fetch(`${BASE_URL}/resync`, {
        headers: {
          Authorization: `Basic ${credentials}`,
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin",
        },
      });
      // #then it is blocked in the rewrite phase, before the resync ever runs
      expect(response.status).toBe(403);
    });

    test("CSRF guard: a cross-site request to /resync is rejected (403)", async () => {
      const enabled = await isResyncEnabled();
      if (!enabled) {
        console.log("Skipping: /resync not configured");
        return;
      }
      const credentials = Buffer.from("admin:secret").toString("base64");
      const response = await fetch(`${BASE_URL}/resync`, {
        headers: { Authorization: `Basic ${credentials}`, "Sec-Fetch-Site": "cross-site" },
      });
      expect(response.status).toBe(403);
    });

    // This test triggers resync - keep it last
    test("GET /resync with correct auth returns 202 (when enabled)", async () => {
      const enabled = await isResyncEnabled();
      if (!enabled) {
        console.log("Skipping: /resync not configured");
        return;
      }
      const credentials = Buffer.from("admin:secret").toString("base64");
      const response = await fetch(`${BASE_URL}/resync`, {
        headers: { Authorization: `Basic ${credentials}` },
      });
      expect(response.status).toBe(202);
    });
  });
});
