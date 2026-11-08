import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Packages that only run in main or its workers; a renderer bundle that reaches one breaks at runtime. */
export const SERVER_ONLY_PACKAGES = Object.freeze([
  "electron",
  "playwright",
  "playwright-core",
  "@electric-sql/pglite",
  "onnxruntime-node",
  "tesseract.js",
  "sherpa-onnx-node",
  "mpg123-decoder",
]);

const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const toPosix = (path) => path.split(sep).join("/");

function scriptSource(file, text) {
  if (!file.endsWith(".svelte")) return text;
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join("\n");
}

function typeOnly(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    if (clause.name) return false;
    const bindings = clause.namedBindings;
    return Boolean(bindings && ts.isNamedImports(bindings)
      && bindings.elements.length > 0
      && bindings.elements.every((element) => element.isTypeOnly));
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return true;
    const clause = node.exportClause;
    return Boolean(clause && ts.isNamedExports(clause)
      && clause.elements.length > 0
      && clause.elements.every((element) => element.isTypeOnly));
  }
  return false;
}

/** Every specifier a module loads at runtime: static and side-effect imports, re-exports and import(). */
export function runtimeSpecifiers(file, text) {
  const source = ts.createSourceFile(file, scriptSource(file, text), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !typeOnly(node)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/** A repo file for a relative or `$lib` specifier, a package name for a bare one, or null for a virtual module. */
export function resolveSpecifier(fromFile, specifier) {
  let target;
  if (specifier.startsWith(".")) target = resolve(REPO_ROOT, dirname(fromFile), specifier);
  else if (specifier === "$lib" || specifier.startsWith("$lib/")) target = join(REPO_ROOT, "src/lib", specifier.slice(5));
  else if (specifier.startsWith("$")) return null;
  else return { package: specifier };
  for (const candidate of [target, `${target}.ts`, join(target, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return { file: toPosix(relative(REPO_ROOT, candidate)) };
  }
  return { file: toPosix(relative(REPO_ROOT, target)) };
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function isCode(file) {
  return /\.(ts|svelte|js|mjs)$/.test(file);
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(join(REPO_ROOT, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

export const isCheckFile = (file) => /\.check\.|check-support|\.fixtures?\.|-fixture\./.test(file);

/** Why a module reached from the renderer may not be bundled into it, or null when it may. */
export function rendererRefusal(resolved) {
  if (resolved.package !== undefined) {
    if (NODE_BUILTINS.has(resolved.package)) return "a Node built-in";
    if (SERVER_ONLY_PACKAGES.includes(packageName(resolved.package))) return "a main-process package";
    return null;
  }
  if (resolved.file.startsWith("electron/")) return "Electron main code";
  if (resolved.file.split("/").includes("server")) return "a server module";
  return null;
}

/**
 * Follows runtime imports from every SvelteKit route file and returns each
 * edge that brings main-only code into the renderer, with the chain from the
 * route that reached it.
 */
export function rendererViolations({ entries = walk("src/routes").filter((file) => /\/\+[^/]*\.(svelte|ts)$/.test(file)), read = (file) => readFileSync(join(REPO_ROOT, file), "utf8") } = {}) {
  const reachedFrom = new Map(entries.map((entry) => [entry, null]));
  const queue = [...entries];
  const violations = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (!isCode(file)) continue;
    for (const specifier of runtimeSpecifiers(file, read(file))) {
      const resolved = resolveSpecifier(file, specifier);
      if (!resolved) continue;
      const refusal = rendererRefusal(resolved);
      if (refusal) {
        const chain = [];
        for (let at = file; at; at = reachedFrom.get(at)) chain.unshift(at);
        violations.push({ file, specifier, refusal, chain });
        continue;
      }
      if (resolved.file && !reachedFrom.has(resolved.file)) {
        reachedFrom.set(resolved.file, file);
        queue.push(resolved.file);
      }
    }
  }
  return { violations, reached: reachedFrom.size };
}

/** Every src/ module that loads the electron package; Electron capabilities reach src/ as injected ports (ADR 0073). */
export function electronImportsInSrc({ files = walk("src").filter((file) => isCode(file) && !isCheckFile(file)), read = (file) => readFileSync(join(REPO_ROOT, file), "utf8") } = {}) {
  return files.flatMap((file) => runtimeSpecifiers(file, read(file))
    .filter((specifier) => packageName(specifier) === "electron")
    .map((specifier) => ({ file, specifier })));
}
