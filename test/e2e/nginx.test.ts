import { describe, test, expect, beforeAll } from "bun:test";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8080";

// Wait for server to be ready
async function waitForServer(maxWaitMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const response = await fetch(`${BASE_URL}/feed.xml`);
      if (response.status === 200) return;
    } catch {
      // Connection refused
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Server not ready");
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
    test("GET / redirects to /feed.xml", async () => {
      const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/feed.xml");
    });

    test("GET /opds redirects to /feed.xml", async () => {
      const response = await fetch(`${BASE_URL}/opds`, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/feed.xml");
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
    test("GET /static/layout.xsl returns 200", async () => {
      const response = await fetch(`${BASE_URL}/static/layout.xsl`);
      expect(response.status).toBe(200);
    });

    test("GET /static/style.css returns 200", async () => {
      const response = await fetch(`${BASE_URL}/static/style.css`);
      expect(response.status).toBe(200);
    });
  });

  describe("directory index", () => {
    test("GET /nonexistent/ returns 404", async () => {
      const response = await fetch(`${BASE_URL}/nonexistent/`, { redirect: "manual" });
      expect(response.status).toBe(404);
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
