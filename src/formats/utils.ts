import { XMLParser } from "fast-xml-parser";
import * as v from "valibot";
import { xmlFields, xmlStringSchema, xmlNumberSchema, xmlBooleanSchema } from "./xml-value.ts";
import type { XmlValue } from "./xml-value.ts";

export function createXmlParser(arrayElements: string[]): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    isArray: (name) => arrayElements.includes(name),
  });
}

const HTML_ENTITIES = new Map(
  Object.entries({
    // XML standard entities
    lt: "<",
    gt: ">",
    amp: "&",
    quot: '"',
    apos: "'",
    // Typography
    mdash: "—",
    ndash: "–",
    hellip: "…",
    bull: "•",
    middot: "·",
    laquo: "«",
    raquo: "»",
    // Quotes
    ldquo: "\u201C",
    rdquo: "\u201D",
    lsquo: "\u2018",
    rsquo: "\u2019",
    sbquo: "\u201A",
    bdquo: "\u201E",
    // Spaces
    nbsp: "\u00A0",
    ensp: "\u2002",
    emsp: "\u2003",
    thinsp: "\u2009",
    // Symbols
    copy: "©",
    reg: "®",
    trade: "™",
    deg: "°",
    plusmn: "±",
    times: "×",
    divide: "÷",
    para: "¶",
    sect: "§",
    dagger: "†",
    Dagger: "‡",
    permil: "‰",
    // Currency
    euro: "€",
    pound: "£",
    yen: "¥",
    cent: "¢",
    // Arrows
    larr: "←",
    rarr: "→",
    uarr: "↑",
    darr: "↓",
  }),
);

export function decodeEntities(str: string): string {
  return str
    .replace(/&([a-zA-Z]+);/g, (match, name) => HTML_ENTITIES.get(name) ?? match)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

export function getString(val: XmlValue | undefined): string | undefined {
  const text = v.safeParse(xmlStringSchema, val);

  if (text.success) return decodeEntities(text.output.trim());

  if (v.is(xmlNumberSchema, val) || v.is(xmlBooleanSchema, val)) return String(val);

  const fields = xmlFields(val);

  if (fields && "#text" in fields) {
    return decodeEntities(String(fields["#text"]).trim());
  }

  return undefined;
}

export function getFirstString(val: XmlValue | undefined): string | undefined {
  if (Array.isArray(val) && val.length > 0) return getString(val[0]);

  return getString(val);
}

export function getStringArray(val: XmlValue | undefined): string[] | undefined {
  if (!val) return undefined;
  const arr = Array.isArray(val) ? val : [val];
  const result = arr.map(getString).filter((s): s is string => !!s);

  return result.length > 0 ? result : undefined;
}

export function cleanDescription(desc: string | undefined): string | undefined {
  if (!desc) return undefined;

  return (
    desc
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim() || undefined
  );
}

export function parseDate(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const match = date.match(/^(\d{4})(?:-(\d{2}))?/);

  if (!match) return undefined;

  return match[2] ? `${match[1]}-${match[2]}` : match[1];
}
