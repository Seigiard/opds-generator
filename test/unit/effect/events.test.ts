import { describe, test, expect } from "bun:test";
import { adaptBooksEvent } from "../../../src/effect/adapters/books-adapter.ts";
import { adaptDataEvent } from "../../../src/effect/adapters/data-adapter.ts";
import type { RawBooksEvent } from "../../../src/effect/types.ts";
import type { DeduplicationService } from "../../../src/context.ts";

const alwaysProcessDedup: DeduplicationService = {
  shouldProcess: () => true,
};

describe("adaptBooksEvent (books watcher classification)", () => {
  describe("file events", () => {
    test("CLOSE_WRITE on epub creates BookCreated", () => {
      const event: RawBooksEvent = { parent: "/books/Fiction/", name: "book.epub", events: "CLOSE_WRITE" };
      const result = adaptBooksEvent(event, alwaysProcessDedup);
      expect(result?._tag).toBe("BookCreated");
      if (result?._tag === "BookCreated") {
        expect(result.parent).toBe("/books/Fiction/");
        expect(result.name).toBe("book.epub");
      }
    });

    test("MOVED_TO on fb2 creates BookCreated", () => {
      const result = adaptBooksEvent({ parent: "/books/Fiction/", name: "book.fb2", events: "MOVED_TO" }, alwaysProcessDedup);
      expect(result?._tag).toBe("BookCreated");
    });

    test("DELETE on pdf creates BookDeleted", () => {
      const result = adaptBooksEvent({ parent: "/books/Fiction/", name: "book.pdf", events: "DELETE" }, alwaysProcessDedup);
      expect(result?._tag).toBe("BookDeleted");
      if (result?._tag === "BookDeleted") {
        expect(result.parent).toBe("/books/Fiction/");
        expect(result.name).toBe("book.pdf");
      }
    });

    test("MOVED_FROM on mobi creates BookDeleted", () => {
      const result = adaptBooksEvent({ parent: "/books/Fiction/", name: "book.mobi", events: "MOVED_FROM" }, alwaysProcessDedup);
      expect(result?._tag).toBe("BookDeleted");
    });

    test("ignores non-book extensions like .md", () => {
      const result = adaptBooksEvent({ parent: "/books/Fiction/", name: "README.md", events: "CLOSE_WRITE" }, alwaysProcessDedup);
      expect(result).toBeNull();
    });

    test("ignores image files like .jpg", () => {
      const result = adaptBooksEvent({ parent: "/books/Fiction/", name: "cover.jpg", events: "CLOSE_WRITE" }, alwaysProcessDedup);
      expect(result).toBeNull();
    });

    test("recognizes .txt as valid book format", () => {
      const result = adaptBooksEvent({ parent: "/books/Fiction/", name: "story.txt", events: "CLOSE_WRITE" }, alwaysProcessDedup);
      expect(result?._tag).toBe("BookCreated");
    });

    test("CREATE on file is ignored (wait for CLOSE_WRITE)", () => {
      const result = adaptBooksEvent({ parent: "/books/Fiction/", name: "book.epub", events: "CREATE" }, alwaysProcessDedup);
      expect(result).toBeNull();
    });
  });

  describe("directory events", () => {
    test("CREATE,ISDIR creates FolderCreated", () => {
      const result = adaptBooksEvent({ parent: "/books/", name: "Fiction", events: "CREATE,ISDIR" }, alwaysProcessDedup);
      expect(result?._tag).toBe("FolderCreated");
      if (result?._tag === "FolderCreated") {
        expect(result.parent).toBe("/books/");
        expect(result.name).toBe("Fiction");
      }
    });

    test("MOVED_TO,ISDIR creates FolderCreated", () => {
      const result = adaptBooksEvent({ parent: "/books/", name: "SciFi", events: "MOVED_TO,ISDIR" }, alwaysProcessDedup);
      expect(result?._tag).toBe("FolderCreated");
    });

    test("DELETE,ISDIR creates FolderDeleted", () => {
      const result = adaptBooksEvent({ parent: "/books/", name: "OldFolder", events: "DELETE,ISDIR" }, alwaysProcessDedup);
      expect(result?._tag).toBe("FolderDeleted");
      if (result?._tag === "FolderDeleted") {
        expect(result.parent).toBe("/books/");
        expect(result.name).toBe("OldFolder");
      }
    });

    test("MOVED_FROM,ISDIR creates FolderDeleted", () => {
      const result = adaptBooksEvent({ parent: "/books/", name: "MovedAway", events: "MOVED_FROM,ISDIR" }, alwaysProcessDedup);
      expect(result?._tag).toBe("FolderDeleted");
    });
  });

  describe("supported book formats", () => {
    const formats = ["epub", "fb2", "fbz", "mobi", "azw", "azw3", "pdf", "djvu", "cbz", "cbr", "cb7", "cbt"];

    for (const format of formats) {
      test(`recognizes .${format} as book format`, () => {
        const result = adaptBooksEvent({ parent: "/books/Fiction/", name: `book.${format}`, events: "CLOSE_WRITE" }, alwaysProcessDedup);
        expect(result?._tag).toBe("BookCreated");
      });
    }
  });

  describe("dot-prefixed entries", () => {
    test("ignores dot-prefixed file", () => {
      const result = adaptBooksEvent({ parent: "/books/Fiction/", name: ".DS_Store", events: "CLOSE_WRITE" }, alwaysProcessDedup);
      expect(result).toBeNull();
    });

    test("ignores dot-prefixed directory", () => {
      const result = adaptBooksEvent({ parent: "/books/", name: ".hidden", events: "CREATE,ISDIR" }, alwaysProcessDedup);
      expect(result).toBeNull();
    });

    test("ignores dot-prefixed book file", () => {
      const result = adaptBooksEvent({ parent: "/books/Fiction/", name: ".book.epub", events: "CLOSE_WRITE" }, alwaysProcessDedup);
      expect(result).toBeNull();
    });

    test("ignores delete of dot-prefixed directory", () => {
      const result = adaptBooksEvent({ parent: "/books/", name: ".trash", events: "DELETE,ISDIR" }, alwaysProcessDedup);
      expect(result).toBeNull();
    });
  });

  describe("deduplication", () => {
    test("filters duplicate events", () => {
      let callCount = 0;
      const dedupOnce: DeduplicationService = {
        shouldProcess: () => {
          callCount++;
          return callCount === 1;
        },
      };

      const event: RawBooksEvent = { parent: "/books/Fiction/", name: "book.epub", events: "CLOSE_WRITE" };
      const result1 = adaptBooksEvent(event, dedupOnce);
      const result2 = adaptBooksEvent(event, dedupOnce);
      expect(result1?._tag).toBe("BookCreated");
      expect(result2).toBeNull();
    });
  });
});

