import { PNG } from "pngjs";
import * as ort from "onnxruntime-node";

export type VisionInferenceRuntime = {
  load(): Promise<void>;
  infer(image: Buffer): Promise<Float32Array>;
};

export type VisionRuntimeConfig = {
  modelPath: string;
  width: number;
  height: number;
  inputName?: string;
  outputName?: string;
};

export function createOnnxVisionInferenceRuntime(
  config: VisionRuntimeConfig,
): VisionInferenceRuntime {
  let sessionPromise: Promise<ort.InferenceSession> | null = null;

  function session() {
    sessionPromise ??= ort.InferenceSession.create(config.modelPath).catch(
      (error) => {
        sessionPromise = null;
        throw error;
      },
    );
    return sessionPromise;
  }

  return {
    async load() {
      await session();
    },
    async infer(image) {
      const model = await session();
      const input = preprocessImage(image, config.width, config.height);
      const tensor = new ort.Tensor("float32", input, [
        1,
        1,
        config.height,
        config.width,
      ]);
      const feeds: Record<string, ort.Tensor> = {
        [config.inputName ?? "image"]: tensor,
      };
      const results = await model.run(feeds);
      const output = results[config.outputName ?? "logits"];
      if (!output) {
        throw new Error(
          `Vision model did not produce output ${config.outputName ?? "logits"}.`,
        );
      }
      const data = output.data;
      if (!(data instanceof Float32Array)) {
        throw new Error(
          `Vision model output ${config.outputName ?? "logits"} is not float32.`,
        );
      }
      return data;
    },
  };
}

function preprocessImage(
  image: Buffer,
  width: number,
  height: number,
): Float32Array {
  const png = PNG.sync.read(image);
  return resizeMap(
    grayscaleMap(png),
    png.width,
    png.height,
    width,
    height,
  );
}

function grayscaleMap(png: PNG): Float32Array {
  const map = new Float32Array(png.width * png.height);
  for (let i = 0; i < map.length; i += 1) {
    const r = png.data[i * 4]!;
    const g = png.data[i * 4 + 1]!;
    const b = png.data[i * 4 + 2]!;
    map[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  return map;
}

function resizeMap(
  source: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Float32Array {
  const target = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = (y + 0.5) * sourceHeight / targetHeight - 0.5;
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = (x + 0.5) * sourceWidth / targetWidth - 0.5;
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const fx = sourceX - x0;
      const top = source[y0 * sourceWidth + x0]! * (1 - fx) +
        source[y0 * sourceWidth + x1]! * fx;
      const bottom = source[y1 * sourceWidth + x0]! * (1 - fx) +
        source[y1 * sourceWidth + x1]! * fx;
      target[y * targetWidth + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return target;
}
