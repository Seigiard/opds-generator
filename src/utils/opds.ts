export function stripXmlDeclaration(xml: string): string {
  return xml.replace(/<\?xml[^?]*\?>\s*/g, "").trim();
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function naturalSort(a: string, b: string): number {
  return collator.compare(a, b);
}
