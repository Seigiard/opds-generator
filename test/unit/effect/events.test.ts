import { describe, test, expect } from "bun:test";
import { classifyEvent, type FileEvent } from "../../../src/effect/events.ts";

describe("classifyEvent", () => {
	describe("books watcher - file events", () => {
		test("CLOSE_WRITE on epub creates BookCreated", () => {
			const event: FileEvent = {
				watcher: "books",
				parent: "/books/Fiction",
				name: "book.epub",
				events: "CLOSE_WRITE",
			};

			const result = classifyEvent(event);

			expect(result._tag).toBe("BookCreated");
			if (result._tag === "BookCreated") {
				expect(result.parent).toBe("/books/Fiction");
				expect(result.name).toBe("book.epub");
			}
		});

		test("MOVED_TO on fb2 creates BookCreated", () => {
			const event: FileEvent = {
				watcher: "books",
				parent: "/books/Fiction",
				name: "book.fb2",
				events: "MOVED_TO",
			};

			const result = classifyEvent(event);

			expect(result._tag).toBe("BookCreated");
		});

		test("DELETE on pdf creates BookDeleted", () => {
			const event: FileEvent = {
				watcher: "books",
				parent: "/books/Fiction",
				name: "book.pdf",
				events: "DELETE",
			};

			const result = classifyEvent(event);

			expect(result._tag).toBe("BookDeleted");
			if (result._tag === "BookDeleted") {
				expect(result.parent).toBe("/books/Fiction");
				expect(result.name).toBe("book.pdf");
			}
		});

		test("MOVED_FROM on mobi creates BookDeleted", () => {
			const event: FileEvent = {
				watcher: "books",
				parent: "/books/Fiction",
				name: "book.mobi",
				events: "MOVED_FROM",
			};

			const result = classifyEvent(event);

			expect(result._tag).toBe("BookDeleted");
		});

		test("ignores non-book extensions like .md", () => {
			const event: FileEvent = {
				watcher: "books",
				parent: "/books/Fiction",
				name: "README.md",
				events: "CLOSE_WRITE",
			};

			const result = classifyEvent(event);

			expect(result._tag).toBe("Ignored");
		});

		test("ignores image files like .jpg", () => {
			const event: FileEvent = {
				watcher: "books",
				parent: "/books/Fiction",
				name: "cover.jpg",
				events: "CLOSE_WRITE",
			};

			const result = classifyEvent(event);

			expect(result._tag).toBe("Ignored");
		});

		test("recognizes .txt as valid book format", () => {
			const event: FileEvent = {
				watcher: "books",
				parent: "/books/Fiction",
				name: "story.txt",
				events: "CLOSE_WRITE",
			};

			const result = classifyEvent(event);

			expect(result._tag).toBe("BookCreated");
		});
	});

	describe("books watcher - directory events", () => {
		test("CREATE,ISDIR creates FolderCreated", () => {
			const event: FileEvent = {
				watcher: "books",
				parent: "/books",
				name: "Fiction",
				events: "CREATE,ISDIR",
			};

			const result = classifyEvent(event);

			expect(result._tag).toBe("FolderCreated");
			if (result._tag === "FolderCreated") {
				expect(result.parent).toBe("/books");
				expect(result.name).toBe("Fiction");
			}
		});

		test("MOVED_TO,ISDIR creates FolderCreated", () => {
			const event: FileEvent = {
				watcher: "books",
				parent: "/books",
				name: "SciFi",
				events: "MOVED_TO,ISDIR",
			};

			const result = classifyEvent(event);

			expect(result._tag).toBe("FolderCreated");
		});

		test("DELETE,ISDIR creates FolderDeleted", () => {
			const event: FileEvent = {
				watcher: "books",
				parent: "/books",
				name: "OldFolder",
				events: "DELETE,ISDIR",
			};

			const result = classifyEvent(event);

			expect(result._tag).toBe("FolderDeleted");
			if (result._tag === "FolderDeleted") {
				expect(result.parent).toBe("/books");
				expect(result.name).toBe("OldFolder");
			}
		});

		test("MOVED_FROM,ISDIR creates FolderDeleted", () => {
			const event: FileEvent = {
				watcher: "books",
				parent: "/books",
				name: "MovedAway",
				events: "MOVED_FROM,ISDIR",
			};

			const result = classifyEvent(event);

			expect(result._tag).toBe("FolderDeleted");
		});
	});

	describe("data watcher - XML events", () => {
		test("entry.xml change creates EntryXmlChanged", () => {
			const event: FileEvent = {
				watcher: "data",
				parent: "/data/Fiction/book.epub",
				name: "entry.xml",
				events: "CLOSE_WRITE",
			};

			const result = classifyEvent(event);

			expect(result._tag).toBe("EntryXmlChanged");
			if (result._tag === "EntryXmlChanged") {
				expect(result.parent).toBe("/data/Fiction/book.epub");
			}
		});

		test("_entry.xml change creates FolderEntryXmlChanged", () => {
			const event: FileEvent = {
				watcher: "data",
				parent: "/data/Fiction",
				name: "_entry.xml",
				events: "CLOSE_WRITE",
			};

			const result = classifyEvent(event);

			expect(result._tag).toBe("FolderEntryXmlChanged");
			if (result._tag === "FolderEntryXmlChanged") {
				expect(result.parent).toBe("/data/Fiction");
			}
		});

		test("ignores other data files", () => {
			const event: FileEvent = {
				watcher: "data",
				parent: "/data/Fiction/book.epub",
				name: "cover.jpg",
				events: "CLOSE_WRITE",
			};

			const result = classifyEvent(event);

			expect(result._tag).toBe("Ignored");
		});

		test("ignores feed.xml", () => {
			const event: FileEvent = {
				watcher: "data",
				parent: "/data/Fiction",
				name: "feed.xml",
				events: "CLOSE_WRITE",
			};

			const result = classifyEvent(event);

			expect(result._tag).toBe("Ignored");
		});
	});

	describe("supported book formats", () => {
		const formats = ["epub", "fb2", "fbz", "mobi", "azw", "azw3", "pdf", "djvu", "cbz", "cbr", "cb7", "cbt"];

		for (const format of formats) {
			test(`recognizes .${format} as book format`, () => {
				const event: FileEvent = {
					watcher: "books",
					parent: "/books/Fiction",
					name: `book.${format}`,
					events: "CLOSE_WRITE",
				};

				const result = classifyEvent(event);

				expect(result._tag).toBe("BookCreated");
			});
		}
	});
});
