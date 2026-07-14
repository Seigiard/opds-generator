import { describe, test, expect } from "bun:test";
import { parsePdfInfoOutput, stripSourceFileExtension } from "../../../src/formats/pdf.ts";

const PDFX_OUTPUT = `Title:           Grimwild
Author:          Oddity Press
Creator:         Adobe InDesign 20.1 (Windows)
Producer:        Adobe PDF Library 17.0
CreationDate:    Mon Feb 17 11:16:16 2025 CET
ModDate:         Tue Feb 18 17:36:17 2025 CET
Pages:           178
PDF version:     1.6
PDF subtype:    PDF/X-4
    Title:         ISO 15930 - Electronic document file format for prepress digital data exchange (PDF/X)
    Abbreviation:  PDF/X-4
    Subtitle:      Part 7: Complete exchange of printing data (PDF/X-4) and partial exchange of printing data with external profile reference (PDF/X-4p) using PDF 1.6
    Standard:      ISO 15930-7
`;

describe("parsePdfInfoOutput", () => {
  test("ignores indented PDF subtype block so document title survives", () => {
    // #given pdfinfo output from a PDF/X-4 file with an indented subtype Title line

    // #when
    const info = parsePdfInfoOutput(PDFX_OUTPUT);

    // #then
    expect(info.title).toBe("Grimwild");
  });

  test("parses top-level metadata fields", () => {
    // #given

    // #when
    const info = parsePdfInfoOutput(PDFX_OUTPUT);

    // #then
    expect(info).toEqual({
      title: "Grimwild",
      author: "Oddity Press",
      creationDate: "Mon Feb 17 11:16:16 2025 CET",
      pages: 178,
    });
  });
});

describe("stripSourceFileExtension", () => {
  test("strips .indd suffix left by InDesign export", () => {
    // #given a title that is the InDesign source filename

    // #when
    const title = stripSourceFileExtension("Grimwild - Exploration Deck.indd");

    // #then
    expect(title).toBe("Grimwild - Exploration Deck");
  });

  test("strips word-processor extensions case-insensitively", () => {
    // #given

    // #when
    const title = stripSourceFileExtension("My Thesis.DOCX");

    // #then
    expect(title).toBe("My Thesis");
  });

  test("keeps titles that merely contain dots", () => {
    // #given a legitimate title ending in a non-source-file token

    // #when
    const title = stripSourceFileExtension("Web 2.0 Design Patterns");

    // #then
    expect(title).toBe("Web 2.0 Design Patterns");
  });

  test("keeps plain titles unchanged", () => {
    // #given

    // #when
    const title = stripSourceFileExtension("Grimwild");

    // #then
    expect(title).toBe("Grimwild");
  });
});
