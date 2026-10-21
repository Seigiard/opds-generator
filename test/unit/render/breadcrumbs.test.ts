import { describe, expect, test } from "bun:test";
import { breadcrumbsFor } from "../../../src/render/breadcrumbs.ts";

describe("breadcrumbsFor", () => {
  test("returns no crumbs for the catalogue root", () => {
    // #given the root folder path
    const pathname = "/";
    // #when breadcrumbs are derived
    const crumbs = breadcrumbsFor(pathname);
    // #then there are no folder segments
    expect(crumbs).toEqual([]);
  });

  test("derives one crumb for a first-level folder", () => {
    // #given a first-level folder path
    const pathname = "/comics/";
    // #when breadcrumbs are derived
    const crumbs = breadcrumbsFor(pathname);
    // #then its link includes the trailing slash
    expect(crumbs).toEqual([{ label: "comics", href: "/comics/" }]);
  });

  test("derives cumulative links for a deeply nested folder", () => {
    // #given a nested folder path
    const pathname = "/comics/Batman/";
    // #when breadcrumbs are derived
    const crumbs = breadcrumbsFor(pathname);
    // #then each link ends at its own segment
    expect(crumbs).toEqual([
      { label: "comics", href: "/comics/" },
      { label: "Batman", href: "/comics/Batman/" },
    ]);
  });

  test("decodes a non-ASCII label while preserving its encoded href", () => {
    // #given an encoded Cyrillic folder path
    const pathname = "/%D0%9A%D0%BD%D0%B8%D0%B3%D0%B8/";
    // #when breadcrumbs are derived
    const crumbs = breadcrumbsFor(pathname);
    // #then the reader sees decoded text without changing the URL
    expect(crumbs).toEqual([{ label: "Книги", href: "/%D0%9A%D0%BD%D0%B8%D0%B3%D0%B8/" }]);
  });

  test("tolerates a folder path without a trailing slash", () => {
    // #given a nested folder path without its final slash
    const pathname = "/comics/Batman";
    // #when breadcrumbs are derived
    const crumbs = breadcrumbsFor(pathname);
    // #then all folder links are normalized with trailing slashes
    expect(crumbs).toEqual([
      { label: "comics", href: "/comics/" },
      { label: "Batman", href: "/comics/Batman/" },
    ]);
  });
});
