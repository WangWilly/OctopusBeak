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

const ASSET = /\.(webp|png|svg|jpe?g|gif|avif|ico|css|json|txt|woff2?)(\?.*)?$/u;
const CODE = /\.(ts|svelte|js|mjs|cjs)(\?.*)?$/u;

/**
 * Whether a declaration loads nothing at runtime. `import type` and
 * `export type` never do. Under the repo's `verbatimModuleSyntax`, a .ts file
 * keeps `import { type A } from "x"` as `import "x"`, so only the Svelte
 * compiler, which drops unused imports, erases one whose names are all types.
 */
function erased(node, file) {
  const svelte = file.endsWith(".svelte");
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    if (clause.name) return false;
    const bindings = clause.namedBindings;
    return svelte && Boolean(bindings && ts.isNamedImports(bindings)
      && bindings.elements.length > 0
      && bindings.elements.every((element) => element.isTypeOnly));
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return true;
    const clause = node.exportClause;
    return svelte && Boolean(clause && ts.isNamedExports(clause)
      && clause.elements.length > 0
      && clause.elements.every((element) => element.isTypeOnly));
  }
  return false;
}

const isImportMetaUrl = (node) => ts.isPropertyAccessExpression(node)
  && ts.isMetaProperty(node.expression) && node.name.text === "url";

/**
 * What a module loads at runtime: `{ specifier }` for each static,
 * side-effect, re-export, `import()`, `require()` and worker-URL reference,
 * and `{ unchecked }` for a form the walk cannot follow, such as a computed
 * `import()` or an `import.meta.glob` of code, so a check can refuse it.
 */
