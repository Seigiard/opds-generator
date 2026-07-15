import { describe, test, expect } from "bun:test";
import { parseFragment } from "../../../ui/reader/fragment.ts";
import { BOOK_EXTENSIONS, VIEWABLE_FORMATS } from "../../../src/types.ts";

const parse = (hash: string) => parseFragment(hash, VIEWABLE_FORMATS, BOOK_EXTENSIONS);

describe("parseFragment", () => {
  test("happy path: folder + file resolves to fetch path, folder back-link, extension", () => {
    // #given a catalog-emitted fragment (data mirror doubles the book name)
    const result = parse("#/sci-fi/Dune.epub/Dune.epub");
    // #then the path, back-link, and extension come out validated
    expect(result).toEqual({
      kind: "ok",
      fetchPath: "/sci-fi/Dune.epub/Dune.epub",
      folderPath: "/sci-fi/",
      filename: "Dune.epub",
      ext: "epub",
    });
  });

  test("book-data dir segment is dropped from the folder back-link, root folder included", () => {
    // #given a root-level book (its data dir is the only parent segment)
    const result = parse("#/Dune.epub/Dune.epub");
    // #then the back-link lands on the catalog root, not inside the book-data dir
    expect(result).toMatchObject({ kind: "ok", folderPath: "/" });
  });

  test("hand-crafted two-segment path keeps its real containing folder", () => {
    const result = parse("#/sci-fi/Dune.pdf");
    expect(result).toMatchObject({ kind: "ok", folderPath: "/sci-fi/", ext: "pdf" });
  });

  test("encoded unicode and spaces decode for validation and re-encode for fetch", () => {
    // #given a percent-encoded cyrillic name with spaces
    const result = parse("#/test/%D0%9A%D0%BD%D0%B8%D0%B3%D0%B0%20one.epub/%D0%9A%D0%BD%D0%B8%D0%B3%D0%B0%20one.epub");
    // #then the fetch path is canonically re-encoded and the filename is human-readable
    expect(result).toMatchObject({
      kind: "ok",
      fetchPath: "/test/%D0%9A%D0%BD%D0%B8%D0%B3%D0%B0%20one.epub/%D0%9A%D0%BD%D0%B8%D0%B3%D0%B0%20one.epub",
      folderPath: "/test/",
      filename: "Книга one.epub",
    });
  });

  test("non-viewable book extension reports unsupported with a safe back-link", () => {
    const result = parse("#/comics/thing.djvu/thing.djvu");
    expect(result).toEqual({ kind: "unsupported", folderPath: "/comics/", ext: "djvu" });
  });

  test.each(["", "#", "#garbage", "#book.epub", "#/onlyfile.epub", "#/folder/noextension", "#/folder/.epub", "#/folder/file."])(
    "missing or malformed fragment %j is invalid",
    (hash) => {
      expect(parse(hash)).toEqual({ kind: "invalid" });
    },
  );

  // AE5: hostile-fragment matrix — every entry must yield invalid (no fetch, safe back-link)
  test.each([
    "#https://evil.example",
    "#//evil.example",
    "#/\\evil.example",
    "#\\\\evil.example",
    "#javascript:alert(1)",
    "#data:text/html,<script>alert(1)</script>",
    "#blob:https://evil.example/x",
    "#/../resync",
    "#/%2e%2e%2fresync",
    "#/%2e%2e/resync",
    "#/%252e%252e/resync",
    "#/books/..%2fresync",
    "#/books/%2e%2e/resync",
    "#/books/.%2e/resync",
    "#/%c0%ae%c0%ae/resync",
  ])("AE5: hostile fragment %j is invalid", (hash) => {
    expect(parse(hash)).toEqual({ kind: "invalid" });
  });

  // R15: no constructible fragment reaches /resync or any non-book path
  test("R15: every accepted fetch path has non-dot segments and a viewable extension", () => {
    const probes = ["#/resync", "#/resync/resync", "#/a/resync", "#/a/b/c/resync"];
    for (const probe of probes) {
      const result = parse(probe);
      expect(result.kind).not.toBe("ok");
    }
    // and an accepted path can never be /resync: it always ends in .<viewable ext>
    const accepted = parse("#/a/resync.epub");
    expect(accepted).toMatchObject({ kind: "ok", fetchPath: "/a/resync.epub" });
  });

  test("attacker-chosen double encoding never survives to the wire", () => {
    // #given a segment that decodes once to a percent sequence
    const result = parse("#/books/%252e%252e/file.epub");
    // #then it is rejected outright (dot-only segment after one decode)
    expect(result).toEqual({ kind: "invalid" });
    // and a legit percent-in-name file is re-encoded canonically
    const legit = parse("#/books/100%25 legit.epub/100%25 legit.epub");
    expect(legit).toMatchObject({ kind: "ok", fetchPath: "/books/100%25%20legit.epub/100%25%20legit.epub" });
  });

  test("malformed percent-encoding is invalid, not thrown", () => {
    expect(parse("#/books/%zz.epub")).toEqual({ kind: "invalid" });
  });

  test("extension check is case-insensitive", () => {
    expect(parse("#/books/UPPER.EPUB/UPPER.EPUB")).toMatchObject({ kind: "ok", ext: "epub" });
  });
});
