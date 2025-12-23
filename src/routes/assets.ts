import { join } from "node:path";
import { config } from "../config.ts";
import { IMAGE_CACHE_MAX_AGE, PLACEHOLDER_CACHE_MAX_AGE } from "../constants.ts";

const PLACEHOLDER_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
  0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x78, 0x78, 0x78, 0x00, 0x00, 0x02, 0x3d, 0x01, 0x26, 0xf8, 0x7e, 0xb1, 0xa8,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const imageCacheControl = config.devMode ? "no-store" : `public, max-age=${IMAGE_CACHE_MAX_AGE}`;
const placeholderCacheControl = config.devMode ? "no-store" : `public, max-age=${PLACEHOLDER_CACHE_MAX_AGE}`;

export async function handleDownload(fullPath: string, fileName: string): Promise<Response> {
  const file = Bun.file(fullPath);

  if (await file.exists()) {
    return new Response(file, {
      headers: {
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  }

  return new Response("File not found", { status: 404 });
}

export async function handleCover(dataDir: string): Promise<Response> {
  const coverFile = Bun.file(join(dataDir, "cover.jpg"));

  if (await coverFile.exists()) {
    return new Response(coverFile, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": imageCacheControl,
      },
    });
  }

  return new Response(PLACEHOLDER_PNG, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": placeholderCacheControl,
    },
  });
}

export async function handleThumbnail(dataDir: string): Promise<Response> {
  const thumbFile = Bun.file(join(dataDir, "thumb.jpg"));

  if (await thumbFile.exists()) {
    return new Response(thumbFile, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": imageCacheControl,
      },
    });
  }

  return new Response(PLACEHOLDER_PNG, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": placeholderCacheControl,
    },
  });
}
