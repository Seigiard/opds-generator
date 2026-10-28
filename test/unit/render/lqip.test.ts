import { describe, expect, test } from "bun:test";
import { coverRatioFromTitle, lqipFromTitle } from "../../../src/render/lqip.ts";

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

// Expected ratios pass the published vectors through MurmurHash3 fmix32, map its top
// 12 bits linearly onto 0.600..0.734 and round to three decimals; computed outside this
// codebase.
describe("coverRatioFromTitle", () => {
  test("maps the empty-title hash to its ratio", () => {
    // #given an empty title
    const title = "";
    // #when its cover ratio is derived
    const ratio = coverRatioFromTitle(title);
    // #then fmix32(0x811c9dc5) = 0xab3e7c0b, top bits 2739 of 4095, give 0.690
    expect(ratio).toBe(0.69);
  });

  test("normalises the title the same way as the placeholder code", () => {
    // #given the published vector title with padding and capitals
    const title = "  FooBar \n";
    // #when its cover ratio is derived
    const ratio = coverRatioFromTitle(title);
    // #then it equals the ratio for "foobar": fmix32(0xbf9cf968) = 0x0c0da6dc, 192 of 4095
    expect(ratio).toBe(0.606);
  });

  test("gives consecutive volumes of a series different shapes", () => {
    // #given two titles that differ only in the volume number
    const volume14 = "Absolute Batman 014 (2026) (Digital) (Shan Empire)";
    const volume15 = "Absolute Batman 015 (2026) (Digital) (Shan Empire)";
    // #when their cover ratios are derived
    const ratios = [coverRatioFromTitle(volume14), coverRatioFromTitle(volume15)];
    // #then they land far apart: 2292 and 379 of 4095
    expect(ratios).toEqual([0.675, 0.612]);
  });
});
