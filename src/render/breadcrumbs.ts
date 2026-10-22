export interface Crumb {
  readonly label: string;
  readonly href: string;
}

/** Derive folder breadcrumbs from a browser pathname without changing its URL encoding. */
export function breadcrumbsFor(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: Crumb[] = [];

  for (let index = 0; index < segments.length; index++) {
    const encodedPath = `/${segments.slice(0, index + 1).join("/")}/`;
    const encodedSegment = segments[index]!;

    let label: string;

    try {
      label = decodeURIComponent(encodedSegment);
    } catch {
      label = encodedSegment;
    }

    crumbs.push({ label, href: encodedPath });
  }

  return crumbs;
}
