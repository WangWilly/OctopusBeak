import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  constants as zlibConstants,
  deflateSync,
  inflateSync,
} from "node:zlib";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = "src/lib/welcome/asset-manifest.json";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const LFS_ATTRIBUTE =
  "src/lib/welcome/assets/** filter=lfs diff=lfs merge=lfs -text";

const DESIGN_IMAGES = "~/.pencil/documents/f9aed551-7c26-4bcf-a3a6-95444a3ebc6f/images";

/** Hero window screens for slides 3-5, shared by both locales as in the design. */
const SCREENSHOTS = [
  ["01-overview", "welcome/tVIHe.png"],
  ["04-asset", "welcome/fSqDk.png"],
  ["08-spending", "welcome/c7mU4.png"],
];

const ASSETS = [
  {
    source: "~/Projects/ob-social-posts/assets/brand/octopusbeak-icon-source.png",
    destination: "src/lib/welcome/assets/app-icon.png",
    kind: "app-icon",
  },
  {
    source: `${DESIGN_IMAGES}/site/b2ca0feac6a1cee5.png`,
    destination: "src/lib/welcome/assets/ink-background.png",
    kind: "background",
  },
  {
    source: "~/Downloads/Curved Arrow Animation.svg",
    destination: "src/lib/welcome/assets/curved-arrow-animation.svg",
    kind: "illustration",
  },
  ...SCREENSHOTS.map(([base, source]) => ({
    source: `${DESIGN_IMAGES}/${source}`,
    destination: `src/lib/welcome/assets/screenshots/${base}.png`,
    kind: "screenshot",
  })),
];

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function parsePng(buffer, pathForError = "PNG") {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    const pointerPrefix = buffer
      .subarray(0, Math.min(buffer.length, 80))
      .toString("utf8");
    if (pointerPrefix.startsWith("version https://git-lfs.github.com/spec/")) {
      throw new Error(`${pathForError} contains a Git LFS pointer, not PNG bytes`);
    }
    throw new Error(`${pathForError} does not have the PNG signature`);
  }

  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) {
      throw new Error(`${pathForError} has a truncated PNG chunk`);
    }
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) {
      throw new Error(`${pathForError} has a truncated PNG chunk payload`);
    }
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(
      buffer.subarray(offset + 4, offset + 8 + length),
    );
    if (actualCrc !== expectedCrc) {
      throw new Error(`${pathForError} has an invalid ${type} CRC`);
    }
    chunks.push({ type, data });
    offset = end;
    if (type === "IEND") break;
  }

  const ihdr = chunks.find(({ type }) => type === "IHDR")?.data;
  if (!ihdr || ihdr.length !== 13) {
    throw new Error(`${pathForError} has no valid IHDR chunk`);
  }
  const idat = chunks
    .filter(({ type }) => type === "IDAT")
    .map(({ data }) => data);
  if (idat.length === 0) {
    throw new Error(`${pathForError} has no IDAT chunks`);
  }

  const metadata = {
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    bitDepth: ihdr[8],
    colorType: ihdr[9],
    compressionMethod: ihdr[10],
    filterMethod: ihdr[11],
    interlaceMethod: ihdr[12],
  };
  if (
    metadata.bitDepth !== 8 ||
    ![2, 6].includes(metadata.colorType) ||
    metadata.compressionMethod !== 0 ||
    metadata.filterMethod !== 0 ||
    metadata.interlaceMethod !== 0
  ) {
    throw new Error(
      `${pathForError} must be non-interlaced 8-bit RGB or RGBA PNG`,
    );
  }

  const inflated = inflateSync(Buffer.concat(idat));
  const channels = metadata.colorType === 6 ? 4 : 3;
  const expectedLength = metadata.height * (1 + metadata.width * channels);
  if (inflated.length !== expectedLength) {
    throw new Error(`${pathForError} has an unexpected inflated byte length`);
  }
  return { chunks, inflated, metadata };
}

function rebuildPng(parsed, compressed) {
  const output = [PNG_SIGNATURE];
  let wroteIdat = false;
  for (const chunk of parsed.chunks) {
    if (chunk.type === "IDAT") {
      if (!wroteIdat) {
        output.push(createChunk("IDAT", compressed));
        wroteIdat = true;
      }
    } else {
      output.push(createChunk(chunk.type, chunk.data));
    }
  }
  return Buffer.concat(output);
}

