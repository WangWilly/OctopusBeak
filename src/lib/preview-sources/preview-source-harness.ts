import { PNG } from "pngjs";
import type {
  PreviewDepositCollection,
  PreviewWrite,
  PreviewWriteReceipt,
} from "../../ledger/pglite/preview-financial-data.ts";
import type { TextRecognitionEngine } from "../automation/server/text-captcha-solver.ts";
import { createWorkflowExecutor, type WorkflowRunEvent } from "../automation/workflow-executor.ts";
import { classifyTypedWorkflowFailure } from "../automation/server/typed-workflow-outcome.ts";
import type { TypedWorkflowErrorCode } from "../automation/workflow-failures.ts";
import type { PreviewHttp, PreviewHttpOpener, PreviewHttpRequest, PreviewHttpResponse } from "./browser-http.ts";
import { classifyTransport } from "./browser-http.ts";
import type { PreviewSource } from "./registry.ts";
import type { PreviewRunOutput } from "./product-collection.ts";
import { previewWorkflowDefinition, type PreviewResponseObservation } from "./workflow.ts";

export type FakeRoute = (request: PreviewHttpRequest, call: number) => PreviewHttpResponse | Promise<PreviewHttpResponse>;

export function blankPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  return PNG.sync.write(png);
}

export type OcrCall = Readonly<{ imagePreprocessing: readonly string[]; ocrPageSegmentationMode: string | undefined; ocrCharacterSegmentation?: string }>;

export function scriptedOcrEngine(results: readonly Readonly<{ text: string; confidence: number }>[]): TextRecognitionEngine & { calls: OcrCall[] } {
  const calls: OcrCall[] = [];
  return {
    calls,
    async recognize(_image, _charset, imagePreprocessing, ocrPageSegmentationMode, _outputStage, ocrCharacterSegmentation) {
      const result = results[calls.length];
      calls.push({ imagePreprocessing: imagePreprocessing ?? [], ocrPageSegmentationMode,
        ...(ocrCharacterSegmentation === undefined ? {} : { ocrCharacterSegmentation }) });
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
  /** The receipts of every write, summed; `null` when the run failed. */
  receipt: PreviewWriteReceipt | null;
  output: PreviewRunOutput | null;
  writes: readonly PreviewWrite[];
  /** The deposit collections written, in order. */
  deposits: readonly PreviewDepositCollection[];
  observations: readonly PreviewResponseObservation[];
  events: readonly Pick<WorkflowRunEvent, "stage" | "code">[];
  error: unknown;
  errorCode: TypedWorkflowErrorCode | null;
}>;

/** Runs a source through the real preview workflow and executor with a recording write port. */
/** The deposit collection of a write, for checks on single-product deposit sources. */
export function depositCollection(write: PreviewWrite): PreviewDepositCollection {
  if (write.product !== "deposit") throw new Error(`expected a deposit write, got ${write.product}`);
  return write.collection;
}

export function previewReceipt(write: PreviewWrite): PreviewWriteReceipt {
  const sum = <T>(items: readonly T[], count: (item: T) => number) => items.reduce((total, item) => total + count(item), 0);
  switch (write.product) {
    case "deposit": return {
      accounts: write.collection.accounts.length,
      balances: sum(write.collection.accounts, (account) => account.balances.length),
      transactions: sum(write.collection.accounts, (account) => account.transactions.length),
      statements: 0,
      closedAccounts: 0,
    };
    case "credit_card": return {
      accounts: write.collection.accounts.length,
      balances: sum(write.collection.accounts, (account) => account.balances.length),
      transactions: sum(write.collection.accounts, (account) => account.purchases.length),
      statements: sum(write.collection.accounts, (account) => account.statements.length),
      closedAccounts: 0,
    };
    case "time_deposit": return {
      accounts: write.collection.deposits.length,
      balances: sum(write.collection.deposits, (deposit) => deposit.balances.length),
      transactions: 0,
      statements: 0,
      closedAccounts: 0,
    };
  }
}

function sumReceipts(receipts: readonly PreviewWriteReceipt[]): PreviewWriteReceipt {
  return receipts.reduce((total, receipt) => ({
    accounts: total.accounts + receipt.accounts,
    balances: total.balances + receipt.balances,
    transactions: total.transactions + receipt.transactions,
    statements: total.statements + receipt.statements,
    closedAccounts: total.closedAccounts + receipt.closedAccounts,
  }), { accounts: 0, balances: 0, transactions: 0, statements: 0, closedAccounts: 0 });
}

export async function runPreviewSource(
  source: PreviewSource,
  credentials: Readonly<Record<string, string>>,
  now = "2026-10-15T02:00:00.000Z",
  products: readonly PreviewWrite["product"][] = source.products,
): Promise<PreviewRunResult> {
  const writes: PreviewWrite[] = [];
  const deposits = () => writes.flatMap((write) => write.product === "deposit" ? [write.collection] : []);
  const observations: PreviewResponseObservation[] = [];
  const events: WorkflowRunEvent[] = [];
  const recording: PreviewSource = {
    ...source,
    run: (context, input) => source.run({
      ...context,
      preview: {
        collect: context.preview.collect,
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
        return previewReceipt(input);
      },
    },
    events: { append: async (event) => { events.push(event); } },
    now: () => now,
  });
  const signal = new AbortController().signal;
  try {
    const output = await executor.run(`preview-${source.id}`, "check-run", { startUrl: source.startUrl, credentials, products }, signal);
    return {
      receipt: sumReceipts(writes.map(previewReceipt)),
      output: output as PreviewRunOutput,
      writes,
      deposits: deposits(),
      observations,
      events,
      error: null,
      errorCode: null,
    };
  } catch (error) {
    return {
      receipt: null, output: null, writes, deposits: deposits(), observations, events, error,
      errorCode: classifyTypedWorkflowFailure(error, events),
    };
  }
}
