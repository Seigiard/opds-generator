import { expect, test } from "bun:test";
import { isObsoleteSourceReplacement } from "../../../src/lifecycle/engine-source-work.ts";

test("unsupported source replacement classification matches only the engine sentinel", () => {
  // #given source observation errors that can contain operator path names
  const unsupported = { message: "Unsupported source path" };
  const ancestor = { message: "Source ancestor is not a directory" };
  const unsupportedSubstring = { message: "EACCES: permission denied, open '/books/Unsupported source path/Book.fb2'" };
  const ancestorSubstring = { message: "EACCES: permission denied, open '/books/Source ancestor is not a directory/Book.fb2'" };

  // #when cleanup decides whether a failed source observation authorizes obsolete-output removal
  const classification = {
    unsupported: isObsoleteSourceReplacement(unsupported),
    ancestor: isObsoleteSourceReplacement(ancestor),
    unsupportedSubstring: isObsoleteSourceReplacement(unsupportedSubstring),
    ancestorSubstring: isObsoleteSourceReplacement(ancestorSubstring),
  };

  // #then only exact engine sentinels are accepted
  expect(classification).toEqual({ unsupported: true, ancestor: true, unsupportedSubstring: false, ancestorSubstring: false });
});
