import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createOnnxVisionInferenceRuntime,
  type VisionInferenceRuntime,
} from "./vision-inference.ts";

const modelPath = fileURLToPath(
  new URL("./fixtures/tiny-vision.onnx", import.meta.url),
);
const bright = readFileSync(new URL("./fixtures/bright.png", import.meta.url));
const dark = readFileSync(new URL("./fixtures/dark.png", import.meta.url));
const gradient = readFileSync(new URL("./fixtures/gradient.png", import.meta.url));

function runtime(): VisionInferenceRuntime {
  return createOnnxVisionInferenceRuntime({
    modelPath,
    width: 8,
    height: 8,
  });
}

test("the vision runtime loads a model and runs inference on a fixture image", async () => {
  const vision = runtime();
  await vision.load();
  const logits = await vision.infer(bright);
  assert.ok(logits instanceof Float32Array);
  assert.equal(logits.length, 4);
});

test("vision inference is deterministic and input-dependent", async () => {
  const vision = runtime();
  const first = await vision.infer(bright);
  const second = await vision.infer(bright);
  assert.deepEqual(Array.from(first), Array.from(second));

  const darkLogits = await vision.infer(dark);
  const gradientLogits = await vision.infer(gradient);
  assert.notDeepEqual(Array.from(darkLogits), Array.from(first));
  assert.notDeepEqual(Array.from(gradientLogits), Array.from(first));
});

test("the vision runtime never persists the image or sends it off-device", () => {
  const source = readFileSync(
    new URL("./vision-inference.ts", import.meta.url),
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
