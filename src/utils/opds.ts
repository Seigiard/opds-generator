export function stripXmlDeclaration(xml: string): string {
  return xml.replace(/<\?xml[^?]*\?>\s*/g, "").trim();
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function naturalSort(a: string, b: string): number {
  return collator.compare(a, b);
}

export function extractTitle(entryXml: string): string {
  const match = entryXml.match(/<title[^>]*>([\s\S]*?)<\/title>/);
  if (!match?.[1]) return "";

  let title = match[1].trim();

  title = title
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

  return title;
}
