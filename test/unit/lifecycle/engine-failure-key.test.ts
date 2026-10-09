import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildContext } from "../../../src/context.ts";
import { failureKey } from "../../../src/lifecycle/engine-failure-key.ts";
import { CatalogueEvent } from "../../../src/processing/effect-handler.ts";

test("folder failure keys use one canonical identity for the same output path", async () => {
  // #given source and output roots whose configured spelling can vary
  const ctx = await buildContext();
  const filesPath = "/tmp/opds-source";
  const dataPath = "/tmp/opds-data/";
  const key = failureKey({ ...ctx, config: { ...ctx.config, filesPath, dataPath } });

  // #when root folder work and descendant cleanup work identify their outputs
  const rootWithSlash = key(CatalogueEvent.FolderMetaSyncRequested({ path: dataPath }));
  const rootWithoutSlash = key(CatalogueEvent.FolderMetaSyncRequested({ path: "/tmp/opds-data" }));
  const childDeletion = key(CatalogueEvent.FolderDeleted({ parent: filesPath, name: "Fiction" }));
  const childRefresh = key(CatalogueEvent.FolderMetaSyncRequested({ path: join("/tmp/opds-data", "Fiction") }));

  // #then equal output folders share one retained-failure key
  expect({ rootWithSlash, rootWithoutSlash, childDeletion, childRefresh }).toEqual({
    rootWithSlash: "folder:/tmp/opds-data",
    rootWithoutSlash: "folder:/tmp/opds-data",
    childDeletion: "folder:/tmp/opds-data/Fiction",
    childRefresh: "folder:/tmp/opds-data/Fiction",
  });
});
