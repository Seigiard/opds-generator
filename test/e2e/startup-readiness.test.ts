import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFeed } from "../../src/render/parse-feed.ts";

// Each scenario starts the production image (actual server, nginx and entrypoint) in its own Compose project.
// Delays are set from the host through a gate directory: a PATH `unzip` wrapper and one held `Bun.write`.
setDefaultTimeout(180000);

const PORT = process.env.STARTUP_PORT ?? "18081";

const BASE_URL = `http://127.0.0.1:${PORT}`;

const PROJECT = process.env.COMPOSE_PROJECT_NAME ?? "opds";

const IMAGE = process.env.STARTUP_IMAGE ?? "opds-startup-test";

const COMPOSE_FILE = join(import.meta.dir, "startup", "compose.yml");

const EPUB = join(import.meta.dir, "../../files/test/Test Book - Test Author.epub");

const FB2 = join(import.meta.dir, "../../files/test/Test Book - Test Author.fb2");

const AUTH = `Basic ${Buffer.from("admin:secret").toString("base64")}`;

interface Facts {
  readonly available: boolean;
  readonly availableFrom: string | null;
  readonly verifying: boolean;
  readonly completed: boolean;
  readonly errors: readonly { readonly source: string; readonly message: string }[];
}

const scenarios: Scenario[] = [];

class Scenario {
  readonly root: string;
  readonly src: string;
  readonly data: string;
  readonly gate: string;
  private readonly env: Record<string, string | undefined>;

  private constructor(name: string, root: string) {
    this.root = root;
    this.src = join(root, "books", "src");
    this.data = join(root, "data");
    this.gate = join(root, "gate");
    this.env = {
      ...process.env,
      COMPOSE_PROJECT_NAME: `${PROJECT}-startup-${name}`,
      STARTUP_ROOT: root,
      STARTUP_PORT: PORT,
      STARTUP_IMAGE: IMAGE,
    };
  }

  static async create(name: string, options: { readonly source?: boolean } = {}): Promise<Scenario> {
    const scenario = new Scenario(name, await mkdtemp(join(tmpdir(), `opds-startup-${name}-`)));
    await mkdir(scenario.data, { recursive: true });
    await mkdir(scenario.gate, { recursive: true });
    await mkdir(join(scenario.root, "books"), { recursive: true });

    if (options.source !== false) await mkdir(scenario.src, { recursive: true });
    await writeFile(join(scenario.gate, "holds.json"), "[]");
    scenarios.push(scenario);

    return scenario;
  }

  async compose(...args: string[]): Promise<{ readonly code: number; readonly stdout: string }> {
    const proc = Bun.spawn(["docker", "compose", "-f", COMPOSE_FILE, ...args], { env: this.env, stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(proc.stdout).text();
    void new Response(proc.stderr).text();

    return { code: await proc.exited, stdout: await stdout };
  }

  /** The Bun-local lifecycle facts. nginx does not proxy this route, so they are read inside the container. */
  async status(): Promise<Facts | undefined> {
    const { code, stdout } = await this.compose("exec", "-T", "opds", "wget", "-qO-", "http://127.0.0.1:3000/status");

    // SAFETY: /status is served by this repository's own handler; a wrong shape fails the surrounding assertions.
    return code === 0 ? (JSON.parse(stdout) as Facts) : undefined;
  }

  /** The deployment health check exactly as the image declares it, run inside the container. Exit 0 = healthy. */
  async health(): Promise<number> {
    return (await this.compose("exec", "-T", "opds", "/bin/sh", "/app/healthcheck.sh")).code;
  }

  async container(): Promise<{ readonly state: string; readonly exitCode: number } | undefined> {
    const { stdout } = await this.compose("ps", "-a", "--format", "json");

    const rows = stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        const parsed: unknown = JSON.parse(line);

        return Array.isArray(parsed) ? parsed : [parsed];
      });

    // SAFETY: `docker compose ps --format json` documents State and ExitCode for every row.
    const row = rows[0] as { State: string; ExitCode: number } | undefined;

    return row === undefined ? undefined : { state: row.State, exitCode: row.ExitCode };
  }

  async setHolds(holds: readonly string[]): Promise<void> {
    await writeFile(join(this.gate, "holds.next"), JSON.stringify(holds));
    await rename(join(this.gate, "holds.next"), join(this.gate, "holds.json"));
  }

  async holdUnzip(hold: boolean): Promise<void> {
    if (hold) await writeFile(join(this.gate, "hold-unzip"), "");
    else await rm(join(this.gate, "hold-unzip"), { force: true });
  }

