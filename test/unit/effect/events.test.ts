import { describe, test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { adaptBooksEvent } from "../../../src/effect/adapters/books-adapter.ts";
import { adaptDataEvent } from "../../../src/effect/adapters/data-adapter.ts";
import type { RawBooksEvent, RawDataEvent } from "../../../src/effect/types.ts";
import { DeduplicationService } from "../../../src/effect/services.ts";

// Mock deduplication service that always allows processing
const TestDeduplicationService = Layer.succeed(DeduplicationService, {
  shouldProcess: () => Effect.succeed(true),
});

// Helper to run adaptBooksEvent with mock services
const classifyBooksEvent = async (event: RawBooksEvent) => {
  return Effect.runPromise(Effect.provide(adaptBooksEvent(event), TestDeduplicationService));
};

// Helper to run adaptDataEvent with mock services
const classifyDataEvent = async (event: RawDataEvent) => {
  return Effect.runPromise(Effect.provide(adaptDataEvent(event), TestDeduplicationService));
};

describe("adaptBooksEvent (books watcher classification)", () => {
  describe("file events", () => {
    test("CLOSE_WRITE on epub creates BookCreated", async () => {
      const event: RawBooksEvent = {
        parent: "/books/Fiction/",
        name: "book.epub",
        events: "CLOSE_WRITE",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("BookCreated");
      if (result?._tag === "BookCreated") {
        expect(result.parent).toBe("/books/Fiction/");
        expect(result.name).toBe("book.epub");
      }
    });

    test("MOVED_TO on fb2 creates BookCreated", async () => {
      const event: RawBooksEvent = {
        parent: "/books/Fiction/",
        name: "book.fb2",
        events: "MOVED_TO",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("BookCreated");
    });

    test("DELETE on pdf creates BookDeleted", async () => {
      const event: RawBooksEvent = {
        parent: "/books/Fiction/",
        name: "book.pdf",
        events: "DELETE",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("BookDeleted");
      if (result?._tag === "BookDeleted") {
        expect(result.parent).toBe("/books/Fiction/");
        expect(result.name).toBe("book.pdf");
      }
    });

    test("MOVED_FROM on mobi creates BookDeleted", async () => {
      const event: RawBooksEvent = {
        parent: "/books/Fiction/",
        name: "book.mobi",
        events: "MOVED_FROM",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("BookDeleted");
    });

    test("ignores non-book extensions like .md", async () => {
      const event: RawBooksEvent = {
        parent: "/books/Fiction/",
        name: "README.md",
        events: "CLOSE_WRITE",
      };

      const result = await classifyBooksEvent(event);

      expect(result).toBeNull();
    });

    test("ignores image files like .jpg", async () => {
      const event: RawBooksEvent = {
        parent: "/books/Fiction/",
        name: "cover.jpg",
        events: "CLOSE_WRITE",
      };

      const result = await classifyBooksEvent(event);

      expect(result).toBeNull();
    });

    test("recognizes .txt as valid book format", async () => {
      const event: RawBooksEvent = {
        parent: "/books/Fiction/",
        name: "story.txt",
        events: "CLOSE_WRITE",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("BookCreated");
    });

    test("CREATE on file is ignored (wait for CLOSE_WRITE)", async () => {
      const event: RawBooksEvent = {
        parent: "/books/Fiction/",
        name: "book.epub",
        events: "CREATE",
      };

      const result = await classifyBooksEvent(event);

      expect(result).toBeNull();
    });
  });

  describe("directory events", () => {
    test("CREATE,ISDIR creates FolderCreated", async () => {
      const event: RawBooksEvent = {
        parent: "/books/",
        name: "Fiction",
        events: "CREATE,ISDIR",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("FolderCreated");
      if (result?._tag === "FolderCreated") {
        expect(result.parent).toBe("/books/");
        expect(result.name).toBe("Fiction");
      }
    });

    test("MOVED_TO,ISDIR creates FolderCreated", async () => {
      const event: RawBooksEvent = {
        parent: "/books/",
        name: "SciFi",
        events: "MOVED_TO,ISDIR",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("FolderCreated");
    });

    test("DELETE,ISDIR creates FolderDeleted", async () => {
      const event: RawBooksEvent = {
        parent: "/books/",
        name: "OldFolder",
        events: "DELETE,ISDIR",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("FolderDeleted");
      if (result?._tag === "FolderDeleted") {
        expect(result.parent).toBe("/books/");
        expect(result.name).toBe("OldFolder");
      }
    });

    test("MOVED_FROM,ISDIR creates FolderDeleted", async () => {
      const event: RawBooksEvent = {
        parent: "/books/",
        name: "MovedAway",
        events: "MOVED_FROM,ISDIR",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("FolderDeleted");
    });
  });

  describe("supported book formats", () => {
    const formats = ["epub", "fb2", "fbz", "mobi", "azw", "azw3", "pdf", "djvu", "cbz", "cbr", "cb7", "cbt"];

    for (const format of formats) {
      test(`recognizes .${format} as book format`, async () => {
        const event: RawBooksEvent = {
          parent: "/books/Fiction/",
          name: `book.${format}`,
          events: "CLOSE_WRITE",
        };

        const result = await classifyBooksEvent(event);

        expect(result?._tag).toBe("BookCreated");
      });
    }
  });

  describe("deduplication", () => {
    test("filters duplicate events", async () => {
      let callCount = 0;
      const TestDedupService = Layer.succeed(DeduplicationService, {
        shouldProcess: () =>
          Effect.sync(() => {
            callCount++;
            return callCount === 1;
          }),
      });

      const event: RawBooksEvent = {
        parent: "/books/Fiction/",
        name: "book.epub",
        events: "CLOSE_WRITE",
      };

      const result1 = await Effect.runPromise(Effect.provide(adaptBooksEvent(event), TestDedupService));
      const result2 = await Effect.runPromise(Effect.provide(adaptBooksEvent(event), TestDedupService));

      expect(result1?._tag).toBe("BookCreated");
      expect(result2).toBeNull();
    });
  });
});

describe("adaptDataEvent (data watcher classification)", () => {
  test("entry.xml change creates EntryXmlChanged", async () => {
    const event: RawDataEvent = {
      parent: "/data/Fiction/book.epub/",
      name: "entry.xml",
      events: "CLOSE_WRITE",
    };

    const result = await classifyDataEvent(event);

    expect(result?._tag).toBe("EntryXmlChanged");
    if (result?._tag === "EntryXmlChanged") {
      expect(result.parent).toBe("/data/Fiction/book.epub/");
    }
  });

  test("_entry.xml change creates FolderEntryXmlChanged", async () => {
    const event: RawDataEvent = {
      parent: "/data/Fiction/",
      name: "_entry.xml",
      events: "CLOSE_WRITE",
    };

    const result = await classifyDataEvent(event);

    expect(result?._tag).toBe("FolderEntryXmlChanged");
    if (result?._tag === "FolderEntryXmlChanged") {
      expect(result.parent).toBe("/data/Fiction/");
    }
  });

  test("MOVED_TO entry.xml creates EntryXmlChanged", async () => {
    const event: RawDataEvent = {
      parent: "/data/Fiction/book.epub/",
      name: "entry.xml",
      events: "MOVED_TO",
    };

    const result = await classifyDataEvent(event);

    expect(result?._tag).toBe("EntryXmlChanged");
  });

  test("ignores other data files", async () => {
    const event: RawDataEvent = {
      parent: "/data/Fiction/book.epub/",
      name: "cover.jpg",
      events: "CLOSE_WRITE",
    };

    const result = await classifyDataEvent(event);

    expect(result).toBeNull();
  });

  test("ignores feed.xml", async () => {
    const event: RawDataEvent = {
      parent: "/data/Fiction/",
      name: "feed.xml",
      events: "CLOSE_WRITE",
    };

    const result = await classifyDataEvent(event);

    expect(result).toBeNull();
  });
});
