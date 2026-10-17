import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { appendCapture } from "./corpus.ts";

export function solidPng(width = 4, height = 2) {
  const png = new PNG({ width, height });
  png.data.fill(255);
  return PNG.sync.write(png);
}

export async function temporaryCorpus(ids, labels, size = { width: 4, height: 2 }) {
  const directory = await mkdtemp(join(tmpdir(), "captcha-calibration-"));
  for (const id of ids) {
    await appendCapture(directory, {
      id,
      capturedAt: "2026-10-15T02:00:00.000Z",
      ...size,
      sourceMediaType: "image/png",
      method: "preview-source",
    }, solidPng(size.width, size.height));
  }
  if (labels) await writeFile(join(directory, "labels.json"), JSON.stringify(labels));
  return directory;
}
