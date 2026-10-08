import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { comicExtractorRegistration } from "../../../src/formats/comic.ts";
import {
  FIXTURES_DIR,
  SAMPLE_IMAGE_SHA256,
  SAMPLE_IMAGES,
  buildComic,
  comicTempDir,
  sampleImage,
  sha256,
  type BuildableComic,
} from "../../helpers/comic-archives.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
  const dir = await comicTempDir("comic-extract-");
  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  return dir;
}

function extract(path: string) {
  return Effect.runPromise(comicExtractorRegistration.extract(path));
}

const failureTag = (path: string) => Effect.runPromise(Effect.flip(comicExtractorRegistration.extract(path))).then((error) => error._tag);

const COMIC_INFO = `<?xml version="1.0"?>
<ComicInfo>
  <Title>Bobby's Dream</Title>
  <Series>Bobby Make-Believe</Series>
  <Volume>1</Volume>
  <Number>3</Number>
  <Summary>A boy  imagines
    things.</Summary>
  <Writer>Frank King</Writer>
  <Penciller>Someone Else</Penciller>
  <Year>1915</Year>
  <Month>4</Month>
  <LanguageISO>en</LanguageISO>
  <Genre>Humor, Fantasy</Genre>
  <PageCount>4</PageCount>
</ComicInfo>`;

const COMET = `<?xml version="1.0"?>
<comet>
  <title>CoMet Title</title>
  <writer>CoMet Writer</writer>
  <description>CoMet description</description>
  <publisher>Reilly &amp; Britton</publisher>
  <date>1915-05-01</date>
  <language>de</language>
  <genre>Ignored</genre>
  <series>CoMet Series</series>
  <rights>Public domain</rights>
</comet>`;

const COMIC_INFO_METADATA = {
  title: "Bobby's Dream",
  author: "Frank King",
  description: "A boy imagines things.",
  issued: "1915-04",
  language: "en",
  subjects: ["Humor", "Fantasy"],
  pageCount: 4,
  series: "Bobby Make-Believe Vol.1 #3",
};

const COMET_METADATA = {
  title: "CoMet Title",
  author: "CoMet Writer",
  description: "CoMet description",
  publisher: "Reilly & Britton",
  issued: "1915-05",
  language: "de",
  subjects: ["Ignored"],
  series: "CoMet Series",
  rights: "Public domain",
};

const MALFORMED = "<ComicInfo><Title>x</Title></ComicInfo";

