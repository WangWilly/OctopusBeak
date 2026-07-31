import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;

function yamlFiles(path, compositeActionsOnly = false) {
  if (!existsSync(path)) return [];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...yamlFiles(entryPath, compositeActionsOnly));
      continue;
    }
    const isYaml = /\.ya?ml$/i.test(entry.name);
    const isCompositeAction = /^action\.ya?ml$/i.test(entry.name);
    if (entry.isFile() && isYaml && (!compositeActionsOnly || isCompositeAction)) {
      files.push(entryPath);
    }
  }
  return files;
}

function actionYamlFiles(rootDir) {
  return [
    ...yamlFiles(join(rootDir, ".github", "workflows")),
    ...yamlFiles(join(rootDir, ".github", "actions"), true),
  ];
}

function lineNumberAt(content, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content[index] === "\n") line += 1;
  }
  return line;
}

function actionReferences(document, content) {
  const root = document.toJS();
  const references = [];

  function add(path, value) {
    if (typeof value !== "string") return;
    const node = document.getIn(path, true);
    references.push({
      reference: value,
      line: lineNumberAt(content, node?.range?.[0] ?? 0),
    });
  }

  if (root?.jobs && typeof root.jobs === "object") {
    for (const [jobName, job] of Object.entries(root.jobs)) {
      if (!job || typeof job !== "object") continue;
      add(["jobs", jobName, "uses"], job.uses);
      if (!Array.isArray(job.steps)) continue;
      job.steps.forEach((step, index) => {
        if (step && typeof step === "object") {
          add(["jobs", jobName, "steps", index, "uses"], step.uses);
        }
      });
    }
  }

  if (Array.isArray(root?.runs?.steps)) {
    root.runs.steps.forEach((step, index) => {
      if (step && typeof step === "object") {
        add(["runs", "steps", index, "uses"], step.uses);
      }
    });
  }

  return references;
}

export function unpinnedActionReferences(rootDir) {
  const violations = [];

  for (const path of actionYamlFiles(rootDir)) {
    const content = readFileSync(path, "utf8");
    const document = parseDocument(content);
    if (document.errors.length > 0) {
      throw new Error(`${path}: invalid YAML: ${document.errors[0].message}`);
    }

    for (const { reference, line } of actionReferences(document, content)) {
      if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
      const separator = reference.lastIndexOf("@");
      const revision = separator === -1 ? "" : reference.slice(separator + 1);
      if (FULL_COMMIT_SHA.test(revision)) continue;
      violations.push({ path, line, reference });
    }
  }

  return violations;
}

export function checkActionsPinned(rootDir) {
  const violations = unpinnedActionReferences(rootDir);
  if (violations.length === 0) return;

  for (const violation of violations) {
    console.error(
      `${violation.path}:${violation.line}: action must use a full commit SHA: ${violation.reference}`,
    );
  }
  throw new Error(`${violations.length} unpinned GitHub Action reference(s) found.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    checkActionsPinned(resolve(process.argv[2] ?? "."));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
