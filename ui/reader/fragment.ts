export type FragmentResult =
  | { kind: "ok"; fetchPath: string; folderPath: string; filename: string; ext: string }
  | { kind: "unsupported"; folderPath: string; ext: string }
  | { kind: "invalid" };

const INVALID: FragmentResult = { kind: "invalid" };

/** Any segment made purely of dots — literal or once-more-encoded (`.`, `..`, `%2e%2e`, `.%2e`) — is traversal. */
const DOT_SEGMENT = /^(\.|%2e)+$/i;

/**
 * Validate the reader fragment before any fetch or link construction (R15, KTD-1).
 * The fragment is attacker-influenceable (a forged link): only a same-origin,
 * root-relative, traversal-free book-file path comes out; everything else is invalid.
 * The returned fetchPath is rebuilt from decoded segments via encodeURIComponent, so
 * no percent-encoding chosen by the attacker survives to the wire.
 */
export function parseFragment(rawHash: string, viewable: ReadonlySet<string>, bookExtensions: readonly string[]): FragmentResult {
  const raw = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  if (!raw.startsWith("/")) return INVALID;
  if (raw.startsWith("//")) return INVALID;
  if (raw.includes("\\")) return INVALID;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return INVALID;
  }
  if (decoded.includes("\\")) return INVALID;

  const segments = decoded.slice(1).split("/");
  if (segments.length < 2) return INVALID;
  for (const segment of segments) {
    if (segment === "" || DOT_SEGMENT.test(segment)) return INVALID;
  }

  const extOf = (name: string): string | null => {
    const dot = name.lastIndexOf(".");
    return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
  };

  const leaf = segments[segments.length - 1]!;
  const parent = segments[segments.length - 2]!;
  // Legacy /data (pre doubled-name migration) serves `.../<book>.<ext>/file` symlinks;
  // treat a bare `file` leaf as the book named by its parent so those View links still
  // open instead of hitting the invalid-link state. A `file` leaf never reaches /resync:
  // it is accepted only when the parent carries a viewable extension.
  const leafExt = extOf(leaf);
  const isLegacyFileLeaf = leafExt === null && leaf === "file";
  const ext = leafExt ?? (isLegacyFileLeaf ? extOf(parent) : null);
  if (ext === null) return INVALID;
  const filename = isLegacyFileLeaf ? parent : leaf;

  const encoded = segments.map(encodeURIComponent);
  const fetchPath = `/${encoded.join("/")}`;

  // Belt and braces on top of the string rules: the rebuilt path must resolve inside
  // the origin it is given to, byte-identical, or it never reaches fetch().
  const base = "https://reader.invalid";
  const url = new URL(fetchPath, base);
  if (url.origin !== base || url.pathname !== fetchPath) return INVALID;

  // The data mirror doubles the book name (/folder/Book.epub/Book.epub): the browsable
  // folder sits above the book-data dir, so a trailing book-named dir is dropped too.
  let folderSegments = encoded.slice(0, -1);
  if (folderSegments.length > 0 && bookExtensions.some((e) => parent.toLowerCase().endsWith(`.${e}`))) {
    folderSegments = folderSegments.slice(0, -1);
  }
  const folderPath = folderSegments.length > 0 ? `/${folderSegments.join("/")}/` : "/";

  if (!viewable.has(ext)) return { kind: "unsupported", folderPath, ext };
  return { kind: "ok", fetchPath, folderPath, filename, ext };
}
