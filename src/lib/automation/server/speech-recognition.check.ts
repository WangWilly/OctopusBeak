import assert from "node:assert/strict";
import test from "node:test";
import { basename } from "node:path";
import {
  createSherpaOnnxSpeechRecognitionEngine,
  defaultSherpaSpeechRecognitionConfig,
} from "./speech-recognition.ts";

test("the default speech model config resolves the bundled model and tokens", () => {
  const config = defaultSherpaSpeechRecognitionConfig();
  assert.equal(basename(config.modelPath), "model.int8.onnx");
  assert.equal(basename(config.tokensPath), "tokens.txt");
  assert.ok(config.modelPath.includes("sherpa-onnx-paraformer-zh-small"));
});

test("the speech model directory honours the environment override", () => {
  const previous = process.env.OCTOPUSBEAK_SPEECH_MODEL_DIR;
  process.env.OCTOPUSBEAK_SPEECH_MODEL_DIR = "/custom/model-dir";
  try {
    const config = defaultSherpaSpeechRecognitionConfig();
    assert.ok(config.modelPath.startsWith("/custom/model-dir"));
  } finally {
    if (previous === undefined) delete process.env.OCTOPUSBEAK_SPEECH_MODEL_DIR;
    else process.env.OCTOPUSBEAK_SPEECH_MODEL_DIR = previous;
  }
});

test("a speech engine defers config resolution until transcription", () => {
  let resolved = false;
  createSherpaOnnxSpeechRecognitionEngine(() => {
    resolved = true;
    return { modelPath: "/nonexistent/model.onnx", tokensPath: "/nonexistent/tokens.txt" };
  });
  assert.equal(resolved, false);
});
