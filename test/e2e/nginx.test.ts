import { describe, test, expect, beforeAll } from "bun:test";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8080";

const SHELL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

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
  await waitFor("/opds");
  await waitFor("/_catalog/test/feed.xml");
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

  describe("OPDS entry", () => {
    test("GET /opds serves the root feed as XML (readers get feeds, no 302/html body)", async () => {
      const response = await fetch(`${BASE_URL}/opds`, { redirect: "manual" });
      expect(response.status).toBe(200);
      const ct = response.headers.get("content-type") || "";
      expect(ct).toContain("xml");
      const body = await response.text();
      expect(body).toContain('<?xml version="1.0"');
      expect(body).toContain("<feed");
    });
  });

  describe("browser HTML routing", () => {
    test("root, index, existing folders and unknown folders return the no-cache shell with the exact CSP", async () => {
      // #given browser paths with and without matching catalogue folders
      const paths = ["/", "/index.html", "/test/", "/no-such-folder/"];

      // #when every path is requested without following redirects
      const facts = await Promise.all(
        paths.map(async (path) => {
          const response = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });
          const body = await response.text();

          return {
            path,
            status: response.status,
            contentType: response.headers.get("content-type")?.includes("text/html"),
            cacheControl: response.headers.get("cache-control"),
            csp: response.headers.get("content-security-policy"),
            hasApp: body.includes('<div id="app"></div>'),
            hasMain: body.includes('<script type="module" src="/_app/main.js"></script>'),
          };
        }),
      );

      // #then every browser path returns the same shell contract
      expect(facts).toEqual(
        paths.map((path) => ({
          path,
          status: 200,
          contentType: true,
          cacheControl: "no-cache",
          csp: SHELL_CSP,
          hasApp: true,
          hasMain: true,
        })),
      );
    });

    test("GET /_catalog/test/feed.xml returns XML with no-cache", async () => {
      const response = await fetch(`${BASE_URL}/_catalog/test/feed.xml`);
      expect(response.status).toBe(200);
      expect((response.headers.get("content-type") || "").toLowerCase()).toContain("xml");
      expect(response.headers.get("cache-control") || "").toContain("no-cache");
    });

    test("GET /_catalog/no-such-folder/feed.xml returns 404 after the root catalogue exists", async () => {
      // #given waitForServer established a complete root catalogue
      // #when a feed below an absent catalogue directory is requested
      const response = await fetch(`${BASE_URL}/_catalog/no-such-folder/feed.xml`, { redirect: "manual" });

      // #then the miss is permanent rather than an initializing response
      expect(response.status).toBe(404);
    });

    test("GET feed.xml inside a book output directory returns a steady-state 404", async () => {
      // #given the production sync created a book directory, which has entry.xml but never feed.xml
      const path = "/_catalog/test/Test%20Book%20-%20Test%20Author.epub/feed.xml";

      // #when
      const response = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });

      // #then the permanent miss is not reported as an initializing folder feed
      expect(response.status).toBe(404);
    });

    test("AE2: book download returns 200 with Content-Disposition", async () => {
      // discover an acquisition href from a real feed
      const feed = await (await fetch(`${BASE_URL}/_catalog/test/feed.xml`)).text();
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
      const feed = await (await fetch(`${BASE_URL}/_catalog/test/feed.xml`)).text();
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

  describe("catalogue feeds", () => {
    test("GET /_catalog/feed.xml returns 200 with XML content", async () => {
      const response = await fetch(`${BASE_URL}/_catalog/feed.xml`);
      expect(response.status).toBe(200);
      const contentType = response.headers.get("content-type");
      expect(contentType).toContain("xml");
    });

    test("response includes charset utf-8", async () => {
      const response = await fetch(`${BASE_URL}/_catalog/feed.xml`);
      expect(response.status).toBe(200);
      const contentType = response.headers.get("content-type") || "";
      expect(contentType.toLowerCase()).toContain("utf-8");
    });
  });

  describe("app files", () => {
    test("GET /_app/ and /_app/index.html do not expose the browser shell", async () => {
      // #given reserved application-asset paths that are not public shell routes
      const paths = ["/_app/", "/_app/index.html"];

      // #when
      const statuses = await Promise.all(paths.map(async (path) => (await fetch(`${BASE_URL}${path}`, { redirect: "manual" })).status));

      // #then
      expect(statuses).toEqual([404, 404]);
    });

    test("GET /_app/style.css returns 200 and revalidates (no stale immutable cache)", async () => {
      const response = await fetch(`${BASE_URL}/_app/style.css`);
      expect(response.status).toBe(200);
      // Unversioned asset URLs must revalidate so the shell and its CSS/JS stay on the same build.
      expect(response.headers.get("cache-control") || "").toContain("no-cache");
      expect(response.headers.get("etag")).toBeTruthy();
    });

    test("GET /_app/favicon/*.png is served from /app/static, not captured by the /data image regex", async () => {
      const response = await fetch(`${BASE_URL}/_app/favicon/favicon-96x96.png`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") || "").toContain("image/png");
    });

    test("GET /_app/layout.xsl returns 404 (XSLT removed)", async () => {
      const response = await fetch(`${BASE_URL}/_app/layout.xsl`);
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
      const html = await (await fetch(`${BASE_URL}/_app/read.html`)).text();
      const match = html.match(/name="foliate-base" content="([^"]+)"/);
      expect(match).not.toBeNull();

      return match![1]!;
    }

    test("R8: /_app/read.html carries the exact KTD-6 policy, MIME and no-cache", async () => {
      const response = await fetch(`${BASE_URL}/_app/read.html`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBe(READER_CSP);
      // add_header replaces inherited headers — this guards the no-cache re-declaration
      expect(response.headers.get("cache-control") || "").toContain("no-cache");
      expect(response.headers.get("content-type") || "").toContain("text/html");
      expect(await response.text()).toContain('<script type="module" src="/_app/reader.js"></script>');
    });

    test("catalogue data carries no shell CSP", async () => {
      const response = await fetch(`${BASE_URL}/_catalog/feed.xml`);
      expect({ status: response.status, csp: response.headers.get("content-security-policy") }).toEqual({ status: 200, csp: null });
    });

    test("R13: hashed foliate runtime is immutable-cacheable with module-safe MIME", async () => {
      const base = await foliateBase();
      expect(base.startsWith("/_app/foliate-")).toBe(true);

      for (const file of ["/view.js", "/vendor/pdfjs/pdf.mjs", "/vendor/pdfjs/pdf.worker.mjs"]) {
        const response = await fetch(`${BASE_URL}${base}${file}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        // strict module MIME: octet-stream would make the browser reject the import
        expect(response.headers.get("content-type") || "").toContain("javascript");
      }
    });

    test("unversioned app assets stay no-cache without the reader CSP", async () => {
      for (const file of ["/_app/main.js", "/_app/style.css", "/_app/reader.js"]) {
        const response = await fetch(`${BASE_URL}${file}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control") || "").toContain("no-cache");
        expect(response.headers.get("content-security-policy")).toBeNull();
      }
    });
  });

  describe("directory index", () => {
    test("a top-level api catalogue folder remains browsable beside app routes", async () => {
      // #given files/api contains a real book processed by the production image
      // #when the browser folder and its catalogue feed are requested
      const page = await fetch(`${BASE_URL}/api/`);
      const feed = await fetch(`${BASE_URL}/_catalog/api/feed.xml`);
      const xml = await feed.text();

      // #then both public surfaces resolve and the feed lists that book
      expect({
        page: { status: page.status, html: page.headers.get("content-type")?.includes("text/html") },
        feed: {
          status: feed.status,
          xml: feed.headers.get("content-type")?.includes("xml"),
          hasBook: xml.includes("Test Book"),
        },
      }).toEqual({
        page: { status: 200, html: true },
        feed: { status: 200, xml: true, hasBook: true },
      });
    });

    test("GET /_catalog/nonexistent.file returns 404 (non-directory catalogue miss)", async () => {
      const response = await fetch(`${BASE_URL}/_catalog/nonexistent.file`, { redirect: "manual" });
      expect(response.status).toBe(404);
    });

    test("GET /opds/ (trailing slash) serves the root feed as XML like /opds", async () => {
      const response = await fetch(`${BASE_URL}/opds/`, { redirect: "manual" });
      expect(response.status).toBe(200);
      const ct = response.headers.get("content-type") || "";
      expect(ct).toContain("xml");
      const body = await response.text();
      expect(body).toContain("<feed");
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

    test("GET /status is not proxied to the lifecycle snapshot", async () => {
      const response = await fetch(`${BASE_URL}/status`);

      expect(response.status).toBe(404);
    });
  });

  describe("initial sync", () => {
    test("creates root feed.xml with valid OPDS structure", async () => {
      const response = await fetch(`${BASE_URL}/_catalog/feed.xml`);
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

  // R15 smoke: crawl the whole feed graph, every folder path must serve the shell and every catalogue link must resolve
  describe("R15 smoke", () => {
    test("every folder path serves the shell and internal links resolve", async () => {
      const visited = new Set<string>();
      const queue: string[] = ["/_catalog/feed.xml"];
      const assets = new Set<string>();

      while (queue.length > 0) {
        const feedPath = queue.shift()!;

        if (visited.has(feedPath)) continue;
        visited.add(feedPath);

        const feedRes = await fetch(`${BASE_URL}${feedPath}`);
        expect(feedRes.status).toBe(200);
        const xml = await feedRes.text();

        // the folder that owns this feed must serve the shared shell
        const dir = feedPath.replace(/^\/_catalog/, "").replace(/feed\.xml$/, "");
        const htmlRes = await fetch(`${BASE_URL}${dir}`);
        expect(htmlRes.status).toBe(200);
        expect((htmlRes.headers.get("content-type") || "").toLowerCase()).toContain("text/html");
        const html = await htmlRes.text();
        expect(html).toContain('<div id="app"></div>');
        expect(html).toContain('<script type="module" src="/_app/main.js"></script>');

        for (const m of xml.matchAll(/rel="subsection"\s+href="([^"]+)"/g)) {
          const feedHref = htmlDecode(m[1]!);
          expect(feedHref.startsWith("/_catalog/")).toBe(true);
          const browserHref = feedHref.replace(/^\/_catalog/, "").replace(/feed\.xml$/, "");
          const cardRes = await fetch(`${BASE_URL}${browserHref}`);
          expect(cardRes.status).toBe(200);
          expect((cardRes.headers.get("content-type") || "").toLowerCase()).toContain("text/html");
          queue.push(feedHref);
        }

        for (const m of xml.matchAll(/opds-spec\.org\/image(?:\/thumbnail)?"\s+href="([^"]+)"/g)) {
          expect(m[1]!.startsWith("/_catalog/")).toBe(true);
          assets.add(m[1]!);
        }

        for (const m of xml.matchAll(/acquisition[^>]*href="([^"]+)"/g)) {
          expect(m[1]!.startsWith("/_catalog/")).toBe(true);
          assets.add(m[1]!);
        }
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

    test("a forced resync, even a second one while the first runs, answers 202 and never makes an existing feed.xml answer 503", async () => {
      // #given /resync is enabled and the catalogue is built
      const enabled = await isResyncEnabled();

      if (!enabled) {
        console.log("Skipping: /resync not configured");

        return;
      }

      const headers = { Authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` };

      // #when two forced resyncs arrive back to back and the feeds are polled while they run
      const answers = [
        (await fetch(`${BASE_URL}/resync?force=1`, { headers })).status,
        (await fetch(`${BASE_URL}/resync?force=1`, { headers })).status,
      ];

      const polled: number[] = [];

      for (let i = 0; i < 40; i++) {
        polled.push((await fetch(`${BASE_URL}/_catalog/feed.xml`)).status, (await fetch(`${BASE_URL}/_catalog/test/feed.xml`)).status);
        await new Promise((r) => setTimeout(r, 25));
      }

      // #then both are accepted and the catalogue stayed available
      expect(answers).toEqual([202, 202]);
      expect(polled.filter((status) => status !== 200)).toEqual([]);
    });
  });
});
