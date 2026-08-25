import type {
  VerificationSelectionPoint,
  VerificationSolver,
  VerificationSolverResult,
} from "./verification-solver.ts";
import type { VisionInferenceRuntime } from "./vision-inference.ts";

export type VisionSelectionEngine = {
  select(input: {
    image: Buffer;
    prompt: string;
  }): Promise<{
    selections: readonly VerificationSelectionPoint[];
    confidence: number;
  }>;
};

export function selectMatchingRegions(
  probabilities: readonly number[],
  threshold: number,
): { selectedIndices: readonly number[]; confidence: number } {
  const selectedIndices: number[] = [];
  let sum = 0;
  probabilities.forEach((probability, index) => {
    if (probability >= threshold) {
      selectedIndices.push(index);
      sum += probability;
    }
  });
  if (selectedIndices.length === 0) return { selectedIndices: [], confidence: 0 };
  return {
    selectedIndices,
    confidence: sum / selectedIndices.length,
  };
}

export function gridRegionCenters(
  rows: number,
  cols: number,
  width: number,
  height: number,
): readonly VerificationSelectionPoint[] {
  const cellWidth = width / cols;
  const cellHeight = height / rows;
  const centers: VerificationSelectionPoint[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      centers.push({
        x: col * cellWidth + cellWidth / 2,
        y: row * cellHeight + cellHeight / 2,
      });
    }
  }
  return centers;
}

export function imageSelectionSolver(
  engine: VisionSelectionEngine,
): VerificationSolver {
  return {
    async solve({ image, challengeKind, prompt }): Promise<VerificationSolverResult> {
      if (challengeKind !== "image-selection") {
        throw new Error(
          `Image-selection solver does not support challenge kind ${challengeKind}.`,
        );
      }
      if (!prompt) {
        throw new Error("Image-selection solver requires a challenge prompt.");
      }
      const { selections, confidence } = await engine.select({ image, prompt });
      return { selections, confidence };
    },
  };
}

export type RuntimeSelectionConfig = {
  rows: number;
  cols: number;
  imageWidth: number;
  imageHeight: number;
  threshold: number;
};

export function runtimeVisionSelectionEngine(
  runtime: VisionInferenceRuntime,
  config: RuntimeSelectionConfig,
): VisionSelectionEngine {
  const centers = gridRegionCenters(
    config.rows,
    config.cols,
    config.imageWidth,
    config.imageHeight,
  );
  return {
    async select({ image }) {
      const probabilities = await runtime.infer(image);
      const { selectedIndices, confidence } = selectMatchingRegions(
        Array.from(probabilities),
        config.threshold,
      );
      return {
        selections: selectedIndices.map((index) => centers[index]!),
        confidence,
      };
    },
  };
}
