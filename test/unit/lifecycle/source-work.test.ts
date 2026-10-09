import { expect, test } from "bun:test";
import { isUnsupportedSourceReplacement } from "../../../src/lifecycle/engine-source-work.ts";

test("unsupported source replacement classification matches only the engine sentinel", () => {
  // #given source observation errors that can contain operator path names
  const sentinel = { message: "Unsupported source path" };
  const readFailure = { message: "EACCES: permission denied, open '/books/Unsupported source path/Book.fb2'" };

  // #when cleanup decides whether a failed source observation authorizes obsolete-output removal
  const classification = {
    sentinel: isUnsupportedSourceReplacement(sentinel),
    readFailure: isUnsupportedSourceReplacement(readFailure),
  };

  // #then only the engine's exact unsupported-source sentinel is accepted
  expect(classification).toEqual({ sentinel: true, readFailure: false });
});
