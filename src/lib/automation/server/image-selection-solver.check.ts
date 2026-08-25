import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  gridRegionCenters,
  imageSelectionSolver,
  runtimeVisionSelectionEngine,
  selectMatchingRegions,
  type VisionSelectionEngine,
} from "./image-selection-solver.ts";

const image = Buffer.from("challenge-image");

test("selectMatchingRegions aggregates confidence from matched probabilities", () => {
  assert.deepEqual(
    selectMatchingRegions([0.9, 0.3, 0.95, 0.5], 0.6),
    { selectedIndices: [0, 2], confidence: (0.9 + 0.95) / 2 },
  );
});

test("selectMatchingRegions yields zero confidence when nothing matches", () => {
  assert.deepEqual(
    selectMatchingRegions([0.1, 0.2, 0.3], 0.6),
    { selectedIndices: [], confidence: 0 },
  );
});

test("gridRegionCenters maps a grid to image-relative click centers", () => {
  assert.deepEqual(gridRegionCenters(2, 2, 100, 50), [
    { x: 25, y: 12.5 },
    { x: 75, y: 12.5 },
    { x: 25, y: 37.5 },
    { x: 75, y: 37.5 },
  ]);
});

test("the image-selection solver returns a selection answer with the prompt", async () => {
  const engine: VisionSelectionEngine = {
    async select({ prompt }) {
      assert.equal(prompt, "traffic lights");
      return { selections: [{ x: 10, y: 20 }], confidence: 0.88 };
    },
  };
  const result = await imageSelectionSolver(engine).solve({
    image,
    challengeKind: "image-selection",
    prompt: "traffic lights",
  });
  assert.deepEqual(result, {
    selections: [{ x: 10, y: 20 }],
    confidence: 0.88,
  });
});

test("the image-selection solver rejects other kinds and a missing prompt", async () => {
  const solver = imageSelectionSolver({
    async select() {
      return { selections: [], confidence: 0 };
    },
  });
  await assert.rejects(
    solver.solve({ image, challengeKind: "text-captcha" }),
    /does not support challenge kind text-captcha/,
  );
  await assert.rejects(
    solver.solve({ image, challengeKind: "image-selection" }),
    /requires a challenge prompt/,
  );
});

test("the runtime engine selects matched regions and maps them to coordinates", async () => {
  const engine = runtimeVisionSelectionEngine(
    {
      async load() {},
      async infer() {
        return new Float32Array([0.9, 0.1, 0.95, 0.2]);
      },
    },
    { rows: 2, cols: 2, imageWidth: 100, imageHeight: 50, threshold: 0.6 },
  );
  const result = await engine.select({ image, prompt: "x" });
  assert.ok(Math.abs(result.confidence - 0.925) < 1e-6);
  assert.deepEqual(result.selections, [
    { x: 25, y: 12.5 },
    { x: 25, y: 37.5 },
  ]);
});

test("the image-selection solver reads the image on-device only", () => {
  const source = readFileSync(
    new URL("./image-selection-solver.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /writeFile|appendFile|createWriteStream|from\("node:fs"\)/,
  );
  assert.doesNotMatch(
    source,
    /from\("node:http"\)|from\("node:https"\)|from\("node:net"\)|fetch\(/,
  );
  assert.doesNotMatch(source, /console\.(log|info|debug|warn)/);
});
