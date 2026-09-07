declare module "sherpa-onnx-node" {
  export type SherpaOnnxOfflineStream = {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
  };

  export class OfflineRecognizer {
    constructor(config: {
      modelConfig: {
        paraformer?: { model: string };
        tokens?: string;
        numThreads?: number;
        debug?: number;
        provider?: string;
      };
    });
    createStream(): SherpaOnnxOfflineStream;
    decode(stream: SherpaOnnxOfflineStream): void;
    getResult(stream: SherpaOnnxOfflineStream): { text: string };
  }

  export class LinearResampler {
    constructor(inputSampleRate: number, outputSampleRate: number);
    resample(samples: Float32Array): Float32Array;
    flush(samples: Float32Array): Float32Array;
    reset(): void;
  }
}