export function moduleReferences(file, text) {
  const source = ts.createSourceFile(file, scriptSource(file, text), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const references = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!erased(node, file)) references.push({ specifier: node.moduleSpecifier.text });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const [first] = node.arguments;
      const dynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(callee) && callee.text === "require";
      const glob = ts.isPropertyAccessExpression(callee) && callee.name.text === "glob"
        && ts.isMetaProperty(callee.expression);
      if (dynamicImport || requireCall) {
        if (first && ts.isStringLiteralLike(first)) references.push({ specifier: first.text });
        else references.push({ unchecked: `a computed ${dynamicImport ? "import()" : "require()"}` });
      } else if (glob) {
        const patterns = first && ts.isArrayLiteralExpression(first) ? first.elements : [first];
        const assetsOnly = patterns.every((pattern) => pattern && ts.isStringLiteralLike(pattern) && ASSET.test(pattern.text));
        if (!assetsOnly) references.push({ unchecked: "an import.meta.glob that can match code" });
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL") {
      const [target, base] = node.arguments ?? [];
      if (target && base && isImportMetaUrl(base)) {
        if (!ts.isStringLiteralLike(target)) references.push({ unchecked: "a computed new URL(…, import.meta.url)" });
        else if (CODE.test(target.text)) references.push({ specifier: target.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

/** The specifiers `moduleReferences` can follow. */
export function runtimeSpecifiers(file, text) {
  return moduleReferences(file, text).flatMap((reference) => (reference.specifier === undefined ? [] : [reference.specifier]));
}

/** A repo file for a relative or `$lib` specifier, a package name for a bare one, or null for a virtual module. */
const isRepoFile = (path) => existsSync(path) && statSync(path).isFile();

export function resolveSpecifier(fromFile, specifier, isFile = isRepoFile) {
  let target;
  if (specifier.startsWith(".")) target = resolve(REPO_ROOT, dirname(fromFile), specifier);
  else if (specifier === "$lib" || specifier.startsWith("$lib/")) target = join(REPO_ROOT, "src/lib", specifier.slice(5));
  else if (specifier.startsWith("$")) return null;
  else return { package: specifier };
  const bare = target.replace(/\?.*$/u, "");
  for (const candidate of [bare, `${bare}.ts`, join(bare, "index.ts")]) {
    if (isFile(candidate)) return { file: toPosix(relative(REPO_ROOT, candidate)) };
  }
  return { unresolved: toPosix(relative(REPO_ROOT, bare)) };
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
  if (resolved.file.startsWith("src/lib/pglite-rpc/")) return "the PGlite RPC protocol layer, which runs in main and its workers";
  if (resolved.file.split("/").includes("server")) return "a server module";
  return null;
}

/**
 * Follows runtime imports from every SvelteKit route file and returns each
 * edge that brings main-only code into the renderer, with the chain from the
 * route that reached it.
 */
export function rendererEntries() {
  const routes = walk("src/routes")
    .filter((file) => /\/\+[^/]*\.(svelte|ts)$/u.test(file) && !/(\.server|\/\+server)\.ts$/u.test(file));
  const hooks = ["src/hooks.client.ts", "src/hooks.ts"].filter((file) => existsSync(join(REPO_ROOT, file)));
  return [...routes, ...hooks];
}

export function rendererViolations({
  entries = rendererEntries(),
  read = (file) => readFileSync(join(REPO_ROOT, file), "utf8"),
  isFile = isRepoFile,
} = {}) {
  const reachedFrom = new Map(entries.map((entry) => [entry, null]));
  const queue = [...entries];
  const violations = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (!isCode(file)) continue;
    const chainTo = () => {
      const chain = [];
      for (let at = file; at; at = reachedFrom.get(at)) chain.unshift(at);
      return chain;
    };
    for (const reference of moduleReferences(file, read(file))) {
      if (reference.unchecked) {
        violations.push({ file, specifier: reference.unchecked, refusal: "a form this check cannot follow", chain: chainTo() });
        continue;
      }
      const { specifier } = reference;
      const resolved = resolveSpecifier(file, specifier, isFile);
      if (!resolved) continue;
      if (resolved.unresolved !== undefined) {
        violations.push({ file, specifier, refusal: "a path that names no file", chain: chainTo() });
        continue;
      }
      if (resolved.file && ASSET.test(resolved.file) && !CODE.test(resolved.file)) continue;
      const refusal = rendererRefusal(resolved);
      if (refusal) {
        violations.push({ file, specifier, refusal, chain: chainTo() });
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

/** Every module specifier a file names, type-only imports and `import("…")` types included. */
function namedSpecifiers(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) specifiers.push(node.arguments[0].text);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) specifiers.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/**
 * Every src/ledger module, checks included, that names a src/workflows module,
 * even for types: the ledger owns what it admits, and a workflow builds it.
 */
export function ledgerImportsOfWorkflows({
  files = walk("src/ledger").filter((file) => /\.(ts|mjs|js)$/.test(file)),
  read = (file) => readFileSync(join(REPO_ROOT, file), "utf8"),
  isFile = isRepoFile,
} = {}) {
  return files.flatMap((file) => namedSpecifiers(file, read(file))
    .filter((specifier) => resolveSpecifier(file, specifier, isFile)?.file?.startsWith("src/workflows/"))
    .map((specifier) => ({ file, specifier })));
}

/**
 * Every non-check src/ module that names a module under electron/, even for
 * types: src/ is the shared code both processes run, and electron/ holds only
 * main-process wiring (ADR 0133). Checks are exempt because integration checks
 * wire real electron RPC servers.
 */
export function srcImportsOfElectron({
  files = walk("src").filter(isCode),
  read = (file) => readFileSync(join(REPO_ROOT, file), "utf8"),
  isFile = isRepoFile,
} = {}) {
  const namesElectron = (resolved) => (resolved?.file ?? resolved?.unresolved)?.startsWith("electron/");
  return files.filter((file) => !isCheckFile(file)).flatMap((file) => namedSpecifiers(file, scriptSource(file, read(file)))
    .filter((specifier) => namesElectron(resolveSpecifier(file, specifier, isFile)))
    .map((specifier) => ({ file, specifier })));
}
