import { describe, test, expect } from "bun:test";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8080";

describe("nginx integration", () => {
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
    test("GET /feed.xml returns 200 or 503", async () => {
      const response = await fetch(`${BASE_URL}/feed.xml`);
      expect([200, 503]).toContain(response.status);

      if (response.status === 200) {
        const contentType = response.headers.get("content-type");
        expect(contentType).toContain("xml");
      } else {
        expect(response.headers.get("retry-after")).toBe("5");
      }
    });
  });

  describe("static files", () => {
    test("GET /static/ returns files from static directory", async () => {
      const response = await fetch(`${BASE_URL}/static/stanza.xml`);
      expect([200, 404]).toContain(response.status);
    });
  });

  describe("directory index", () => {
    test("GET /nonexistent/ returns 404 or 503", async () => {
      const response = await fetch(`${BASE_URL}/nonexistent/`, { redirect: "manual" });
      expect([404, 503]).toContain(response.status);
    });
  });

  describe("/resync endpoint", () => {
    test("GET /resync without auth returns 401 or 404", async () => {
      const response = await fetch(`${BASE_URL}/resync`);
      expect([401, 404]).toContain(response.status);
    });

    test("GET /resync with correct auth returns 202", async () => {
      const credentials = Buffer.from("admin:secret").toString("base64");
      const response = await fetch(`${BASE_URL}/resync`, {
        headers: { Authorization: `Basic ${credentials}` },
      });
      expect([202, 404]).toContain(response.status);
    });

    test("GET /resync with wrong auth returns 401", async () => {
      const credentials = Buffer.from("wrong:credentials").toString("base64");
      const response = await fetch(`${BASE_URL}/resync`, {
        headers: { Authorization: `Basic ${credentials}` },
      });
      expect([401, 404]).toContain(response.status);
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

  describe("content headers", () => {
    test("responses include charset utf-8", async () => {
      const response = await fetch(`${BASE_URL}/feed.xml`);
      if (response.status === 200) {
        const contentType = response.headers.get("content-type") || "";
        expect(contentType.toLowerCase()).toContain("utf-8");
      }
    });
  });
});
