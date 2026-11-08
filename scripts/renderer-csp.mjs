import { createHash } from "node:crypto";

/** Every <script> element, with its attributes and body. A hash covers the body, whatever the attributes. */
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const HAS_SRC = /(^|\s)src\s*=/i;

/**
 * The renderer's Content Security Policy. Scripts run only from the App's own
 * files or as the exact inline bootstrap hashed here; the renderer fetches no
 * network resource, since main answers every request over IPC.
 */
export function rendererCsp(inlineScripts) {
  const hashes = inlineScripts.map(
    (script) => `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`,
  );
  return [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(" ")}`.trimEnd(),
    // Svelte writes style attributes and transition rules at runtime.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** Adds the policy as the first head element, hashing the page's final inline scripts. */
export function withRendererCsp(html) {
  if (html.includes('http-equiv="Content-Security-Policy"')) {
    throw new Error("The renderer page already declares a Content Security Policy.");
  }
  const inlineScripts = [...html.matchAll(SCRIPT)]
    .filter(([, attributes]) => !HAS_SRC.test(attributes))
    .map(([, , body]) => body);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${rendererCsp(inlineScripts)}" />`;
  const head = html.indexOf("<head>");
  if (head === -1) throw new Error("The renderer page has no <head>.");
  const at = head + "<head>".length;
  return `${html.slice(0, at)}\n    ${meta}${html.slice(at)}`;
}
