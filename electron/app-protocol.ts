import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { Protocol } from "electron";

/** The renderer's own scheme and origin: a standard, secure origin instead of file://. */
export const APP_SCHEME = "app";
export const APP_HOST = "octopusbeak";
export const RENDERER_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;
/** A blank page in the app origin, so main can reach its storage without running the renderer. */
export const STORAGE_MIGRATION_URL = `${APP_SCHEME}://${APP_HOST}/__storage-migration.html`;
const STORAGE_MIGRATION_PAGE = "<!doctype html><meta charset=\"utf-8\"><title></title>";

/** Registered before `ready`, as Electron requires for privileged schemes. */
export const APP_SCHEME_PRIVILEGES = Object.freeze({
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
});

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** The file under `buildDirectory` an app:// URL names, or null for another host or a path outside it. */
export function appFilePath(buildDirectory: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  const root = resolve(buildDirectory);
  const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  const inside = relative(root, file);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
  return file;
}

export async function appFileResponse(buildDirectory: string, requestUrl: string): Promise<Response> {
  if (requestUrl === STORAGE_MIGRATION_URL) {
    return new Response(STORAGE_MIGRATION_PAGE, { headers: { "content-type": CONTENT_TYPES[".html"]! } });
  }
  const file = appFilePath(buildDirectory, requestUrl);
  if (!file) return new Response(null, { status: 404 });
  try {
    const body = await readFile(file);
    return new Response(body, {
      headers: { "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

/** Serves the built renderer at app://octopusbeak/ from `buildDirectory`. */
export function serveRenderer(protocol: Pick<Protocol, "handle">, buildDirectory: string) {
  protocol.handle(APP_SCHEME, (request) => appFileResponse(buildDirectory, request.url));
}
