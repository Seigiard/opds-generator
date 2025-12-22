export function decodeEntities(str: string): string {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

export function getString(val: unknown): string | undefined {
  if (typeof val === "string") return decodeEntities(val.trim());
  if (typeof val === "object" && val && "#text" in val) {
    return decodeEntities(String((val as { "#text": unknown })["#text"]).trim());
  }
  return undefined;
}

export function getFirstString(val: unknown): string | undefined {
  if (Array.isArray(val)) return getString(val[0]);
  return getString(val);
}

export function getStringArray(val: unknown): string[] | undefined {
  if (!val) return undefined;
  const arr = Array.isArray(val) ? val : [val];
  const result = arr.map(getString).filter((s): s is string => !!s);
  return result.length > 0 ? result : undefined;
}

export function cleanDescription(desc: string | undefined): string | undefined {
  if (!desc) return undefined;
  return desc.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || undefined;
}

export function parseDate(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const match = date.match(/^(\d{4})(?:-(\d{2}))?/);
  if (!match) return undefined;
  return match[2] ? `${match[1]}-${match[2]}` : match[1];
}
