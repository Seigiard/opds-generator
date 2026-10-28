import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

/** Sync-narrowed hono/html tag: auto-escapes interpolated values. An async interpolation would make hono return a Promise — forbidden by R10, enforced here at runtime. */
export const frag = (strings: TemplateStringsArray, ...values: unknown[]): HtmlEscapedString => {
  const result = html(strings, ...values);

  if (result instanceof Promise) throw new Error("frag: async interpolation forbidden (R10)");

  return result;
};

export type Fragment = HtmlEscapedString | string;

/** Interleave fragments with a literal separator instead of `.join()`, which would strip the escaped marker (KTD-3). */
export function interleave(items: Fragment[], separator: string): Fragment[] {
  return items.flatMap((item, i) => (i === 0 ? [item] : [separator, item]));
}