describe("adaptDataEvent (data watcher classification)", () => {
  test("entry.xml change creates EntryXmlChanged", () => {
    const result = adaptDataEvent({ parent: "/data/Fiction/book.epub/", name: "entry.xml", events: "CLOSE_WRITE" }, alwaysProcessDedup);
    expect(result?._tag).toBe("EntryXmlChanged");
    if (result?._tag === "EntryXmlChanged") expect(result.parent).toBe("/data/Fiction/book.epub/");
  });

  test("_entry.xml change creates FolderEntryXmlChanged", () => {
    const result = adaptDataEvent({ parent: "/data/Fiction/", name: "_entry.xml", events: "CLOSE_WRITE" }, alwaysProcessDedup);
    expect(result?._tag).toBe("FolderEntryXmlChanged");
    if (result?._tag === "FolderEntryXmlChanged") expect(result.parent).toBe("/data/Fiction/");
  });

  test("MOVED_TO entry.xml creates EntryXmlChanged", () => {
    const result = adaptDataEvent({ parent: "/data/Fiction/book.epub/", name: "entry.xml", events: "MOVED_TO" }, alwaysProcessDedup);
    expect(result?._tag).toBe("EntryXmlChanged");
  });

  test("ignores other data files", () => {
    const result = adaptDataEvent({ parent: "/data/Fiction/book.epub/", name: "cover.jpg", events: "CLOSE_WRITE" }, alwaysProcessDedup);
    expect(result).toBeNull();
  });

  test("ignores feed.xml", () => {
    const result = adaptDataEvent({ parent: "/data/Fiction/", name: "feed.xml", events: "CLOSE_WRITE" }, alwaysProcessDedup);
    expect(result).toBeNull();
  });
});
