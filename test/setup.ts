import { beforeAll, afterAll } from "bun:test";
import { rm, mkdir } from "node:fs/promises";

const TEST_DATA_DIR = "/tmp/opds-test-data";

beforeAll(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
  await mkdir(TEST_DATA_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
});
