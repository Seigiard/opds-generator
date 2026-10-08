import { existsSync, readFileSync, writeFileSync } from "node:fs";

const gate = process.env.GATE_DIR;

const holdsPath = `${gate}/holds.json`;

function holding(destination: string): boolean {
  if (!existsSync(holdsPath)) return false;

  try {
    const holds: unknown = JSON.parse(readFileSync(holdsPath, "utf8"));

    return Array.isArray(holds) && holds.includes(destination);
  } catch {
    // The test replaces the file atomically; an unreadable moment means "keep holding".
    return true;
  }
}

// Test-only: hold one named write until the test removes it from holds.json. Everything else runs unchanged.
if (gate) {
  const write = Bun.write.bind(Bun);

  // SAFETY: the wrapper forwards its arguments unchanged to the original and only adds an earlier wait, so the signature is preserved.
  Bun.write = (async (
    destination: Parameters<typeof Bun.write>[0],
    data: Parameters<typeof Bun.write>[1],
    options?: Parameters<typeof Bun.write>[2],
  ) => {
    // Only plain path strings can match a hold; file and stream destinations stringify to something else.
    const path = String(destination);

    if (holding(path)) {
      writeFileSync(`${gate}/entered-${path.replaceAll("/", "_")}`, String(process.pid));

      while (holding(path)) await Bun.sleep(50);
    }

    return write(destination, data, options);
  }) as typeof Bun.write;
}
