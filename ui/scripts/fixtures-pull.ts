import { readdir, lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import { FEED_FILE } from "../../src/constants.ts";

const dataDir = process.env.DATA || join(import.meta.dir, "..", "..", "data");
const outDir = join(import.meta.dir, "..", "..", "test", "fixtures", "feeds");

interface Cassette {
  path: string;
  relative: string;
  xml: string;
  entries: number;
  depth: number;
  cyrillic: boolean;
  hasBookWithoutCover: boolean;
  maxTitleLen: number;
}

async function findFeeds(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    if ((await lstat(full)).isDirectory()) {
      found.push(...(await findFeeds(full)));
    } else if (name === FEED_FILE) {
      found.push(full);
    }
  }
  return found;
}

function describe(xml: string, path: string): Omit<Cassette, "path" | "relative" | "xml"> {
  const entries = xml.match(/<entry>/g)?.length ?? 0;
  const titles = [...xml.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((m) => m[1] ?? "");
  const books = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map((m) => m[0]);
  const hasBookWithoutCover = books.some((b) => b.includes("acquisition") && !b.includes("opds-spec.org/image"));
  return {
    entries,
    depth: path.split("/").length,
    cyrillic: /[А-Яа-я]/.test(xml),
    hasBookWithoutCover,
    maxTitleLen: Math.max(0, ...titles.map((t) => t.length)),
  };
}

function pick(cassettes: Cassette[], predicate: (c: Cassette) => boolean, rank: (c: Cassette) => number): Cassette | undefined {
  return cassettes
    .filter(predicate)
    .sort((a, b) => rank(b) - rank(a) || a.relative.localeCompare(b.relative))
    .at(0);
}

async function main(): Promise<void> {
  const feeds = await findFeeds(dataDir);
  const cassettes: Cassette[] = [];
  for (const path of feeds) {
    const xml = await Bun.file(path).text();
    cassettes.push({ path, relative: relative(dataDir, path), xml, ...describe(xml, path) });
  }

  const selection: Record<string, Cassette | undefined> = {
    "root.xml": cassettes.find((c) => c.relative === FEED_FILE),
    "nonfiction-cyrillic.xml": pick(
      cassettes,
      (c) => c.cyrillic && c.entries > 1,
      (c) => c.entries,
    ),
    "cyrillic-book.xml": pick(
      cassettes,
      (c) => c.cyrillic && c.entries === 1,
      (c) => c.maxTitleLen,
    ),
    "large-folder.xml": pick(
      cassettes,
      () => true,
      (c) => c.entries,
    ),
    "deep-nested.xml": pick(
      cassettes,
      (c) => c.depth > 2,
      (c) => c.depth,
    ),
  };

  let written = 0;
  for (const [name, cassette] of Object.entries(selection)) {
    if (!cassette) {
      console.warn(`fixtures:pull — no candidate for ${name}`);
      continue;
    }
    await Bun.write(join(outDir, name), cassette.xml);
    console.log(`fixtures:pull → ${name}  (${cassette.relative}, ${cassette.entries} entries)`);
    written++;
  }
  console.log(`fixtures:pull wrote ${written} cassette(s); edge-cases.xml and hostile.xml are hand-authored and left untouched`);
}

await main();
