import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * ADR 0112: the Provider response reader is the only workflow source that
 * waits for a provider response, reads its headers or accepts it. A new read
 * that reaches past it would bring back the drift the reader ended.
 */
const ROOT = new URL("../..", import.meta.url).pathname;
/**
 * Verified sources' workflows and the automation runtime. Preview sources
 * (ADR 0047) sit outside canonical admission and declare no provider
 * responses, so they are not scanned.
 */
const SCANNED = ["src/workflows", "src/lib/automation"];
const OWNERS = new Set(["src/workflows/provider-response-reader.ts", "src/workflows/provider-response.ts"]);

const FORBIDDEN: readonly Readonly<{ name: string; pattern: RegExp }>[] = [
  { name: "waitForResponse", pattern: /\bwaitForResponse\b/u },
  { name: "acceptProviderResponse", pattern: /\bacceptProviderResponse\(/u },
  { name: "verifyProviderResponse", pattern: /\bverifyProviderResponse\(/u },
  { name: "allHeaders", pattern: /\.allHeaders\(/u },
  // A request's own headers are the source's to read; a reply's are the reader's.
  { name: "response headers", pattern: /\b(?:response|reply|fetched)\.headers\(\)/iu },
  // ADR 0116: a source reads through the reader it is handed, never one it builds.
  { name: "providerResponseReader", pattern: /\bproviderResponseReader\(/u },
];

/**
 * Uses that are not a provider response a source reads as evidence, each with
 * the number of times its file may use it and why it stays.
 */
const NOT_PROVIDER_RESPONSES: readonly Readonly<{ path: string; name: string; count: number; reason: string }>[] = [
  {
    path: "src/lib/automation/product-collection.ts",
    name: "providerResponseReader",
    count: 1,
    reason: "productCollectionHandle builds each product's reader on the run clock, text port and the product's own validate",
  },
  {
    path: "src/workflows/hncb-netbank-site.ts",
    name: "waitForResponse",
    count: 1,
    reason: "a menu click's dispatch is awaited so the next label is searched after the frames reload; its reply is never read",
  },
  {
    path: "src/workflows/fubon-statements.ts",
    name: "response headers",
    count: 1,
    reason: "the deposit diagnostics record which header names a reply carried, never their values as evidence",
  },
];

function sourceFiles(directory: string): string[] {
  return readdirSync(join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.ts$/u.test(entry.name) && !/\.(?:check|fixtures)\.ts$/u.test(entry.name) ? [path] : [];
  });
}

test("only the Provider response reader waits for, reads the headers of, or accepts a provider response", () => {
  const offenders = SCANNED.flatMap(sourceFiles)
    .map((path) => relative(ROOT, join(ROOT, path)))
    .filter((path) => !OWNERS.has(path))
    .flatMap((path) => {
      const source = readFileSync(join(ROOT, path), "utf8");
      return FORBIDDEN.flatMap(({ name, pattern }) => {
        const uses = source.match(new RegExp(pattern.source, `${pattern.flags}g`))?.length ?? 0;
        const allowed = NOT_PROVIDER_RESPONSES.find((entry) => entry.path === path && entry.name === name)?.count ?? 0;
        return uses > allowed ? [`${path}: ${name} (${uses})`] : [];
      });
    });
  assert.deepEqual(offenders, []);
});

test("every allowed use is still there, so the list cannot outlive its reason", () => {
  for (const { path, name, count } of NOT_PROVIDER_RESPONSES) {
    const { pattern } = FORBIDDEN.find((forbidden) => forbidden.name === name)!;
    const uses = readFileSync(join(ROOT, path), "utf8").match(new RegExp(pattern.source, `${pattern.flags}g`))?.length ?? 0;
    assert.equal(uses, count, `${path}: ${name}`);
  }
});
