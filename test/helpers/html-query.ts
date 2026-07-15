import { XMLParser } from "fast-xml-parser";

export interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  /** Concatenated text of all descendant text nodes (entities decoded). */
  text: string;
}

const orderedParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
});

const stripDoctype = (html: string): string => html.replace(/^<!DOCTYPE html>\s*/i, "");

/**
 * Parse rendered HTML into a tree of element nodes. The renderer emits XML-well-formed
 * markup, so preserveOrder gives a faithful document-order tree. Tests query structure
 * (element counts, class presence, id/href pairing, ordering, containment) instead of
 * byte layout — byte protection lives in the golden gate.
 */
export function parseHtml(html: string): HtmlNode[] {
  return build(orderedParser.parse(stripDoctype(html)) as OrderedNode[]);
}

/** Depth-first, document-order list of every element under `roots`. */
export function allElements(roots: HtmlNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  const visit = (node: HtmlNode): void => {
    out.push(node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return out;
}

export function flattenElements(html: string): HtmlNode[] {
  return allElements(parseHtml(html));
}

export function byClass(roots: HtmlNode[], className: string): HtmlNode[] {
  return allElements(roots).filter((el) => el.attrs.class === className);
}

/** All attribute name/value pairs across every element, in document order. */
export function collectAttributes(html: string): Array<{ name: string; value: string; tag: string }> {
  return flattenElements(html).flatMap((el) => Object.entries(el.attrs).map(([name, value]) => ({ name, value, tag: el.tag })));
}

interface OrderedNode {
  ":@"?: Record<string, string>;
  [key: string]: unknown;
}

function build(nodes: OrderedNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of nodes) {
    const tag = Object.keys(node).find((k) => k !== ":@");
    if (!tag || tag === "#text") continue;

    const attrs: Record<string, string> = {};
    for (const [key, value] of Object.entries(node[":@"] ?? {})) {
      attrs[key.replace(/^@_/, "")] = String(value);
    }

    const rawChildren = (node[tag] as OrderedNode[]) ?? [];
    out.push({ tag, attrs, children: build(rawChildren), text: collectText(rawChildren) });
  }
  return out;
}

function collectText(nodes: OrderedNode[]): string {
  let text = "";
  for (const node of nodes) {
    if ("#text" in node) {
      text += String(node["#text"]);
    } else {
      const tag = Object.keys(node).find((k) => k !== ":@");
      if (tag) text += collectText((node[tag] as OrderedNode[]) ?? []);
    }
  }
  return text;
}
