import { PNG } from "pngjs";
import type { PreviewWrite, PreviewWriteReceipt } from "../../ledger/pglite/preview-financial-data.ts";
import type { TextRecognitionEngine } from "../automation/server/text-captcha-solver.ts";
import { createWorkflowExecutor, type WorkflowRunEvent } from "../automation/workflow-executor.ts";
import { classifyTypedWorkflowFailure } from "../automation/server/typed-workflow-outcome.ts";
import type { TypedWorkflowErrorCode } from "../automation/workflow-failures.ts";
import type { PreviewHttp, PreviewHttpOpener, PreviewHttpRequest, PreviewHttpResponse } from "./browser-http.ts";
import { classifyTransport } from "./browser-http.ts";
import type { PreviewSource } from "./registry.ts";
import { previewWorkflowDefinition, type PreviewResponseObservation } from "./workflow.ts";

export type FakeRoute = (request: PreviewHttpRequest, call: number) => PreviewHttpResponse | Promise<PreviewHttpResponse>;

export function blankPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  return PNG.sync.write(png);
}

export type OcrCall = Readonly<{ imagePreprocessing: readonly string[]; ocrPageSegmentationMode: string | undefined }>;

export function scriptedOcrEngine(results: readonly Readonly<{ text: string; confidence: number }>[]): TextRecognitionEngine & { calls: OcrCall[] } {
  const calls: OcrCall[] = [];
  return {
    calls,
    async recognize(_image, _charset, imagePreprocessing, ocrPageSegmentationMode) {
      const result = results[calls.length];
      calls.push({ imagePreprocessing: imagePreprocessing ?? [], ocrPageSegmentationMode });
      if (!result) throw new Error(`OCR call ${calls.length} has no scripted result`);
      return result;
    },
  };
}

export const jsonResponse = (body: unknown, headers: Record<string, string> = {}): PreviewHttpResponse =>
  ({ status: 200, headers, text: typeof body === "string" ? body : JSON.stringify(body) });

/**
 * A scripted HTTP transport for checks. Each request is matched by
 * `METHOD path` (path without query) and answered by its route; an unrouted
 * request fails the check.
 */
export function fakeHttpOpener(routes: Readonly<Record<string, FakeRoute>>): PreviewHttpOpener & { requests: PreviewHttpRequest[] } {
  const requests: PreviewHttpRequest[] = [];
  const calls = new Map<string, number>();
  const http: PreviewHttp = async (request) => {
    requests.push(request);
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const route = routes[key];
    if (!route) throw new Error(`Unrouted fake request: ${key}`);
    const call = calls.get(key) ?? 0;
    calls.set(key, call + 1);
    return classifyTransport(await route(request, call));
  };
  const opener = (async (_context, _session, use) => use(http, async (image) => image)) as PreviewHttpOpener & { requests: PreviewHttpRequest[] };
  opener.requests = requests;
  return opener;
}

export type PreviewRunResult = Readonly<{
  receipt: PreviewWriteReceipt | null;
  writes: readonly PreviewWrite[];
  observations: readonly PreviewResponseObservation[];
  events: readonly Pick<WorkflowRunEvent, "stage" | "code">[];
  error: unknown;
  errorCode: TypedWorkflowErrorCode | null;
}>;

/** Runs a source through the real preview workflow and executor with a recording write port. */
export async function runPreviewSource(
  source: PreviewSource,
  credentials: Readonly<Record<string, string>>,
  now = "2026-10-15T02:00:00.000Z",
): Promise<PreviewRunResult> {
  const writes: PreviewWrite[] = [];
  const observations: PreviewResponseObservation[] = [];
  const events: WorkflowRunEvent[] = [];
  const recording: PreviewSource = {
    ...source,
    run: (context, input) => source.run({
      ...context,
      preview: {
        write: context.preview.write,
        observe(response) {
          observations.push(response);
          context.preview.observe(response);
        },
      },
    }, input),
  };
  const executor = createWorkflowExecutor([previewWorkflowDefinition(recording)], {
    browser: { withPage: async () => { throw new Error("preview source checks open no page"); } },
    text: {} as never,
    humanAssistance: { request: async () => "failed" as const },
    previewWrite: {
      write: async (input) => {
        writes.push(input);
        return {
          accounts: input.collection.accounts.length,
          balances: input.collection.accounts.reduce((sum, account) => sum + account.balances.length, 0),
          transactions: input.collection.accounts.reduce((sum, account) => sum + account.transactions.length, 0),
        };
      },
    },
    events: { append: async (event) => { events.push(event); } },
    now: () => now,
  });
  const signal = new AbortController().signal;
  try {
    const receipt = await executor.run(`preview-${source.id}`, "check-run", { startUrl: source.startUrl, credentials }, signal);
    return { receipt: receipt as PreviewWriteReceipt, writes, observations, events, error: null, errorCode: null };
  } catch (error) {
    return { receipt: null, writes, observations, events, error, errorCode: classifyTypedWorkflowFailure(error, events) };
  }
}
