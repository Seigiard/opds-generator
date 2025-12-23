import type { FormatHandler, FormatHandlerRegistration, BookMetadata } from "./types.ts";

async function createTxtHandler(filePath: string): Promise<FormatHandler | null> {
  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) return null;

    return {
      getMetadata(): BookMetadata {
        return { title: "" };
      },
      async getCover() {
        return null;
      },
    };
  } catch {
    return null;
  }
}

export const txtHandlerRegistration: FormatHandlerRegistration = {
  extensions: ["txt"],
  create: createTxtHandler,
};
