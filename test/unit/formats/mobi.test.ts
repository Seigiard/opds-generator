import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mobiExtractorRegistration } from "../../../src/formats/mobi.ts";

const MOBI_HEADER_LENGTH = 232;

const EXTH_FLAG = 0x40;

const COVER_A = Buffer.from("first image record");

const COVER_B = Buffer.from("second image record");

type ExthRecord = readonly [type: number, value: Uint8Array];

/** A PalmDB book: record 0 holds the PalmDOC, MOBI and EXTH headers; records 1 and 2 hold the two images. */
function buildMobi({ headerTitle, exth }: { headerTitle: string; exth?: readonly ExthRecord[] }): Uint8Array {
  const exthBytes = exth ? buildExth(exth) : new Uint8Array();
  const title = new TextEncoder().encode(headerTitle);
  const record0 = new Uint8Array(16 + MOBI_HEADER_LENGTH + exthBytes.length + title.length);
  const view = new DataView(record0.buffer);
  record0.set(new TextEncoder().encode("MOBI"), 16);
  view.setUint32(20, MOBI_HEADER_LENGTH);
  view.setUint32(84, 16 + MOBI_HEADER_LENGTH + exthBytes.length);
  view.setUint32(88, title.length);
  view.setUint32(108, 1);
  view.setUint32(128, exth ? EXTH_FLAG : 0);
  record0.set(exthBytes, 16 + MOBI_HEADER_LENGTH);
  record0.set(title, 16 + MOBI_HEADER_LENGTH + exthBytes.length);

  const records = [record0, COVER_A, COVER_B];
  const tableEnd = 78 + records.length * 8;
  const book = new Uint8Array(tableEnd + records.reduce((size, record) => size + record.length, 0));
  const bookView = new DataView(book.buffer);
  bookView.setUint16(76, records.length);
  let offset = tableEnd;

  records.forEach((record, index) => {
    bookView.setUint32(78 + index * 8, offset);
    book.set(record, offset);
    offset += record.length;
  });

  return book;
}

function buildExth(records: readonly ExthRecord[]): Uint8Array {
  const encoded = records.map(([type, data]) => {
    const record = new Uint8Array(8 + data.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, type);
    view.setUint32(4, record.length);
    record.set(data, 8);

    return record;
  });

  const exth = new Uint8Array(12 + encoded.reduce((size, record) => size + record.length, 0));
  const view = new DataView(exth.buffer);
  exth.set(new TextEncoder().encode("EXTH"));
  view.setUint32(4, exth.length);
  view.setUint32(8, encoded.length);
  let pos = 12;

  for (const record of encoded) {
    exth.set(record, pos);
    pos += record.length;
  }

  return exth;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);

  return bytes;
}

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "opds-mobi-unit-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let fileCount = 0;

async function extract(book: Uint8Array) {
  const path = join(dir, `book-${fileCount++}.mobi`);
  await Bun.write(path, book);

  return Effect.runPromise(mobiExtractorRegistration.extract(path));
}

describe("MOBI extraction", () => {
  test("prefers EXTH metadata and the cover offset over the thumbnail offset", async () => {
    // #given
    const book = buildMobi({
      headerTitle: "Header Title",
      exth: [
        [503, text("Exth Title")],
        [100, text("First Author")],
        [100, text("Second Author")],
        [101, text("Publisher")],
        [105, text("fantasy")],
        [105, text("adventure")],
        [106, text("2020-01-02")],
        [109, text("Public domain")],
        [201, uint32(1)],
        [202, uint32(0)],
      ],
    });

    // #when
    const { meta, cover } = await extract(book);

    // #then
    expect({ meta, cover: cover?.toString() }).toEqual({
      meta: {
        title: "Exth Title",
        author: "First Author",
        description: undefined,
        publisher: "Publisher",
        issued: "2020-01-02",
        subjects: ["fantasy", "adventure"],
        rights: "Public domain",
      },
      cover: COVER_B.toString(),
    });
  });

  test("falls back to the thumbnail offset when no cover offset is given", async () => {
    // #given
    const book = buildMobi({ headerTitle: "Header Title", exth: [[202, uint32(1)]] });

    // #when
    const { meta, cover } = await extract(book);

    // #then
    expect({ title: meta.title, cover: cover?.toString() }).toEqual({ title: "Header Title", cover: COVER_B.toString() });
  });

  test("keeps metadata without a cover when the cover offset points past the last record", async () => {
    // #given
    const book = buildMobi({
      headerTitle: "Header Title",
      exth: [
        [100, text("Author")],
        [201, uint32(7)],
      ],
    });

    // #when
    const { meta, cover } = await extract(book);

    // #then
    expect({ title: meta.title, author: meta.author, cover }).toEqual({ title: "Header Title", author: "Author", cover: null });
  });

  test("uses the header title and no cover when the book has no EXTH block", async () => {
    // #given
    const book = buildMobi({ headerTitle: "Header Title" });

    // #when
    const { meta, cover } = await extract(book);

    // #then
    expect({ title: meta.title, author: meta.author, cover }).toEqual({ title: "Header Title", author: undefined, cover: null });
  });
});
