import {
  CAPTCHA_IMAGE_PREPROCESSING_MODES,
  CAPTCHA_OCR_PAGE_SEGMENTATION_MODES,
  type CaptchaOcrAttemptStrategy,
} from "../../src/lib/automation/human-assistance.ts";

export type CalibrationStrategy = Readonly<{ label: string; strategy: CaptchaOcrAttemptStrategy }>;

const PREPROCESSING_OPTIONS = [[], ...CAPTCHA_IMAGE_PREPROCESSING_MODES.map((mode) => [mode])] as const;

/** Whole-image grid in stable order, followed by the fixed held-out Rakuten character pipeline. */
export const STRATEGY_GRID: readonly CalibrationStrategy[] = [...PREPROCESSING_OPTIONS.flatMap((imagePreprocessing) =>
  CAPTCHA_OCR_PAGE_SEGMENTATION_MODES.map((ocrPageSegmentationMode) => ({
    label: `pre=${imagePreprocessing[0] ?? "none"}|psm=${ocrPageSegmentationMode}`,
    strategy: { imagePreprocessing, ocrPageSegmentationMode },
  }))), {
    label: "pre=rakuten-teal-foreground|split=rakuten-four-slots",
    strategy: { imagePreprocessing: ["rakuten-teal-foreground"], ocrCharacterSegmentation: "rakuten-four-slots" },
  }];
