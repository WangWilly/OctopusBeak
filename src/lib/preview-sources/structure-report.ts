import { inventoryFields, parseFieldInventory, safeRequestPath, type FieldInventory } from "./response-shape.ts";
import { PREVIEW_SOURCES, type PreviewSource } from "./registry.ts";
import { previewTaskId } from "./source-id.ts";
import type { PreviewResponseObservation } from "./workflow.ts";

export type PreviewResponseShape = Readonly<{ endpoint: string; status: number; fields: FieldInventory }>;

export type PreviewResponseShapes = Readonly<{
  responses: readonly PreviewResponseShape[];
  omittedResponses: number;
}>;

export type PreviewStructureReport = Readonly<{
  previewSource: string;
  institution: string;
  product: string;
  failure: Readonly<{ stage: string | null; errorCode: string }>;
}> & PreviewResponseShapes;

const PREVIEW_STRUCTURE_REPORT_FORMAT = "octopusbeak-preview-structure-report/1";
const MAX_PREVIEW_RESPONSES = 50;
export const MAX_PREVIEW_RESPONSE_SHAPES_CHARS = 48_000;
const MAX_FIELDS_PER_RESPONSE = 1_000;
const MAX_ENDPOINT_CHARS = 512;
const ISSUE_URL = "https://github.com/WangWilly/OctopusBeak/issues/new";

function safeEndpoint(endpoint: string) {
  let pathname: string;
  try {
    pathname = new URL(endpoint, "https://preview-source.invalid").pathname;
  } catch {
    return "{endpoint}";
  }
  const safe = safeRequestPath(pathname);
  return safe.length <= MAX_ENDPOINT_CHARS ? safe : "{endpoint}";
}

const safeStatus = (status: number) => (Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0);

const shapesChars = (responses: readonly PreviewResponseShape[]) => JSON.stringify(responses, null, 2).length;

export function previewResponseShapes(observations: readonly PreviewResponseObservation[]): PreviewResponseShapes {
  const recent = observations.slice(-MAX_PREVIEW_RESPONSES);
  const responses: PreviewResponseShape[] = [];
  for (const observation of recent) {
    let fields: FieldInventory;
    try {
      fields = inventoryFields(observation.body);
    } catch {
      continue;
    }
    if (Object.keys(fields).length > MAX_FIELDS_PER_RESPONSE) continue;
    responses.push({ endpoint: safeEndpoint(observation.endpoint), status: safeStatus(observation.status), fields });
  }
  while (responses.length > 0 && shapesChars(responses) > MAX_PREVIEW_RESPONSE_SHAPES_CHARS) responses.shift();
  return { responses, omittedResponses: observations.length - responses.length };
}

function invalidShapes(): never {
  throw new Error("Preview response shapes are invalid.");
}

export function parsePreviewResponseShapes(value: unknown): PreviewResponseShapes {
  if (typeof value !== "object" || value === null) invalidShapes();
  const { responses, omittedResponses, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || !Array.isArray(responses) || responses.length > MAX_PREVIEW_RESPONSES) invalidShapes();
  if (!Number.isSafeInteger(omittedResponses) || (omittedResponses as number) < 0) invalidShapes();
  const parsed = responses.map((response): PreviewResponseShape => {
    if (typeof response !== "object" || response === null) invalidShapes();
    const { endpoint, status, fields, ...extra } = response as Record<string, unknown>;
    if (Object.keys(extra).length > 0) invalidShapes();
    if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT_CHARS) invalidShapes();
    if (endpoint !== "{endpoint}" && (!endpoint.startsWith("/") || safeRequestPath(endpoint) !== endpoint)) invalidShapes();
    if (typeof status !== "number" || safeStatus(status) !== status) invalidShapes();
    return { endpoint, status, fields: parseFieldInventory(fields, MAX_FIELDS_PER_RESPONSE) };
  });
  if (shapesChars(parsed) > MAX_PREVIEW_RESPONSE_SHAPES_CHARS) invalidShapes();
  return { responses: parsed, omittedResponses: omittedResponses as number };
}

export function renderPreviewStructureReport(report: PreviewStructureReport, appVersion: string): string {
  return JSON.stringify({
    format: PREVIEW_STRUCTURE_REPORT_FORMAT,
    appVersion,
    previewSource: report.previewSource,
    institution: report.institution,
    product: report.product,
    failure: report.failure,
    omittedResponses: report.omittedResponses,
    responses: report.responses,
  }, null, 2);
}

export function previewStructureReportIssueUrl(source: PreviewSource): string {
  const url = new URL(ISSUE_URL);
  url.searchParams.set("title", `Preview source report: ${source.displayName.en} ${source.products.join(" ")}`);
  url.searchParams.set("body", [
    "Paste the Preview Structure Report that OctopusBeak showed you between the fences below. Read it before you submit: it lists endpoints, statuses, field names, and value forms, and never account numbers, names, amounts, dates, or free text.",
    "請將 OctopusBeak 顯示的預覽結構報告貼在下方程式碼區塊中。送出前請先閱讀：報告只列出端點、狀態碼、欄位名稱與值的格式，不含帳號、姓名、金額、日期或自由文字。",
    "",
    "```json",
    "",
    "```",
  ].join("\n"));
  return url.toString();
}

export function previewSourceForTask(taskId: string): PreviewSource | null {
  return PREVIEW_SOURCES.find((source) => previewTaskId(source) === taskId) ?? null;
}

const reports = new Map<string, PreviewStructureReport>();

export const previewStructureReports = {
  clear(taskId: string) {
    reports.delete(taskId);
  },
  recordFailure(
    taskId: string,
    failure: Readonly<{ stage: string | null; errorCode: string; shapes: PreviewResponseShapes }>,
  ) {
    const source = previewSourceForTask(taskId);
    if (!source) return;
    reports.set(taskId, {
      previewSource: source.id,
      institution: source.institution,
      product: source.products.join(","),
      failure: { stage: failure.stage, errorCode: failure.errorCode },
      ...failure.shapes,
    });
  },
  get(taskId: string): PreviewStructureReport | null {
    return reports.get(taskId) ?? null;
  },
};
