import { describe, expect, test } from "bun:test";
import { lqipFromTitle } from "../../../src/render/lqip.ts";

// Expected codes are the low 20 bits of published FNV-1a 32-bit vectors
// ("" → 0x811c9dc5, "a" → 0xe40c292c, "foobar" → 0xbf9cf968) and, for Cyrillic,
// FNV-1a over the UTF-8 bytes computed outside this codebase.
describe("lqipFromTitle", () => {
  test("hashes an empty title to the FNV offset basis", () => {
    // #given an empty title
    const title = "";
    // #when its placeholder code is derived
    const code = lqipFromTitle(title);
    // #then it is the low 20 bits of 0x811c9dc5
    expect(code).toBe(826821);
  });

  test("hashes an ASCII title with FNV-1a", () => {
    // #given a single-letter title
    const title = "a";
    // #when its placeholder code is derived
    const code = lqipFromTitle(title);
    // #then it is the low 20 bits of 0xe40c292c
    expect(code).toBe(796972);
  });

  test("hashes a multi-byte title over its UTF-8 bytes", () => {
    // #given a Cyrillic title
    const title = "война и мир";
    // #when its placeholder code is derived
    const code = lqipFromTitle(title);
    // #then it matches FNV-1a over the UTF-8 encoding, not UTF-16 code units
    expect(code).toBe(599160);
  });

  test("ignores surrounding whitespace and letter case", () => {
    // #given the published vector title with padding and capitals
    const title = "  FooBar \n";
    // #when its placeholder code is derived
    const code = lqipFromTitle(title);
    // #then it equals the code for "foobar" (low 20 bits of 0xbf9cf968)
    expect(code).toBe(850280);
  });

  test("gives decomposed and composed forms of a title the same code", () => {
    // #given "Война и мир" with й written as и + combining breve (NFD)
    const title = "Война и мир";
    // #when its placeholder code is derived
    const code = lqipFromTitle(title);
    // #then it equals the code for the composed, lower-cased title
    expect(code).toBe(599160);
  });
});
