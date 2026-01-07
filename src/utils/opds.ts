export function stripXmlDeclaration(xml: string): string {
  return xml.replace(/<\?xml[^?]*\?>\s*/g, "").trim();
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function naturalSort(a: string, b: string): number {
  return collator.compare(a, b);
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function extractTitle(entryXml: string): string {
  const match = entryXml.match(/<title[^>]*>([\s\S]*?)<\/title>/);
  if (!match?.[1]) return "";
  return decodeXmlEntities(match[1].trim());
}

export function extractAuthor(entryXml: string): string | undefined {
  const match = entryXml.match(/<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/);
  if (!match?.[1]) return undefined;
  return decodeXmlEntities(match[1].trim());
}