function optimizePng(source, sourcePath) {
  const parsed = parsePng(source, sourcePath);
  const strategies = [zlibConstants.Z_DEFAULT_STRATEGY];
  const candidates = strategies.map((strategy) =>
    deflateSync(parsed.inflated, { level: 9, strategy }),
  );
  candidates.sort(
    (left, right) =>
      left.length - right.length || Buffer.compare(left, right),
  );
  const rebuilt = rebuildPng(parsed, candidates[0]);
  const finalBytes = rebuilt.length < source.length ? rebuilt : source;
  const finalParsed = parsePng(finalBytes, sourcePath);
  if (!finalParsed.inflated.equals(parsed.inflated)) {
    throw new Error(`${sourcePath} changed decoded scanline bytes`);
  }
  return {
    bytes: finalBytes,
    metadata: parsed.metadata,
    decodedPixelSha256: createHash("sha256")
      .update(parsed.inflated)
      .digest("hex"),
  };
}

function optimizeSvg(source, sourcePath) {
  const text = source.toString("utf8");
  if (!/<svg\b[^>]*>/i.test(text)) {
    throw new Error(`${sourcePath} does not contain an SVG root element`);
  }
  // Keep the supplied path artwork intact while shortening its staged reveal
  // to the Welcome introduction's 1.2 s motion budget.
  const accelerated = text
    .replace(
      /((?:begin|dur)=")([\d.]+)s(")/g,
      (_match, prefix, seconds, suffix) => `${prefix}${Number(seconds) / 2}s${suffix}`,
    )
    .replace(/[ \t]+$/gm, "");
  const bytes = Buffer.from(accelerated, "utf8");
  return {
    bytes,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function expandedSource(source) {
  return resolve(homedir(), source.slice(2));
}

export function expectedWelcomeAssetDestinations() {
  return ASSETS.map(({ destination }) => destination);
}

/**
 * Regenerates the given destinations (all of them when none are given) and
 * keeps the recorded manifest entry for the rest, whose sources may no longer
 * exist on this machine.
 */
export async function generateWelcomeAssets(destinations = []) {
  const recorded = new Map(
    JSON.parse(await readFile(resolve(REPO_ROOT, MANIFEST_PATH), "utf8"))
      .map((entry) => [entry.destination, entry]),
  );
  const manifest = [];
  for (const asset of ASSETS) {
    if (destinations.length && !destinations.includes(asset.destination)) {
      const entry = recorded.get(asset.destination);
      if (!entry) throw new Error(`${asset.destination} has no recorded manifest entry`);
      manifest.push(entry);
      continue;
    }
    const sourcePath = expandedSource(asset.source);
    const source = await readFile(sourcePath);
    const optimized = asset.kind === "illustration"
      ? optimizeSvg(source, asset.source)
      : optimizePng(source, asset.source);
    const destinationPath = resolve(REPO_ROOT, asset.destination);
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, optimized.bytes);
    const entry = {
      source: asset.source,
      destination: asset.destination,
      kind: asset.kind,
    };
    if (asset.kind === "illustration") {
      entry.originalBytes = source.length;
      entry.finalBytes = optimized.bytes.length;
      entry.contentSha256 = optimized.contentSha256;
    } else {
      entry.width = optimized.metadata.width;
      entry.height = optimized.metadata.height;
      entry.bitDepth = optimized.metadata.bitDepth;
      entry.colorType = optimized.metadata.colorType;
      entry.originalBytes = source.length;
      entry.finalBytes = optimized.bytes.length;
      entry.decodedPixelSha256 = optimized.decodedPixelSha256;
    }
    manifest.push(entry);
  }
  await writeFile(
    resolve(REPO_ROOT, MANIFEST_PATH),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function checkoutHasLfs(yaml) {
  return /uses:\s*actions\/checkout@[^\n]+\n\s+with:\n(?:\s+[^\n]+\n)*?\s+lfs:\s*true\b/m.test(
    yaml,
  );
}

async function listWelcomeFiles(directory, relativeDirectory = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      files.push(
        ...(await listWelcomeFiles(resolve(directory, entry.name), relativePath)),
      );
    } else if (entry.isFile() && /\.(?:png|svg)$/i.test(entry.name)) {
      files.push(`src/lib/welcome/assets/${relativePath}`);
    }
  }
  return files.sort();
}

export async function validateWelcomeAssets() {
  const invalidAssets = [];
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(resolve(REPO_ROOT, MANIFEST_PATH), "utf8"),
    );
  } catch (error) {
    return {
      assetCount: 0,
      invalidAssets: [`cannot read ${MANIFEST_PATH}: ${error.message}`],
    };
  }

  const expected = expectedWelcomeAssetDestinations();
  if (!Array.isArray(manifest) || manifest.length !== expected.length) {
    invalidAssets.push(`manifest must contain exactly ${expected.length} entries`);
  }
  const destinations = Array.isArray(manifest)
    ? manifest.map(({ destination }) => destination)
    : [];
  if (JSON.stringify(destinations) !== JSON.stringify(expected)) {
    invalidAssets.push("manifest destinations or ordering differ from the contract");
  }
  if (
    JSON.stringify(
      (Array.isArray(manifest) ? manifest : []).map(
        ({ source, destination, kind }) => ({
          source,
          destination,
          kind,
        }),
      ),
    ) !== JSON.stringify(ASSETS)
  ) {
    invalidAssets.push("manifest source-to-destination mapping differs from contract");
  }
  const shippingAssets = await listWelcomeFiles(
    resolve(REPO_ROOT, "src/lib/welcome/assets"),
  );
  if (
    JSON.stringify(shippingAssets) !== JSON.stringify([...expected].sort())
  ) {
    invalidAssets.push("shipping directory must contain exactly the contracted Welcome assets");
  }

  const trackedByLfs = new Set(
    commandOutput("git", ["lfs", "ls-files", "--name-only"])
      .split("\n")
      .filter(Boolean),
  );
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    const errors = [];
    if (!entry.source?.startsWith("~/")) errors.push("source must use ~/ notation");
    let bytes;
    try {
      bytes = await readFile(resolve(REPO_ROOT, entry.destination));
      if (entry.kind === "illustration") {
        if (!/<svg\b[^>]*>/i.test(bytes.toString("utf8"))) {
          errors.push("illustration does not contain an SVG root element");
        }
        const hash = createHash("sha256").update(bytes).digest("hex");
        if (entry.contentSha256 !== hash) {
          errors.push("content hash differs from manifest");
        }
      } else {
        const parsed = parsePng(bytes, entry.destination);
        const hash = createHash("sha256").update(parsed.inflated).digest("hex");
        for (const field of [
          "width",
          "height",
          "bitDepth",
          "colorType",
        ]) {
          if (entry[field] !== parsed.metadata[field]) {
            errors.push(`${field} differs from manifest`);
          }
        }
        if (entry.decodedPixelSha256 !== hash) {
          errors.push("decoded scanline hash differs");
        }
      }
      if (entry.finalBytes !== bytes.length) errors.push("finalBytes differs");
      if (!Number.isInteger(entry.originalBytes) || entry.originalBytes < bytes.length) {
        errors.push("originalBytes is invalid or smaller than finalBytes");
      }
    } catch (error) {
      errors.push(error.message);
    }

    const isTracked = commandOutput("git", [
      "ls-files",
      "--error-unmatch",
      entry.destination,
    ]);
    if (isTracked && !trackedByLfs.has(entry.destination)) {
      errors.push("tracked asset is not represented by Git LFS");
    }
    if (errors.length > 0) {
      invalidAssets.push(`${entry.destination}: ${errors.join("; ")}`);
    }
  }

  const attributes = await readFile(resolve(REPO_ROOT, ".gitattributes"), "utf8");
  if (!attributes.split(/\r?\n/).includes(LFS_ATTRIBUTE)) {
    invalidAssets.push(`.gitattributes lacks exact rule: ${LFS_ATTRIBUTE}`);
  }
  for (const destination of expected) {
    const filter = commandOutput("git", [
      "check-attr",
      "filter",
      "--",
      destination,
    ]);
    if (!filter.endsWith(": lfs")) {
      invalidAssets.push(`${destination}: Git filter attribute is not lfs`);
    }
  }

  const prWorkflow = await readFile(
    resolve(REPO_ROOT, ".github/workflows/pr-tests.yml"),
    "utf8",
  );
  if (!checkoutHasLfs(prWorkflow)) {
    invalidAssets.push("PR checkout does not enable lfs: true");
  }
  if (!prWorkflow.includes("npm run check:welcome-assets")) {
    invalidAssets.push("PR tests do not run Welcome asset validation");
  }
  const releaseWorkflow = await readFile(
    resolve(REPO_ROOT, ".github/workflows/release-electron.yml"),
    "utf8",
  );
  if (!checkoutHasLfs(releaseWorkflow)) {
    invalidAssets.push("Electron release checkout does not enable lfs: true");
  }
  const validationIndex = releaseWorkflow.indexOf(
    "npm run check:welcome-assets",
  );
  const packageIndex = releaseWorkflow.indexOf("npm run desktop:make:signed");
  if (
    validationIndex === -1 ||
    packageIndex === -1 ||
    validationIndex > packageIndex
  ) {
    invalidAssets.push(
      "Electron release must validate Welcome assets before packaging",
    );
  }

  return {
    assetCount: Array.isArray(manifest) ? manifest.length : 0,
    invalidAssets,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = await generateWelcomeAssets(process.argv.slice(2));
  const originalBytes = manifest.reduce(
    (total, entry) => total + entry.originalBytes,
    0,
  );
  const finalBytes = manifest.reduce(
    (total, entry) => total + entry.finalBytes,
    0,
  );
  process.stdout.write(
    `Generated ${manifest.length} Welcome assets: ${originalBytes} -> ${finalBytes} bytes\n`,
  );
}
