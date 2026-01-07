import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8080";
const AUTH = Buffer.from("admin:secret").toString("base64");

// Container paths
const BOOKS_DIR = "/books";
const TEST_FOLDER = "test-events";
const FIXTURE_PDF = "/books/test/Test Book - Test Author.pdf";

interface EventLogEntry {
  timestamp: string;
  type: string;
  event_id: string;
  event_tag: string;
  path?: string;
  handler?: string;
  duration_ms?: number;
  cascades?: number;
  cascade_tags?: string[];
  error?: string;
}

// Helper: execute command inside container
async function execInContainer(cmd: string): Promise<string> {
  const proc = Bun.spawn(["docker", "compose", "-f", "docker-compose.e2e.yml", "exec", "-T", "opds", "sh", "-c", cmd]);
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Command failed: ${cmd}\nExit code: ${exitCode}\nStderr: ${stderr}`);
  }
  return output;
}

// Helper: fetch events from server
async function getEvents(): Promise<EventLogEntry[]> {
  const response = await fetch(`${BASE_URL}/events.jsonl`, {
    headers: { Authorization: `Basic ${AUTH}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch events: ${response.status}`);
  }
  const text = await response.text();
  if (!text.trim()) return [];

  return text
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as EventLogEntry[];
}

// Helper: get events since timestamp
async function getEventsSince(since: string): Promise<EventLogEntry[]> {
  const events = await getEvents();
  return events.filter((e) => e.timestamp >= since);
}

// Helper: wait for events to be processed
async function waitForProcessing(ms: number = 2000): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper: check if file exists in /data
async function dataExists(relativePath: string): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/${relativePath}`);
    return response.ok;
  } catch {
    return false;
  }
}

// Helper: find events by tag and path
function findEvents(events: EventLogEntry[], tag: string, pathContains?: string): EventLogEntry[] {
  return events.filter((e) => {
    if (e.event_tag !== tag) return false;
    if (pathContains && (!e.path || !e.path.includes(pathContains))) return false;
    return true;
  });
}

// Helper: find handler events (start/complete)
function findHandlerEvents(events: EventLogEntry[], tag: string, pathContains?: string): EventLogEntry[] {
  return events.filter((e) => {
    if (e.event_tag !== tag) return false;
    if (!["handler_start", "handler_complete"].includes(e.type)) return false;
    if (pathContains && (!e.path || !e.path.includes(pathContains))) return false;
    return true;
  });
}

