import { describe, expect, test } from "bun:test";
import { getExtractor } from "../../../src/formats/index.ts";
import { mobiExtractorRegistration } from "../../../src/formats/mobi.ts";
import { pdfExtractorRegistration } from "../../../src/formats/pdf.ts";
import { txtExtractorRegistration } from "../../../src/formats/txt.ts";

describe("format registry", () => {
  test("looks extensions up case-insensitively", () => {
    // #given / #when
    const extractor = getExtractor("PDF");

    // #then
    expect(extractor).toBe(pdfExtractorRegistration.extract);
  });

  test.each([
    ["mobi", mobiExtractorRegistration.extract],
    ["azw", mobiExtractorRegistration.extract],
    ["azw3", mobiExtractorRegistration.extract],
    ["txt", txtExtractorRegistration.extract],
  ])("maps %s to its native extractor", (extension, expected) => {
    // #given / #when
    const extractor = getExtractor(extension);

    // #then
    expect(extractor).toBe(expected);
  });

  test("has no extractor for an unsupported extension", () => {
    // #given / #when
    const extractor = getExtractor("docx");

    // #then
    expect(extractor).toBeNull();
  });
});
