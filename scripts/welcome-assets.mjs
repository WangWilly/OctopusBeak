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

const SCREENSHOTS = [
  ["01-overview", "1-overview", "icon-eye.png"],
  ["02-overview-net-change", "2-overview-net-change", "icon-eye-manifer.png"],
  [
    "03-overview-portfolio-flow",
    "3-overview-portfolio-flow",
    "icon-eye-manifer.png",
  ],
  ["04-asset", "4-asset", "icon-asset.png"],
  [
    "05-asset-brokerage-trades",
    "5-asset-brokerage-trades",
    "icon-asset-magnifer.png",
  ],
  [
    "06-asset-brokerage-positions",
    "6-asset-brokerage-positions",
    "icon-asset-magnifer.png",
  ],
  [
    "07-liability-changes",
    "7-liability-changes",
    "icon-asset-magnifer.png",
  ],
  ["08-spending", "8-spending", "icon-spending.png"],
  ["09-receipt-list", "9-receipt-list", "icon-spending-magnifer.png"],
  [
    "10-receipt-detail",
    "10-receipt-detail",
    "icon-spending-magnifer.png",
  ],
  [
    "11-credential-settings",
    "11-credential-settings",
    "icon-keyvault.png",
  ],
];

const ASSETS = [
  {
    source: "~/Projects/ob-social-posts/assets/brand/octopusbeak-icon-source.png",
    destination: "src/lib/welcome/assets/app-icon.png",
    kind: "app-icon",
  },
  {
    source: "~/Downloads/ChatGPT Image Aug 7 2026 from rasterizeText.png",
    destination: "src/lib/welcome/assets/ink-background.png",
    kind: "background",
  },
  {
    source: "~/Downloads/Curved Arrow Animation.svg",
    destination: "src/lib/welcome/assets/curved-arrow-animation.svg",
    kind: "illustration",
  },
  ...SCREENSHOTS.flatMap(([base, sourceDirectory]) => [
    {
      source: `~/Documents/ob-welcome/${sourceDirectory}/en.png`,
      destination: `src/lib/welcome/assets/screenshots/${base}.en.png`,
      kind: "screenshot",
    },
    {
      source: `~/Documents/ob-welcome/${sourceDirectory}/zh.png`,
      destination: `src/lib/welcome/assets/screenshots/${base}.zh-TW.png`,
      kind: "screenshot",
    },
  ]),
  ...SCREENSHOTS.map(([base, sourceDirectory, iconName]) => ({
    source: `~/Documents/ob-welcome/${sourceDirectory}/${iconName}`,
    destination: `src/lib/welcome/assets/icons/${base}.png`,
    kind: "icon",
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

export async function generateWelcomeAssets() {
  const manifest = [];
  for (const asset of ASSETS) {
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

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function rgbaAlphaStats(parsed) {
  const { width, height } = parsed.metadata;
  const stride = width * 4;
  const previous = Buffer.alloc(stride);
  let inputOffset = 0;
  let transparent = 0;
  let visible = 0;
  let transparentBorder = 0;
  let borderPixels = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = parsed.inflated[inputOffset];
    inputOffset += 1;
    const current = Buffer.allocUnsafe(stride);
    for (let x = 0; x < stride; x += 1) {
      const encoded = parsed.inflated[inputOffset + x];
      const left = x >= 4 ? current[x - 4] : 0;
      const above = previous[x];
      const upperLeft = x >= 4 ? previous[x - 4] : 0;
      let predictor;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = left;
          break;
        case 2:
          predictor = above;
          break;
        case 3:
          predictor = Math.floor((left + above) / 2);
          break;
        case 4:
          predictor = paeth(left, above, upperLeft);
          break;
        default:
          throw new Error(`unsupported PNG filter ${filter}`);
      }
      current[x] = (encoded + predictor) & 0xff;
    }
    inputOffset += stride;
    for (let x = 0; x < width; x += 1) {
      const alpha = current[x * 4 + 3];
      if (alpha === 0) transparent += 1;
      if (alpha > 0) visible += 1;
      if (y === 0 || y === height - 1 || x === 0 || x === width - 1) {
        borderPixels += 1;
        if (alpha === 0) transparentBorder += 1;
      }
    }
    current.copy(previous);
  }
  return { transparent, visible, transparentBorder, borderPixels };
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
        if (entry.kind === "icon") {
          if (parsed.metadata.colorType !== 6) {
            errors.push("feature icon is not RGBA");
          } else {
            const stats = rgbaAlphaStats(parsed);
            if (stats.transparent === 0 || stats.visible === 0) {
              errors.push("feature icon lacks both transparent and visible pixels");
            }
            if (stats.transparentBorder / stats.borderPixels < 0.95) {
              errors.push("feature icon border is not at least 95% transparent");
            }
          }
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
    resolve(REPO_ROOT, ".github/workflows/release-macos.yml"),
    "utf8",
  );
  if (!checkoutHasLfs(releaseWorkflow)) {
    invalidAssets.push("macOS release checkout does not enable lfs: true");
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
      "macOS release must validate Welcome assets before packaging",
    );
  }

  return {
    assetCount: Array.isArray(manifest) ? manifest.length : 0,
    invalidAssets,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = await generateWelcomeAssets();
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
