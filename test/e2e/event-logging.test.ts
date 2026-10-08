import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import * as v from "valibot";

// Tests poll for events up to 20 s, so bun's 5 s default would cut them off.
setDefaultTimeout(40000);

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8080";

// Container paths
const BOOKS_DIR = "/books";

const TEST_FOLDER = "test-events";

const FIXTURE_PDF = "/books/test/Test Book - Test Author.pdf";

const logEntrySchema = v.object({
  ts: v.string(),
  level: v.string(),
  tag: v.string(),
  msg: v.string(),
  event_type: v.optional(v.string()),
  event_id: v.optional(v.string()),
  event_tag: v.optional(v.string()),
  path: v.optional(v.string()),
  duration_ms: v.optional(v.number()),
  cascade_count: v.optional(v.number()),
  cascade_tags: v.optional(v.array(v.string())),
  error: v.optional(v.string()),
});

type LogEntry = v.InferOutput<typeof logEntrySchema>;

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

// Helper: strip ANSI color codes from string
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// Helper: get logs from docker container since timestamp
async function getLogsSince(since: string): Promise<LogEntry[]> {
  const proc = Bun.spawn(["docker", "compose", "-f", "docker-compose.e2e.yml", "logs", "--since", since, "--no-log-prefix", "opds"]);

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  return output
    .trim()
    .split("\n")
    .map((line) => stripAnsi(line))
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      try {
        return v.parse(logEntrySchema, JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter((e): e is LogEntry => e !== null);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Helper: poll the container logs until the predicate holds, so assertions wait on the
// events themselves instead of a fixed window that the inotify fan-out can outrun.
async function waitForLogs(since: string, predicate: (logs: LogEntry[]) => boolean, timeoutMs: number = 20000): Promise<LogEntry[]> {
  const deadline = Date.now() + timeoutMs;
  let logs = await getLogsSince(since);

  while (!predicate(logs) && Date.now() < deadline) {
    await sleep(500);
    logs = await getLogsSince(since);
  }

  return logs;
}

// Helper: poll a URL until it returns the wanted availability
async function waitForUrl(relativePath: string, wanted: boolean, timeoutMs: number = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if ((await dataExists(relativePath)) === wanted) return true;

    await sleep(500);
  }

  return (await dataExists(relativePath)) === wanted;
}

// Helper: has the handler for this event finished
function hasCompleted(logs: LogEntry[], eventTag: string, pathContains: string): boolean {
  return findHandlerEvents(logs, eventTag, pathContains).some((e) => e.event_type === "handler_complete");
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
function findEvents(logs: LogEntry[], eventTag: string, pathContains?: string): LogEntry[] {
  return logs.filter((e) => {
    if (e.event_tag !== eventTag) return false;

    if (pathContains && (!e.path || !e.path.includes(pathContains))) return false;

    return true;
  });
}

// Helper: find handler events (start/complete)
function findHandlerEvents(logs: LogEntry[], eventTag: string, pathContains?: string): LogEntry[] {
  return logs.filter((e) => {
    if (e.event_tag !== eventTag) return false;

    if (!e.event_type || !["handler_start", "handler_complete"].includes(e.event_type)) return false;

    if (pathContains && (!e.path || !e.path.includes(pathContains))) return false;

    return true;
  });
}

// Helper: get timestamp for docker logs --since flag
function getDockerTimestamp(): string {
  // Docker expects RFC3339 or relative time
  return new Date().toISOString();
}

describe("Event Logging E2E", () => {
  beforeAll(
    async () => {
      // Ensure test folders don't exist (cleanup from previous runs)
      await execInContainer(
        `rm -rf ${BOOKS_DIR}/${TEST_FOLDER} ${BOOKS_DIR}/${TEST_FOLDER}-copy ${BOOKS_DIR}/${TEST_FOLDER}-duplicate ${BOOKS_DIR}/test-events-book1.pdf ${BOOKS_DIR}/test-events-book3.pdf`,
      );
      // The processor may still be draining initial sync events when the container becomes healthy
      await sleep(10000);
    },
    { timeout: 15000 },
  );

  afterAll(async () => {
    // Cleanup all test artifacts
    await execInContainer(
      `rm -rf ${BOOKS_DIR}/${TEST_FOLDER} ${BOOKS_DIR}/${TEST_FOLDER}-copy ${BOOKS_DIR}/${TEST_FOLDER}-duplicate ${BOOKS_DIR}/test-events-book1.pdf ${BOOKS_DIR}/test-events-book3.pdf`,
    );
  });

  describe("Phase 1: Setup", () => {
    test("create folder runs its folder work", async () => {
      const before = getDockerTimestamp();

      await execInContainer(`mkdir -p ${BOOKS_DIR}/${TEST_FOLDER}`);

      // The engine declares a folder as folder-refresh work (its feed, page and parent entry), not as a FolderCreated event.
      const logs = await waitForLogs(before, (l) => hasCompleted(l, "FolderMetaSyncRequested", TEST_FOLDER));

      expect(findEvents(logs, "FolderMetaSyncRequested", TEST_FOLDER).length).toBeGreaterThan(0);

      const handlerLogs = findHandlerEvents(logs, "FolderMetaSyncRequested", TEST_FOLDER);
      expect(handlerLogs.some((e) => e.event_type === "handler_start")).toBe(true);
      expect(handlerLogs.some((e) => e.event_type === "handler_complete")).toBe(true);
    });

    test("folder data structure is created", async () => {
      expect(await waitForUrl(`${TEST_FOLDER}/feed.xml`, true)).toBe(true);
    });
  });

  describe("Phase 2: Adding books", () => {
    test("add book1 triggers BookCreated event", async () => {
      const before = getDockerTimestamp();

      await execInContainer(`cp "${FIXTURE_PDF}" "${BOOKS_DIR}/${TEST_FOLDER}/test-events-book1.pdf"`);

      const logs = await waitForLogs(before, (l) => hasCompleted(l, "BookCreated", "test-events-book1.pdf"));

      expect(findEvents(logs, "BookCreated", "test-events-book1.pdf").length).toBeGreaterThan(0);

      const handlerLogs = findHandlerEvents(logs, "BookCreated", "test-events-book1.pdf");
      expect(handlerLogs.some((e) => e.event_type === "handler_start")).toBe(true);
      expect(handlerLogs.some((e) => e.event_type === "handler_complete")).toBe(true);
    });

    test("book1 data structure is created", async () => {
      expect(await waitForUrl(`${TEST_FOLDER}/test-events-book1.pdf/entry.xml`, true)).toBe(true);
    });

    test("add book2 triggers BookCreated event", async () => {
      const before = getDockerTimestamp();

      await execInContainer(`cp "${FIXTURE_PDF}" "${BOOKS_DIR}/${TEST_FOLDER}/test-events-book2.pdf"`);

      const logs = await waitForLogs(before, (l) => hasCompleted(l, "BookCreated", "test-events-book2.pdf"));

      expect(findEvents(logs, "BookCreated", "test-events-book2.pdf").length).toBeGreaterThan(0);
    });

    test("feed.xml contains both books once the cascade refreshes the folder", async () => {
      const deadline = Date.now() + 20000;
      let xml = "";

      while (Date.now() < deadline) {
        const response = await fetch(`${BASE_URL}/${TEST_FOLDER}/feed.xml`);

        if (response.ok) {
          xml = await response.text();

          if (xml.includes("test-events-book1.pdf") && xml.includes("test-events-book2.pdf")) break;
        }

        await sleep(500);
      }

      expect(xml).toContain("test-events-book1.pdf");
      expect(xml).toContain("test-events-book2.pdf");
    });
  });

  describe("Phase 3: Book operations", () => {
    test("move book1 to root triggers BookDeleted + BookCreated", async () => {
      const before = getDockerTimestamp();

      await execInContainer(`mv "${BOOKS_DIR}/${TEST_FOLDER}/test-events-book1.pdf" "${BOOKS_DIR}/test-events-book1.pdf"`);

      const logs = await waitForLogs(
        before,
        (l) => hasCompleted(l, "BookDeleted", "test-events-book1.pdf") && hasCompleted(l, "BookCreated", "test-events-book1.pdf"),
      );

      expect(findEvents(logs, "BookDeleted", "test-events-book1.pdf").length).toBeGreaterThan(0);
      expect(findEvents(logs, "BookCreated", "test-events-book1.pdf").length).toBeGreaterThan(0);
    });

    test("rename book1 to book3 triggers BookDeleted + BookCreated", async () => {
      const before = getDockerTimestamp();

      await execInContainer(`mv "${BOOKS_DIR}/test-events-book1.pdf" "${BOOKS_DIR}/test-events-book3.pdf"`);

      const logs = await waitForLogs(
        before,
        (l) => hasCompleted(l, "BookDeleted", "test-events-book1.pdf") && hasCompleted(l, "BookCreated", "test-events-book3.pdf"),
      );

      expect(findEvents(logs, "BookDeleted", "test-events-book1.pdf").length).toBeGreaterThan(0);
      expect(findEvents(logs, "BookCreated", "test-events-book3.pdf").length).toBeGreaterThan(0);
    });

    test("copy book3 to book1 triggers BookCreated", async () => {
      // The adapter drops events for the same path within 500 ms of the last one, and the
      // previous step ended with a BookDeleted for book1.
      await sleep(1000);

      const before = getDockerTimestamp();

      await execInContainer(`cp "${BOOKS_DIR}/test-events-book3.pdf" "${BOOKS_DIR}/test-events-book1.pdf"`);

      const logs = await waitForLogs(before, (l) => hasCompleted(l, "BookCreated", "test-events-book1.pdf"));

      expect(findEvents(logs, "BookCreated", "test-events-book1.pdf").length).toBeGreaterThan(0);
    });

    test("delete book1 and book3 triggers BookDeleted", async () => {
      const before = getDockerTimestamp();

      await execInContainer(`rm "${BOOKS_DIR}/test-events-book1.pdf" "${BOOKS_DIR}/test-events-book3.pdf"`);

      const logs = await waitForLogs(
        before,
        (l) => hasCompleted(l, "BookDeleted", "test-events-book1.pdf") && hasCompleted(l, "BookDeleted", "test-events-book3.pdf"),
      );

      expect(findEvents(logs, "BookDeleted", "test-events-book1.pdf").length).toBeGreaterThan(0);
      expect(findEvents(logs, "BookDeleted", "test-events-book3.pdf").length).toBeGreaterThan(0);
    });
  });

  describe("Phase 4: Folder operations", () => {
    test(
      "copy folder runs its folder work and lists every copied book in the copy's feed",
      async () => {
        const before = getDockerTimestamp();

        await execInContainer(`cp -r "${BOOKS_DIR}/${TEST_FOLDER}" "${BOOKS_DIR}/${TEST_FOLDER}-copy"`);

        const logs = await waitForLogs(before, (l) => hasCompleted(l, "FolderMetaSyncRequested", `${TEST_FOLDER}-copy`));

        expect(findEvents(logs, "FolderMetaSyncRequested", `${TEST_FOLDER}-copy`).length).toBeGreaterThan(0);

        // inotifywait watches the new folder only after its create event, so the books copied
        // into it may raise no event of their own; the pass must still list them in the feed.
        expect(await waitForUrl(`${TEST_FOLDER}-copy/feed.xml`, true)).toBe(true);
        expect(await waitForUrl(`${TEST_FOLDER}-copy/test-events-book2.pdf/entry.xml`, true)).toBe(true);

        const deadline = Date.now() + 20000;
        let xml = "";

        while (Date.now() < deadline && !xml.includes("test-events-book2.pdf")) {
          const response = await fetch(`${BASE_URL}/${TEST_FOLDER}-copy/feed.xml`);

          if (response.ok) xml = await response.text();

          if (!xml.includes("test-events-book2.pdf")) await sleep(500);
        }

        expect(xml).toContain("test-events-book2.pdf");
      },
      { timeout: 40000 },
    );

    test("rename folder removes the old folder and runs the new folder's work", async () => {
      const before = getDockerTimestamp();

      await execInContainer(`mv "${BOOKS_DIR}/${TEST_FOLDER}-copy" "${BOOKS_DIR}/${TEST_FOLDER}-duplicate"`);

      const logs = await waitForLogs(
        before,
        (l) =>
          hasCompleted(l, "FolderDeleted", `${TEST_FOLDER}-copy`) && hasCompleted(l, "FolderMetaSyncRequested", `${TEST_FOLDER}-duplicate`),
      );

      expect(findEvents(logs, "FolderDeleted", `${TEST_FOLDER}-copy`).length).toBeGreaterThan(0);
      expect(findEvents(logs, "FolderMetaSyncRequested", `${TEST_FOLDER}-duplicate`).length).toBeGreaterThan(0);
    });

    test("move folder into another triggers events", async () => {
      const before = getDockerTimestamp();

      await execInContainer(`mv "${BOOKS_DIR}/${TEST_FOLDER}-duplicate" "${BOOKS_DIR}/${TEST_FOLDER}/${TEST_FOLDER}-duplicate"`);

      const logs = await waitForLogs(before, (l) => hasCompleted(l, "FolderMetaSyncRequested", `${TEST_FOLDER}/${TEST_FOLDER}-duplicate`));

      const folderLogs = logs.filter((e) => e.event_tag?.includes("Folder") && e.path?.includes("duplicate"));
      expect(folderLogs.length).toBeGreaterThan(0);
    });
  });

  describe("Phase 5: Cleanup", () => {
    test(
      "delete folder with contents triggers FolderDeleted and removes contained output",
      async () => {
        const before = getDockerTimestamp();

        await execInContainer(`rm -rf "${BOOKS_DIR}/${TEST_FOLDER}"`);

        const logs = await waitForLogs(before, (l) => hasCompleted(l, "FolderDeleted", TEST_FOLDER), 30000);

        expect(findEvents(logs, "FolderDeleted", TEST_FOLDER).length).toBeGreaterThan(0);
      },
      { timeout: 40000 },
    );

    test("data structure is cleaned up", async () => {
      expect(await waitForUrl(`${TEST_FOLDER}/feed.xml`, false)).toBe(true);
    });
  });
});
