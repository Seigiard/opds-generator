import { readZipEntry } from "./zip.ts";

export interface EpubMeta {
  title?: string;
  author?: string;
  description?: string;
  coverPath?: string;
}

export async function extractEpubMeta(filePath: string): Promise<EpubMeta> {
  const result: EpubMeta = {};

  const container = await readZipEntry(filePath, "META-INF/container.xml");
  if (!container) return result;

  const opfPath = parseRootfile(container);
  if (!opfPath) return result;

  const opf = await readZipEntry(filePath, opfPath);
  if (!opf) return result;

  result.title = parseXmlTag(opf, "dc:title");
  result.author = parseXmlTag(opf, "dc:creator");
  result.description = parseDescription(opf);
  result.coverPath = parseCoverPath(opf, opfPath);

  return result;
}

function parseRootfile(xml: string): string | null {
  const match = xml.match(/rootfile[^>]+full-path="([^"]+)"/);
  return match?.[1] ?? null;
}

function parseXmlTag(xml: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i");
  const match = xml.match(regex);
  return match?.[1]?.trim();
}

function parseDescription(xml: string): string | undefined {
  const raw = parseXmlTag(xml, "dc:description");
  if (!raw) return undefined;

  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCoverPath(opf: string, opfPath: string): string | undefined {
  const coverMeta = opf.match(/<meta[^>]+name="cover"[^>]+content="([^"]+)"/);
  if (!coverMeta) return undefined;

  const coverId = coverMeta[1];

  const itemRegex = new RegExp(`<item[^>]+id="${coverId}"[^>]+href="([^"]+)"`, "i");
  const itemMatch = opf.match(itemRegex);
  if (!itemMatch) return undefined;

  const coverHref = itemMatch[1];

  const opfDir = opfPath.replace(/[^/]+$/, "");
  return opfDir + coverHref;
}
