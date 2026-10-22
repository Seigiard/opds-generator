import { describe, expect, test } from "bun:test";
import { XMLValidator } from "fast-xml-parser";
import { bookEntryXml } from "../../../../src/processing/handlers/book-entry.ts";

// eslint-disable-next-line no-control-regex
const XML_1_0_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u;

const ILLEGAL_CHARACTERS = `${String.fromCharCode(...Array.from({ length: 9 }, (_, index) => index))}\u000b\u000c${String.fromCharCode(
  ...Array.from({ length: 18 }, (_, index) => index + 14),
)}\ufffe\uffff`;

describe("bookEntryXml", () => {
  test("removes XML 1.0-illegal characters from every metadata string", () => {
    // #given every string metadata field contains the XML 1.0-illegal character set
    const marked = (label: string): string => `${label}${ILLEGAL_CHARACTERS} kept`;

    // #when
    const xml = bookEntryXml(
      "shelf/metadata.txt",
      "metadata.txt",
      {
        title: marked("Title"),
        author: marked("Author"),
        description: marked("Description"),
        publisher: marked("Publisher"),
        issued: marked("Issued"),
        language: marked("Language"),
        subjects: [marked("Subject one"), marked("Subject two")],
        series: marked("Series"),
        rights: marked("Rights"),
      },
      true,
      123,
    );

    // #then
    expect({
      valid: XMLValidator.validate(xml),
      hasIllegalCharacter: XML_1_0_ILLEGAL.test(xml),
      legalTextKept: [
        "Title",
        "Author",
        "Description",
        "Publisher",
        "Issued",
        "Language",
        "Subject one",
        "Subject two",
        "Series",
        "Rights",
      ].every((label) => xml.includes(`${label} kept`)),
    }).toEqual({ valid: true, hasIllegalCharacter: false, legalTextKept: true });
  });

  test("removes XML 1.0-illegal characters from the filename fallback title", () => {
    // #given metadata has no title and the filename fallback contains an illegal character
    const name = "Fallback\u0001_Title.txt";

    // #when
    const xml = bookEntryXml(name, name, { title: "" }, false, 123);

    // #then
    expect({
      valid: XMLValidator.validate(xml),
      hasIllegalCharacter: XML_1_0_ILLEGAL.test(xml),
      title: xml.includes("<title>Fallback Title</title>"),
    }).toEqual({ valid: true, hasIllegalCharacter: false, title: true });
  });
});
