import { describe, expect, test } from "bun:test";
import { getExtractor } from "../../../src/formats/index.ts";
import { pdfExtractorRegistration } from "../../../src/formats/pdf.ts";

describe("format registry", () => {
  test("looks extensions up case-insensitively", () => {
    // #given / #when
    const extractor = getExtractor("PDF");

    // #then
    expect(extractor).toBe(pdfExtractorRegistration.extract);
  });

  test("has no extractor for an unsupported extension", () => {
    // #given / #when
    const extractor = getExtractor("docx");

    // #then
    expect(extractor).toBeNull();
  });
});
