import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpeechRecognitionEngine } from "./audio-captcha-solver.ts";
import type { OfflineRecognizer } from "sherpa-onnx-node";

export type SherpaSpeechRecognitionConfig = {
  modelPath: string;
  tokensPath: string;
};

const SPEECH_MODEL_DIR_ENV = "OCTOPUSBEAK_SPEECH_MODEL_DIR";

const DEFAULT_SPEECH_MODEL_SUBDIR = join(
  "models",
  "sherpa-onnx-paraformer-zh-small",
);

/**
 * Resolve the bundled speech model directory. The desktop host sets
 * OCTOPUSBEAK_SPEECH_MODEL_DIR to an app-root-anchored path; the ESM test and
 * workflow contexts fall back to the module's own directory.
 */
export function defaultSherpaSpeechRecognitionConfig(): SherpaSpeechRecognitionConfig {
  const modelDir = process.env[SPEECH_MODEL_DIR_ENV]
    ?? join(dirname(fileURLToPath(import.meta.url)), DEFAULT_SPEECH_MODEL_SUBDIR);
  return {
    modelPath: join(modelDir, "model.int8.onnx"),
    tokensPath: join(modelDir, "tokens.txt"),
  };
}

/**
 * The local speech-recognition runtime: decode the first-party audio clip
 * (MPEG) and transcribe it with the bundled paraformer-zh-small ONNX model.
 * The recogniser and codecs load lazily, and the config is resolved on first
 * transcription, so the native addon, WASM decoder, and model stay out of the
 * module-load path until a challenge is actually solved. The Chinese output
 * is mapped to decimal digits by the audio solver.
 */
export function createSherpaOnnxSpeechRecognitionEngine(
  config: SherpaSpeechRecognitionConfig | (() => SherpaSpeechRecognitionConfig) =
    defaultSherpaSpeechRecognitionConfig,
): SpeechRecognitionEngine {
  let recognizerPromise: Promise<OfflineRecognizer> | null = null;

  function resolveConfig(): SherpaSpeechRecognitionConfig {
    return typeof config === "function" ? config() : config;
  }

  function loadSherpa() {
    // CJS interop: the dynamic import namespace exposes the module.exports
    // object under `default`; named-export detection is not guaranteed for
    // every property of the exports object.
    return import("sherpa-onnx-node").then((mod) =>
      (mod.default ?? mod) as unknown as {
        OfflineRecognizer: new (recognizerConfig: unknown) => OfflineRecognizer;
        LinearResampler: new (
          inputSampleRate: number,
          outputSampleRate: number,
        ) => {
          flush(samples: Float32Array): Float32Array;
        };
      },
    );
  }

  function recognizer() {
    recognizerPromise ??= loadSherpa().then(({ OfflineRecognizer }) => {
      const resolved = resolveConfig();
      return new OfflineRecognizer({
        modelConfig: {
          paraformer: { model: resolved.modelPath },
          tokens: resolved.tokensPath,
          numThreads: 1,
          debug: 0,
          provider: "cpu",
        },
      });
    });
    return recognizerPromise;
  }

  return {
    async transcribe(audio) {
      const { MPEGDecoder } = await import("mpg123-decoder");
      const decoder = new MPEGDecoder();
      let decoded;
      try {
        await decoder.ready;
        decoded = decoder.decode(new Uint8Array(audio));
      } finally {
        decoder.free();
      }
      const channel = decoded.channelData[0];
      if (!channel || channel.length === 0) return { text: "" };
      const { LinearResampler } = await loadSherpa();
      const resampler = new LinearResampler(decoded.sampleRate, 16_000);
      const samples = resampler.flush(channel);
      const rec = await recognizer();
      const stream = rec.createStream();
      stream.acceptWaveform({ sampleRate: 16_000, samples });
      rec.decode(stream);
      return { text: rec.getResult(stream).text };
    },
  };
}