describe("Comic extraction from the sample fixtures", () => {
  test.each([
    { name: "bobby_make_believe_sample.cbz", cover: SAMPLE_IMAGE_SHA256[0] },
    { name: "bobby_make_believe_sample.cbr", cover: SAMPLE_IMAGE_SHA256[0] },
    { name: "bobby_make_believe_sample.cb7", cover: SAMPLE_IMAGE_SHA256[0] },
    { name: "bobby_make_believe_sample.cbt", cover: SAMPLE_IMAGE_SHA256[0] },
    { name: "bobby_make_believe_sample_dir.cbz", cover: SAMPLE_IMAGE_SHA256[0] },
    { name: "bobby_make_believe_sample_dir.cb7", cover: SAMPLE_IMAGE_SHA256[0] },
    { name: "bobby_make_believe_sample_dir.cbt", cover: SAMPLE_IMAGE_SHA256[0] },
  ] as const)("$name has an empty title and its first sorted page as cover", async ({ name, cover }) => {
    // #given an image-only comic fixture
    // #when
    const book = await extract(join(FIXTURES_DIR, name));
    // #then
    expect({ meta: book.meta, cover: sha256(book.cover) }).toEqual({ meta: { title: "" }, cover });
  });

  test("the magazine fixture extracts with a cover", async () => {
    // #given / #when
    const book = await extract(join(FIXTURES_DIR, "Elf_Receiver_Radio-Craft_August_1936.cbz"));
    // #then
    expect(book.cover?.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});

describe.each(["cbz", "cb7", "cbt"] satisfies BuildableComic[])("Comic extraction from a built %s", (type) => {
  test("ComicInfo fields take precedence and CoMet fills only the missing publisher and rights", async () => {
    // #given ComicInfo without publisher or rights and a CoMet that has every field
    const dir = await tempDir();

    const archive = await buildComic(dir, `merged.${type}`, type, {
      "ComicInfo.xml": COMIC_INFO,
      "CoMet.xml": COMET,
      [SAMPLE_IMAGES[0]!]: await sampleImage(0),
    });

    // #when
    const book = await extract(archive);

    // #then
    expect(book.meta).toEqual({ ...COMIC_INFO_METADATA, publisher: "Reilly & Britton", rights: "Public domain" });
  });

  test("malformed ComicInfo keeps the CoMet metadata", async () => {
    // #given
    const dir = await tempDir();

    const archive = await buildComic(dir, `bad-info.${type}`, type, {
      "ComicInfo.xml": MALFORMED,
      "CoMet.xml": COMET,
      [SAMPLE_IMAGES[0]!]: await sampleImage(0),
    });

    // #when
    const book = await extract(archive);

    // #then
    expect(book.meta).toEqual(COMET_METADATA);
  });

  test("malformed CoMet keeps the ComicInfo metadata", async () => {
    // #given
    const dir = await tempDir();

    const archive = await buildComic(dir, `bad-comet.${type}`, type, {
      "ComicInfo.xml": COMIC_INFO,
      "CoMet.xml": MALFORMED,
      [SAMPLE_IMAGES[0]!]: await sampleImage(0),
    });

    // #when
    const book = await extract(archive);

    // #then
    expect(book.meta).toEqual(COMIC_INFO_METADATA);
  });

  test("a FrontCover page hint picks that index of the sorted images, past an incomplete hint", async () => {
    // #given images whose name-pattern and sorted-first choices differ from the hinted page
    const dir = await tempDir();

    const archive = await buildComic(dir, `hinted.${type}`, type, {
      "ComicInfo.xml": '<ComicInfo><Pages><Page Type="Story"/><Page Image="2" Type="FrontCover"/></Pages></ComicInfo>',
      "a_cover.jpg": await sampleImage(0),
      "b.jpg": await sampleImage(1),
      "c.jpg": await sampleImage(2),
    });

    // #when
    const book = await extract(archive);

    // #then
    expect(sha256(book.cover)).toBe(SAMPLE_IMAGE_SHA256[2]);
  });

  test("without a page hint an image named as a cover wins over the sorted first image", async () => {
    // #given
    const dir = await tempDir();

    const archive = await buildComic(dir, `named.${type}`, type, {
      "a.jpg": await sampleImage(0),
      "z_Cover.jpg": await sampleImage(3),
    });

    // #when
    const book = await extract(archive);

    // #then
    expect(sha256(book.cover)).toBe(SAMPLE_IMAGE_SHA256[3]);
  });

  test("a failed cover read keeps the metadata and publishes no cover", async () => {
    // #given an archive whose cover read cannot start its command
    const dir = await tempDir();

    const archive = await buildComic(dir, `cover-fails.${type}`, type, {
      "ComicInfo.xml": COMIC_INFO,
      [SAMPLE_IMAGES[1]!]: await sampleImage(1),
    });

    const originalSpawn = Bun.spawn.bind(Bun);

    // SAFETY: the spy forwards Bun.spawn's own arguments for every command that does not read the cover image.
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((command: any, options?: any) => {
      if (command.includes(SAMPLE_IMAGES[1])) throw new Error("cover read unavailable");

      return originalSpawn(command, options);
    });

    cleanups.push(async () => spawnSpy.mockRestore());

    // #when
    const book = await extract(archive);

    // #then
    expect(book).toEqual({ meta: COMIC_INFO_METADATA, cover: null });
  });
});

describe("Comic archives holding only a directory", () => {
  test.each(["cbz", "cbt"] satisfies BuildableComic[])("a %s lists no entries and fails extraction", async (type) => {
    // #given an archive holding one empty directory and no files
    const dir = await tempDir();
    const archive = await buildComic(dir, `empty.${type}`, type, { "empty/": "" });

    // #when
    const outcome = await failureTag(archive);

    // #then
    expect(outcome).toBe("ExtractionFailed");
  });

  test("a cb7 lists the directory itself, so it extracts as an untitled book without a cover", async () => {
    // #given
    const dir = await tempDir();
    const archive = await buildComic(dir, "empty.cb7", "cb7", { "empty/": "" });

    // #when
    const book = await extract(archive);

    // #then
    expect(book).toEqual({ meta: { title: "" }, cover: null });
  });
});

describe("Comic extraction edge cases", () => {
  test("a missing file fails extraction", async () => {
    // #given / #when
    const outcome = await failureTag("/non/existent/file.cbz");
    // #then
    expect(outcome).toBe("ExtractionFailed");
  });

  test("a file that is no archive fails extraction", async () => {
    // #given / #when
    const outcome = await failureTag(join(FIXTURES_DIR, "Test Book - Test Author.pdf"));
    // #then
    expect(outcome).toBe("ExtractionFailed");
  });
});