  entered(name: string): boolean {
    return existsSync(join(this.gate, name));
  }

  async dispose(): Promise<void> {
    await this.compose("down", "--timeout", "10");
    await rm(this.root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function withScenario(name: string, options: { readonly source?: boolean }, body: (scenario: Scenario) => Promise<void>) {
  const scenario = await Scenario.create(name, options);

  try {
    await body(scenario);
  } finally {
    await scenario.dispose();
  }
}

async function until<T>(
  description: string,
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 90000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await probe();

    if (value !== undefined && value !== false) return value;
    await Bun.sleep(250);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

async function get(path: string, init: RequestInit = {}) {
  const response = await fetch(`${BASE_URL}${path}`, { redirect: "manual", ...init });
  const body = Buffer.from(await response.arrayBuffer());

  return { status: response.status, body, location: response.headers.get("location") };
}

async function resync(query = "", auth = true) {
  return get(`/resync${query}`, { method: "POST", headers: auth ? { Authorization: AUTH } : {} });
}

function summary(facts: Facts | undefined) {
  return (
    facts && {
      available: facts.available,
      availableFrom: facts.availableFrom,
      verifying: facts.verifying,
      completed: facts.completed,
      errors: facts.errors.map((error) => error.source),
    }
  );
}

const titles = (xml: Buffer) => parseFeed(xml.toString("utf8")).entries.map((entry) => entry.title);

async function completed(scenario: Scenario) {
  return until("verification to complete", async () => {
    const facts = await scenario.status();

    return facts?.completed ? facts : undefined;
  });
}

async function publicationOf(paths: readonly string[]) {
  const publications = await Promise.all(
    paths.map(async (path) => {
      const response = await get(path);
      expect(response.status).toBe(200);

      return [path, response.body] as const;
    }),
  );

  return Object.fromEntries(publications);
}

beforeAll(async () => {
  const scratch = await mkdtemp(join(tmpdir(), "opds-startup-build-"));

  const build = Bun.spawn(["docker", "compose", "-f", COMPOSE_FILE, "build"], {
    env: { ...process.env, STARTUP_ROOT: scratch, STARTUP_IMAGE: IMAGE, COMPOSE_PROJECT_NAME: `${PROJECT}-startup-build` },
    stdout: "ignore",
    stderr: "inherit",
  });

  if ((await build.exited) !== 0) throw new Error("Could not build the production image");
  await rm(scratch, { recursive: true, force: true });
}, 580000);

afterAll(async () => {
  await Promise.all(scenarios.map((scenario) => scenario.dispose()));
});

describe("startup readiness through the production server and nginx", () => {
  test("the image declares the minimum-honoring health check as its default", async () => {
    // #given the production image built for these scenarios
    const inspect = Bun.spawn(["docker", "image", "inspect", "--format", "{{json .Config.Healthcheck.Test}}", IMAGE], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const declared = JSON.parse((await new Response(inspect.stdout).text()).trim());
    // #then it runs the script that needs the available fact, the feed and the page, not the feed alone
    expect({ code: await inspect.exited, declared }).toEqual({ code: 0, declared: ["CMD", "/bin/sh", "/app/healthcheck.sh"] });
  });

  test("a warm start serves previously published results through nginx while verification is held", async () => {
    // #given a real two-folder catalogue built by the production image, then stopped gracefully
    await withScenario("warm", {}, async (s) => {
      await mkdir(join(s.src, "Nested"));
      await copyFile(EPUB, join(s.src, "Book.epub"));
      await copyFile(EPUB, join(s.src, "Nested", "Second.epub"));
      await s.compose("up", "-d");
      await completed(s);
      const paths = ["/opds", "/index.html", "/Nested/", "/Nested/feed.xml", "/Book.epub/cover.jpg", "/Book.epub/Book.epub"];
      const prior = await publicationOf(paths);
      const stopped = await s.compose("stop");
      const stoppedState = await s.container();
      // #when the process restarts with a changed source and its real extraction is held
      await utimes(join(s.src, "Book.epub"), new Date(), new Date("2031-01-01T00:00:00Z"));
      await rm(join(s.gate, "unzip-entered"), { force: true });
      await s.holdUnzip(true);
      await s.compose("up", "-d");
      await until("held extraction", () => s.entered("unzip-entered"));
      const during = await s.status();
      const duringHealth = await s.health();
      const served = await publicationOf(paths);
      const root = await get("/", {});
      const challenge = await resync("", false);
      // #then nginx serves the earlier bytes while verification is active, and routing stays intact
      expect({
        gracefulStop: { code: stopped.code, exit: stoppedState?.exitCode },
        facts: summary(during),
        health: duringHealth,
        served: Object.fromEntries(paths.map((path) => [path, served[path]!.equals(prior[path]!)])),
        downloadIsSource: served["/Book.epub/Book.epub"]!.equals(await readFile(EPUB)),
        priorTitles: titles(prior["/opds"]!).sort(),
        root: { status: root.status, location: root.location },
        resyncWithoutCredentials: challenge.status,
      }).toEqual({
        gracefulStop: { code: 0, exit: 0 },
        facts: { available: true, availableFrom: "prior-output", verifying: true, completed: false, errors: [] },
        health: 0,
        served: Object.fromEntries(paths.map((path) => [path, true])),
        downloadIsSource: true,
        priorTitles: ["Nested", "Test Book"],
        root: { status: 302, location: "/index.html" },
        resyncWithoutCredentials: 401,
      });
      // #and releasing the extraction completes verification without losing availability
      await s.holdUnzip(false);
      const after = await completed(s);
      expect({ facts: summary(after), download: (await get("/Book.epub/Book.epub")).body.equals(await readFile(EPUB)) }).toEqual({
        facts: { available: true, availableFrom: "prior-output", verifying: false, completed: true, errors: [] },
        download: true,
      });
      expect((await resync("")).status).toBe(202);
    });
  });

  test("a cold start reports availability at the root minimum while remaining book work is held", async () => {
    // #given a fresh output, a real book, a held root browser page and a held extraction
    await withScenario("cold", {}, async (s) => {
      await copyFile(EPUB, join(s.src, "Book.epub"));
      await s.setHolds(["/data/index.html.tmp"]);
      await s.holdUnzip(true);
      // #when the first pass has written the root feed but not the root page
      await s.compose("up", "-d");
      await until("held root page", () => s.entered("entered-_data_index.html.tmp"));

      const feedOnly = {
        facts: await s.status(),
        opds: (await get("/opds")).status,
        page: (await get("/index.html")).status,
        health: await s.health(),
      };

      // #and the page is published while the book extraction is still held
      await s.setHolds([]);
      await until("availability", async () => (await s.status())?.available);
      await until("held extraction", () => s.entered("unzip-entered"));
      const minimum = await s.status();
      const minimumHealth = await s.health();
      const feed = await get("/opds");
      const page = await get("/index.html");
      // #and the held book work finishes
      await s.holdUnzip(false);
      const done = await completed(s);
      const final = await get("/opds");
      // #then readiness needs the root feed and page, ignores pending book work, and completion is separate
      expect({
        feedOnly: { facts: summary(feedOnly.facts), opds: feedOnly.opds, page: feedOnly.page, health: feedOnly.health },
        minimum: {
          facts: summary(minimum),
          health: minimumHealth,
          feedStatus: feed.status,
          feedTitles: titles(feed.body),
          pageStatus: page.status,
          pageIsBrowserView: page.body.toString("utf8").includes('<main class="books-grid"'),
        },
        done: summary(done),
        finalTitles: titles(final.body),
        download: (await get("/Book.epub/Book.epub")).body.equals(await readFile(EPUB)),
      }).toEqual({
        feedOnly: {
          facts: { available: false, availableFrom: null, verifying: true, completed: false, errors: [] },
          opds: 200,
          page: 503,
          // A served feed alone is not health: the root page is part of the declared minimum.
          health: 1,
        },
        minimum: {
          facts: { available: true, availableFrom: "minimum-publication", verifying: true, completed: false, errors: [] },
          health: 0,
          feedStatus: 200,
          feedTitles: [],
          pageStatus: 200,
          pageIsBrowserView: true,
        },
        done: { available: true, availableFrom: "minimum-publication", verifying: false, completed: true, errors: [] },
        finalTitles: ["Test Book"],
        download: true,
      });
    });
  });

  test("a cold start whose root page cannot be published exits unsuccessfully and is never available", async () => {
    // #given a fresh output where the root browser page path is a directory
    await withScenario("cold-page-fatal", {}, async (s) => {
      await copyFile(EPUB, join(s.src, "Book.epub"));
      await mkdir(join(s.data, "index.html"));
      // #when the first pass runs
      await s.compose("up", "-d");
      const seen = { available: false, pageServed: false };

      const exited = await until("container exit", async () => {
        const facts = await s.status();

        if (facts?.available) seen.available = true;

        if ((await get("/index.html").catch(() => undefined))?.status === 200) seen.pageServed = true;
        const state = await s.container();

        return state?.state === "exited" ? state : undefined;
      });

      // #then the container failed and no usable deployment was ever reported
      expect({ exitCode: exited.exitCode, seen }).toEqual({ exitCode: 1, seen: { available: false, pageServed: false } });
    });
  });

  test("a cold start without a readable source exits unsuccessfully and is never available", async () => {
    // #given a fresh output and no source root
    await withScenario("cold-source-fatal", { source: false }, async (s) => {
      // #when the first pass runs
      await s.compose("up", "-d");
      const seen = { available: false, feedServed: false };

      const exited = await until("container exit", async () => {
        const facts = await s.status();

        if (facts?.available) seen.available = true;

        if ((await get("/opds").catch(() => undefined))?.status === 200) seen.feedServed = true;
        const state = await s.container();

        return state?.state === "exited" ? state : undefined;
      });

      // #then the container failed and nothing was published
      expect({ exitCode: exited.exitCode, seen, published: existsSync(join(s.data, "feed.xml")) }).toEqual({
        exitCode: 1,
        seen: { available: false, feedServed: false },
        published: false,
      });
    });
  });

  test("a warm start whose source cannot be read keeps serving, reports the error and retries on resync", async () => {
    // #given a published real catalogue, stopped, whose source directory is then absent
    await withScenario("warm-failure", {}, async (s) => {
      await copyFile(EPUB, join(s.src, "Book.epub"));
      await s.compose("up", "-d");
      await completed(s);
      // A download is a symlink to the source file, so it cannot be served while the source itself is absent.
      const paths = ["/opds", "/index.html"];
      const prior = await publicationOf(paths);
      await s.compose("stop");
      await rename(s.src, join(s.root, "books", "src-away"));
      // #when the process starts and verification fails
      await s.compose("up", "-d");

      const failed = await until("a reported error", async () => {
        const facts = await s.status();

        return facts && facts.errors.length > 0 ? facts : undefined;
      });

      const served = await publicationOf(paths);
      const running = await s.container();
      // #and the source returns and a resync is requested
      await rename(join(s.root, "books", "src-away"), s.src);
      const unauthorised = await resync("", false);
      const admission = await resync("");
      const retried = await completed(s);
      const again = await s.container();
      // #then the failure was observable and not fatal, and the retry completed without a restart
      expect({
        failed: summary(failed),
        served: Object.fromEntries(paths.map((path) => [path, served[path]!.equals(prior[path]!)])),
        running: running?.state,
        unauthorised: unauthorised.status,
        admission: { status: admission.status, body: admission.body.toString() },
        retried: summary(retried),
        stillRunning: again?.state,
        downloadAfterRetry: (await get("/Book.epub/Book.epub")).body.equals(await readFile(EPUB)),
      }).toEqual({
        failed: { available: true, availableFrom: "prior-output", verifying: false, completed: false, errors: ["pass"] },
        served: Object.fromEntries(paths.map((path) => [path, true])),
        running: "running",
        unauthorised: 401,
        admission: { status: 202, body: "Resync started" },
        retried: { available: true, availableFrom: "prior-output", verifying: false, completed: true, errors: [] },
        stillRunning: "running",
        downloadAfterRetry: true,
      });
    });
  });

  test("a damaged replacement converges while the independent book publishes", async () => {
    // #given a completed catalogue of two real books
    await withScenario("errors", {}, async (s) => {
      await copyFile(FB2, join(s.src, "Damaged.fb2"));
      await copyFile(FB2, join(s.src, "Independent.fb2"));
      await s.compose("up", "-d");
      await completed(s);
      const entry = join(s.data, "Damaged.fb2", "entry.xml");
      const previous = await readFile(entry);
      // #when one source is damaged, another changes, and a forced resync drains
      await writeFile(join(s.src, "Damaged.fb2"), "not a FictionBook");
      await writeFile(
        join(s.src, "Independent.fb2"),
        (await readFile(FB2, "utf8")).replace("<book-title>Test Book</book-title>", "<book-title>Changed Book</book-title>"),
      );
      await resync("?force=1");

      const facts = await until("completion after damaged replacement", async () => {
        const current = await s.status();

        return current?.completed ? current : undefined;
      });

      // #then the earlier entry is retained, completion converges, and nginx serves the independent change
      expect({
        available: facts.available,
        verifying: facts.verifying,
        errors: facts.errors.map((error) => error.source),
        entryRetained: (await readFile(entry)).equals(previous),
        titles: titles((await get("/opds")).body).sort(),
      }).toEqual({ available: true, verifying: false, errors: [], entryRetained: true, titles: ["Changed Book", "Test Book"] });
    });
  });
});