describe("Event Logging E2E", () => {
  beforeAll(async () => {
    // Ensure test folders don't exist (cleanup from previous runs)
    await execInContainer(
      `rm -rf ${BOOKS_DIR}/${TEST_FOLDER} ${BOOKS_DIR}/${TEST_FOLDER}-copy ${BOOKS_DIR}/${TEST_FOLDER}-duplicate ${BOOKS_DIR}/test-events-book1.pdf ${BOOKS_DIR}/test-events-book3.pdf`,
    );
    // Wait for any cleanup events to be processed
    await waitForProcessing(3000);
  });

  afterAll(async () => {
    // Cleanup all test artifacts
    await execInContainer(
      `rm -rf ${BOOKS_DIR}/${TEST_FOLDER} ${BOOKS_DIR}/${TEST_FOLDER}-copy ${BOOKS_DIR}/${TEST_FOLDER}-duplicate ${BOOKS_DIR}/test-events-book1.pdf ${BOOKS_DIR}/test-events-book3.pdf`,
    );
  });

  describe("Phase 1: Setup", () => {
    test("create folder triggers FolderCreated event", async () => {
      const before = new Date().toISOString();

      // Create test folder inside container
      await execInContainer(`mkdir -p ${BOOKS_DIR}/${TEST_FOLDER}`);
      await waitForProcessing();

      const events = await getEventsSince(before);

      // Should have FolderCreated event
      const folderCreatedEvents = findEvents(events, "FolderCreated", TEST_FOLDER);
      expect(folderCreatedEvents.length).toBeGreaterThan(0);

      // Should have handler_start and handler_complete for FolderCreated
      const handlerEvents = findHandlerEvents(events, "FolderCreated", TEST_FOLDER);
      expect(handlerEvents.some((e) => e.type === "handler_start")).toBe(true);
      expect(handlerEvents.some((e) => e.type === "handler_complete")).toBe(true);
    });

    test("folder data structure is created", async () => {
      // /data/test-events/feed.xml should exist
      const feedExists = await dataExists(`${TEST_FOLDER}/feed.xml`);
      expect(feedExists).toBe(true);
    });
  });

  describe("Phase 2: Adding books", () => {
    test("add book1 triggers BookCreated event", async () => {
      const before = new Date().toISOString();

      // Copy PDF to test folder inside container
      await execInContainer(`cp "${FIXTURE_PDF}" "${BOOKS_DIR}/${TEST_FOLDER}/test-events-book1.pdf"`);
      await waitForProcessing(3000); // PDF processing takes longer

      const events = await getEventsSince(before);

      // Should have BookCreated event
      const bookCreatedEvents = findEvents(events, "BookCreated", "test-events-book1.pdf");
      expect(bookCreatedEvents.length).toBeGreaterThan(0);

      // Should have handler events
      const handlerEvents = findHandlerEvents(events, "BookCreated", "test-events-book1.pdf");
      expect(handlerEvents.some((e) => e.type === "handler_start")).toBe(true);
      expect(handlerEvents.some((e) => e.type === "handler_complete")).toBe(true);
    });

    test("book1 data structure is created", async () => {
      // entry.xml should exist
      const entryExists = await dataExists(`${TEST_FOLDER}/test-events-book1.pdf/entry.xml`);
      expect(entryExists).toBe(true);
    });

    test("add book2 triggers BookCreated event", async () => {
      const before = new Date().toISOString();

      // Copy another PDF inside container
      await execInContainer(`cp "${FIXTURE_PDF}" "${BOOKS_DIR}/${TEST_FOLDER}/test-events-book2.pdf"`);
      await waitForProcessing(3000);

      const events = await getEventsSince(before);

      // Should have BookCreated event
      const bookCreatedEvents = findEvents(events, "BookCreated", "test-events-book2.pdf");
      expect(bookCreatedEvents.length).toBeGreaterThan(0);
    });

    test("feed.xml contains both books", async () => {
      const response = await fetch(`${BASE_URL}/${TEST_FOLDER}/feed.xml`);
      expect(response.ok).toBe(true);
      const xml = await response.text();
      expect(xml).toContain("test-events-book1.pdf");
      expect(xml).toContain("test-events-book2.pdf");
    });
  });

  describe("Phase 3: Book operations", () => {
    test("move book1 to root triggers BookDeleted + BookCreated", async () => {
      const before = new Date().toISOString();

      // Move book1 from test-events/ to root inside container
      await execInContainer(`mv "${BOOKS_DIR}/${TEST_FOLDER}/test-events-book1.pdf" "${BOOKS_DIR}/test-events-book1.pdf"`);
      await waitForProcessing(3000);

      const events = await getEventsSince(before);

      // Should have BookDeleted from folder
      const deletedEvents = findEvents(events, "BookDeleted", "test-events-book1.pdf");
      expect(deletedEvents.length).toBeGreaterThan(0);

      // Should have BookCreated in root
      const createdEvents = findEvents(events, "BookCreated", "test-events-book1.pdf");
      expect(createdEvents.length).toBeGreaterThan(0);
    });

    test("rename book1 to book3 triggers BookDeleted + BookCreated", async () => {
      const before = new Date().toISOString();

      // Rename in root inside container
      await execInContainer(`mv "${BOOKS_DIR}/test-events-book1.pdf" "${BOOKS_DIR}/test-events-book3.pdf"`);
      await waitForProcessing(3000);

      const events = await getEventsSince(before);

      // Should have BookDeleted for book1
      const deletedEvents = findEvents(events, "BookDeleted", "test-events-book1.pdf");
      expect(deletedEvents.length).toBeGreaterThan(0);

      // Should have BookCreated for book3
      const createdEvents = findEvents(events, "BookCreated", "test-events-book3.pdf");
      expect(createdEvents.length).toBeGreaterThan(0);
    });

    test("copy book3 to book1 triggers BookCreated", async () => {
      const before = new Date().toISOString();

      // Copy back inside container
      await execInContainer(`cp "${BOOKS_DIR}/test-events-book3.pdf" "${BOOKS_DIR}/test-events-book1.pdf"`);
      await waitForProcessing(3000);

      const events = await getEventsSince(before);

      // Should have BookCreated for book1
      const createdEvents = findEvents(events, "BookCreated", "test-events-book1.pdf");
      expect(createdEvents.length).toBeGreaterThan(0);
    });

    test("delete book1 and book3 triggers BookDeleted", async () => {
      const before = new Date().toISOString();

      // Delete both books inside container
      await execInContainer(`rm "${BOOKS_DIR}/test-events-book1.pdf" "${BOOKS_DIR}/test-events-book3.pdf"`);
      await waitForProcessing(3000);

      const events = await getEventsSince(before);

      // Should have BookDeleted for both
      const deleted1 = findEvents(events, "BookDeleted", "test-events-book1.pdf");
      const deleted3 = findEvents(events, "BookDeleted", "test-events-book3.pdf");
      expect(deleted1.length).toBeGreaterThan(0);
      expect(deleted3.length).toBeGreaterThan(0);
    });
  });

  describe("Phase 4: Folder operations", () => {
    test(
      "copy folder triggers FolderCreated + BookCreated for contents",
      async () => {
        const before = new Date().toISOString();

        // Copy folder inside container
        await execInContainer(`cp -r "${BOOKS_DIR}/${TEST_FOLDER}" "${BOOKS_DIR}/${TEST_FOLDER}-copy"`);
        await waitForProcessing(5000);

        const events = await getEventsSince(before);

        // Should have FolderCreated
        const folderCreated = findEvents(events, "FolderCreated", `${TEST_FOLDER}-copy`);
        expect(folderCreated.length).toBeGreaterThan(0);

        // Should have BookCreated for book2 (the only book left in folder)
        const bookCreated = findEvents(events, "BookCreated", "test-events-book2.pdf");
        expect(bookCreated.length).toBeGreaterThan(0);
      },
      { timeout: 15000 },
    );

    test("rename folder triggers FolderDeleted + FolderCreated", async () => {
      const before = new Date().toISOString();

      // Rename folder inside container
      await execInContainer(`mv "${BOOKS_DIR}/${TEST_FOLDER}-copy" "${BOOKS_DIR}/${TEST_FOLDER}-duplicate"`);
      await waitForProcessing(3000);

      const events = await getEventsSince(before);

      // Should have FolderDeleted for -copy
      const deleted = findEvents(events, "FolderDeleted", `${TEST_FOLDER}-copy`);
      expect(deleted.length).toBeGreaterThan(0);

      // Should have FolderCreated for -duplicate
      const created = findEvents(events, "FolderCreated", `${TEST_FOLDER}-duplicate`);
      expect(created.length).toBeGreaterThan(0);
    });

    test("move folder into another triggers events", async () => {
      const before = new Date().toISOString();

      // Move -duplicate into test-events inside container
      await execInContainer(`mv "${BOOKS_DIR}/${TEST_FOLDER}-duplicate" "${BOOKS_DIR}/${TEST_FOLDER}/${TEST_FOLDER}-duplicate"`);
      await waitForProcessing(3000);

      const events = await getEventsSince(before);

      // Should have some folder events
      const folderEvents = events.filter((e) => e.event_tag.includes("Folder") && e.path?.includes("duplicate"));
      expect(folderEvents.length).toBeGreaterThan(0);
    });
  });

  describe("Phase 5: Cleanup", () => {
    test(
      "delete folder with contents triggers FolderDeleted + BookDeleted",
      async () => {
        const before = new Date().toISOString();

        // Delete entire test folder inside container
        await execInContainer(`rm -rf "${BOOKS_DIR}/${TEST_FOLDER}"`);
        await waitForProcessing(5000);

        const events = await getEventsSince(before);

        // Should have FolderDeleted
        const folderDeleted = findEvents(events, "FolderDeleted", TEST_FOLDER);
        expect(folderDeleted.length).toBeGreaterThan(0);

        // Should have BookDeleted for remaining books
        const bookDeleted = events.filter((e) => e.event_tag === "BookDeleted");
        expect(bookDeleted.length).toBeGreaterThan(0);
      },
      { timeout: 15000 },
    );

    test("data structure is cleaned up", async () => {
      // /data/test-events/ should not exist
      const feedExists = await dataExists(`${TEST_FOLDER}/feed.xml`);
      expect(feedExists).toBe(false);
    });
  });
});
