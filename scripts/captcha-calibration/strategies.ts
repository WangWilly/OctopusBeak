import {
  CAPTCHA_IMAGE_PREPROCESSING_MODES,
  CAPTCHA_OCR_PAGE_SEGMENTATION_MODES,
  type CaptchaOcrAttemptStrategy,
} from "../../src/lib/automation/human-assistance.ts";

export type CalibrationStrategy = Readonly<{ label: string; strategy: CaptchaOcrAttemptStrategy }>;

const PREPROCESSING_OPTIONS = [[], ...CAPTCHA_IMAGE_PREPROCESSING_MODES.map((mode) => [mode])] as const;

/** Every single preprocessing mode (or none) crossed with every page segmentation mode, in a stable order. */
export const STRATEGY_GRID: readonly CalibrationStrategy[] = PREPROCESSING_OPTIONS.flatMap((imagePreprocessing) =>
  CAPTCHA_OCR_PAGE_SEGMENTATION_MODES.map((ocrPageSegmentationMode) => ({
    label: `pre=${imagePreprocessing[0] ?? "none"}|psm=${ocrPageSegmentationMode}`,
    strategy: { imagePreprocessing, ocrPageSegmentationMode },
  })));
