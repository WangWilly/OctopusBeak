#!/usr/bin/env node

import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const packages = lock.packages;

if (!packages || typeof packages !== "object") {
  console.error("package-lock check failed: lockfile has no packages map.");
  process.exit(1);
}

function parseVersion(value) {
  const match = String(value).trim().match(/^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/);
  if (!match) return null;

  const parts = match.slice(1).filter((part) => part !== undefined);
  if (parts.some((part) => part === "x" || part === "*")) return { parts, wildcard: true };

  return {
    parts: parts.map(Number),
    wildcard: false,
  };
}

function toTriple(parts) {
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compare(a, b) {
  const left = toTriple(a);
  const right = toTriple(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function satisfiesPartial(version, range) {
  const parsed = parseVersion(range);
  if (!parsed || parsed.wildcard) return true;

  const lower = toTriple(parsed.parts);
  if (parsed.parts.length >= 3) return compare(version, lower) === 0;

  const upper = [...lower];
  upper[parsed.parts.length - 1] += 1;
  for (let index = parsed.parts.length; index < 3; index += 1) upper[index] = 0;

  return compare(version, lower) >= 0 && compare(version, upper) < 0;
}

function satisfiesCaret(version, range) {
  const parsed = parseVersion(range);
  if (!parsed || parsed.wildcard) return true;

  const lower = toTriple(parsed.parts);
  const upper = [...lower];

  if (parsed.parts.length === 1 || lower[0] > 0) {
    upper[0] += 1;
    upper[1] = 0;
    upper[2] = 0;
  } else if (parsed.parts.length === 2 || lower[1] > 0) {
    upper[1] += 1;
    upper[2] = 0;
  } else {
    upper[2] += 1;
  }

  return compare(version, lower) >= 0 && compare(version, upper) < 0;
}

function satisfiesTilde(version, range) {
  const parsed = parseVersion(range);
  if (!parsed || parsed.wildcard) return true;

  const lower = toTriple(parsed.parts);
  const upper = [...lower];

  if (parsed.parts.length === 1) {
    upper[0] += 1;
    upper[1] = 0;
    upper[2] = 0;
  } else {
    upper[1] += 1;
    upper[2] = 0;
  }

  return compare(version, lower) >= 0 && compare(version, upper) < 0;
}

function upperExclusive(parts) {
  const upper = toTriple(parts);
  if (parts.length >= 3) {
    upper[2] += 1;
  } else if (parts.length === 2) {
    upper[1] += 1;
    upper[2] = 0;
  } else {
    upper[0] += 1;
    upper[1] = 0;
    upper[2] = 0;
  }
  return upper;
}

function satisfiesHyphen(version, range) {
  const match = range.match(/^v?(\d+(?:\.(?:\d+|x|\*)){0,2})\s+-\s+v?(\d+(?:\.(?:\d+|x|\*)){0,2})$/);
  if (!match) return null;

  const lower = parseVersion(match[1]);
  const upper = parseVersion(match[2]);
  if (!lower || !upper || lower.wildcard || upper.wildcard) return true;

  return compare(version, toTriple(lower.parts)) >= 0
    && compare(version, upperExclusive(upper.parts)) < 0;
}

function satisfiesComparators(version, range) {
  const comparators = [...range.matchAll(/(>=|<=|>|<)\s*v?(\d+(?:\.(?:\d+|x|\*)){0,2})/g)];
  if (!comparators.length) return null;

  return comparators.every(([, operator, raw]) => {
    const parsed = parseVersion(raw);
    if (!parsed || parsed.wildcard) return true;
    const target = toTriple(parsed.parts);
    const order = compare(version, target);

    return (
      (operator === ">=" && order >= 0) ||
      (operator === "<=" && order <= 0) ||
      (operator === ">" && order > 0) ||
      (operator === "<" && order < 0)
    );
  });
}

function satisfies(version, range) {
  if (!range || range === "*" || range === "latest") return true;
  if (/^(file:|git\+|https?:|link:|npm:|workspace:)/.test(range)) return true;

  const parsedVersion = parseVersion(version);
  if (!parsedVersion || parsedVersion.wildcard) return true;
  const versionParts = toTriple(parsedVersion.parts);

  return String(range)
    .split("||")
    .some((part) => {
      const normalized = part.trim();
      if (!normalized) return true;

      const hyphenResult = satisfiesHyphen(versionParts, normalized);
      if (hyphenResult !== null) return hyphenResult;

      const comparatorResult = satisfiesComparators(versionParts, normalized);
      if (comparatorResult !== null) return comparatorResult;
      if (normalized.startsWith("^")) return satisfiesCaret(versionParts, normalized.slice(1));
      if (normalized.startsWith("~")) return satisfiesTilde(versionParts, normalized.slice(1));

      return satisfiesPartial(versionParts, normalized);
    });
}

function parentPackagePath(packagePath) {
  if (!packagePath) return null;

  const marker = "/node_modules/";
  const index = packagePath.lastIndexOf(marker);
  return index === -1 ? "" : packagePath.slice(0, index);
}

function resolvePackage(fromPath, name) {
  for (let current = fromPath; current !== null; current = parentPackagePath(current)) {
    const candidate = current ? `${current}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
  }
  return null;
}

const findings = [];

for (const [packagePath, pkg] of Object.entries(packages)) {
  const fields = packagePath === ""
    ? ["dependencies", "devDependencies", "optionalDependencies"]
    : ["dependencies", "optionalDependencies"];

  for (const field of fields) {
    for (const [name, range] of Object.entries(pkg[field] || {})) {
      const resolvedPath = resolvePackage(packagePath, name);
      if (!resolvedPath) {
        findings.push(`${packagePath || "."}: missing ${field} ${name}@${range}`);
        continue;
      }

      const resolvedVersion = packages[resolvedPath].version;
      if (!satisfies(resolvedVersion, range)) {
        findings.push(
          `${packagePath || "."}: ${field} ${name}@${range} resolved to ${resolvedPath}@${resolvedVersion}`,
        );
      }
    }
  }
}

if (findings.length) {
  console.error("package-lock check failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
