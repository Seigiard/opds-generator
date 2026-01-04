import { normalize, join, isAbsolute } from "node:path";
import { config } from "../config.ts";

export function resolveSafePath(basePath: string, userPath: string): string | null {
	if (userPath.includes("\x00")) return null;
	if (isAbsolute(userPath)) return null;
	const fullPath = normalize(join(basePath, userPath));
	const normalizedBase = normalize(basePath);
	if (!fullPath.startsWith(normalizedBase + "/") && fullPath !== normalizedBase) {
		return null;
	}
	return fullPath;
}

const STATIC_PATH = "static";

export function createRouter() {
	return async function router(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const path = url.pathname;

		// Root and /opds → feed.xml
		if (path === "/" || path === "/opds") {
			return Response.redirect("/feed.xml", 302);
		}

		// Static files from /static folder
		if (path.startsWith("/static/")) {
			const fileName = path.slice("/static/".length);
			const safePath = resolveSafePath(STATIC_PATH, fileName);
			if (!safePath) {
				return new Response("Invalid path", { status: 400 });
			}
			const file = Bun.file(safePath);
			if (!(await file.exists())) {
				return new Response("Not found", { status: 404 });
			}
			return new Response(file);
		}

		// Static files from /data
		const userPath = decodeURIComponent(path.slice(1)); // remove leading /
		const safePath = resolveSafePath(config.dataPath, userPath);
		if (!safePath) {
			return new Response("Invalid path", { status: 400 });
		}

		const file = Bun.file(safePath);
		if (!(await file.exists())) {
			return new Response("Not found", { status: 404 });
		}

		return new Response(file);
	};
}
