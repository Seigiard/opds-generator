import { Feed } from "opds-ts/v1.2";
import type { FeedModel } from "./feed-model.ts";

export function renderXml(model: FeedModel): string {
  const feed = new Feed(model.id, model.title)
    .addSelfLink(model.selfHref, model.kind)
    .addNavigationLink("start", model.startHref)
    .setKind(model.kind)
    .setUpdated(model.updated);

  const skeleton = feed.toXml({ prettyPrint: true });
  const fragments = model.entries.map((e) => e.xml).join("\n");

  // Function replacer: $&, $', $` in fragment text must not act as replace substitution patterns.
  return skeleton.replace("</feed>", () => fragments + "\n</feed>");
}
