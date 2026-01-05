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
    test("GET /feed.xml returns 200 with XML content", async () => {
      const response = await fetch(`${BASE_URL}/feed.xml`);
      expect(response.status).toBe(200);
      const contentType = response.headers.get("content-type");
      expect(contentType).toContain("xml");
    });
  });

  describe("static files", () => {
    test("GET /static/stanza.xml returns 200", async () => {
      const response = await fetch(`${BASE_URL}/static/stanza.xml`);
      expect(response.status).toBe(200);
    });
  });

  describe("directory index", () => {
    test("GET /nonexistent/ returns 404", async () => {
      const response = await fetch(`${BASE_URL}/nonexistent/`, { redirect: "manual" });
      expect(response.status).toBe(404);
    });
  });

  describe("/resync endpoint", () => {
    test("GET /resync without auth returns 401", async () => {
      const response = await fetch(`${BASE_URL}/resync`);
      expect(response.status).toBe(401);
    });

    test("GET /resync with correct auth returns 202", async () => {
      const credentials = Buffer.from("admin:secret").toString("base64");
      const response = await fetch(`${BASE_URL}/resync`, {
        headers: { Authorization: `Basic ${credentials}` },
      });
      expect(response.status).toBe(202);
    });

    test("GET /resync with wrong auth returns 401", async () => {
      const credentials = Buffer.from("wrong:credentials").toString("base64");
      const response = await fetch(`${BASE_URL}/resync`, {
        headers: { Authorization: `Basic ${credentials}` },
      });
      expect(response.status).toBe(401);
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
      expect(response.status).toBe(200);
      const contentType = response.headers.get("content-type") || "";
      expect(contentType.toLowerCase()).toContain("utf-8");
    });
  });
});
