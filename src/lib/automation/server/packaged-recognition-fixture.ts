import type { WorkflowContext } from "../workflow-executor.ts";
import { tesseractTextRecognitionEngine } from "./text-captcha-solver.ts";
import { defaultSherpaSpeechRecognitionConfig } from "./speech-recognition.ts";

/** Synthetic inputs only; executed inside the packaged automation worker. */
export async function verifyPackagedRecognition(context: WorkflowContext): Promise<void> {
  const image = await context.browser.withPage(async (page) => page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 100;
    const drawing = canvas.getContext("2d")!;
    drawing.fillStyle = "white";
    drawing.fillRect(0, 0, 400, 100);
    drawing.fillStyle = "black";
    drawing.font = "60px Arial";
    drawing.fillText("123456", 20, 75);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }));
  const recognition = await tesseractTextRecognitionEngine.recognize(Buffer.from(image, "base64"), "digits");
  if (recognition.text.replace(/\D/g, "") !== "123456") {
    throw new Error("Packaged OCR fixture did not recognize the synthetic digits.");
  }

  const sherpaModule = await import("sherpa-onnx-node");
  const sherpa = sherpaModule.default ?? sherpaModule;
  const config = defaultSherpaSpeechRecognitionConfig();
  const recognizer = new sherpa.OfflineRecognizer({ modelConfig: {
    paraformer: { model: config.modelPath }, tokens: config.tokensPath,
    numThreads: 1, provider: "cpu", debug: 0,
  } });
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: 16_000, samples: new Float32Array(16_000) });
  recognizer.decode(stream);
  if (typeof recognizer.getResult(stream).text !== "string") {
    throw new Error("Packaged speech model did not return a transcription result.");
  }
  const { MPEGDecoder } = await import("mpg123-decoder");
  const decoder = new MPEGDecoder();
  try { await decoder.ready; } finally { decoder.free(); }
}
