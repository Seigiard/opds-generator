/**
 * Auto-escaping neutralizes markup, not schemes; drop anything but http(s)/relative/fragment to `#` (KTD-4, R11).
 * Strip ASCII control chars first: browsers ignore C0/DEL bytes when resolving a scheme, so `java\tscript:` would
 * reconstitute to `javascript:` after the naive scheme regex let it through raw.
 */
export function safeHref(href: string): string {
  // oxlint-disable-next-line no-control-regex -- deliberate: strip C0/DEL bytes that browsers ignore during scheme resolution
  const trimmed = href.trim().replace(/[\u0000-\u001F\u007F]/g, "");

  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return trimmed;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);

  if (scheme) return scheme[1]!.toLowerCase() === "http" || scheme[1]!.toLowerCase() === "https" ? trimmed : "#";

  return trimmed;
}
