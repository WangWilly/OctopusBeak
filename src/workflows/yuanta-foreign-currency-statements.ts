import { mkdir, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { workflow, type LibrettoWorkflowContext } from "libretto";
import type { Download, Frame, Locator, Page } from "playwright";
import { z } from "zod";
import { parseCsvMatrix } from "../lib/tabular-text.ts";
import {
  parseFragment,
  type DefaultTreeAdapterTypes,
} from "parse5";
import { hasAttachedLocator } from "./browser-interaction.js";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import {
  authenticateYuantaBank as sharedAuthenticateYuantaBank,
  type YuantaCredentials,
} from "./yuanta-auth.ts";
import {
  commitForeignCurrencyDepositCaptureBatch,
  type ForeignCurrencyDepositCaptureInput,
  type ForeignCurrencyDepositCommitStore,
} from "../ledger/canonical/foreign-currency-deposit.ts";
import {
  canonicalSqlitePath,
  createCanonicalSourceStore,
} from "../ledger/canonical/canonical-source-store.ts";
import {
  deriveYuantaForeignSettlementLinkageKey,
  resolveCanonicalInvestmentFundingRelations,
  YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
} from "../ledger/canonical/investment-funding-relations.ts";

const big5Decoder = new TextDecoder("big5");

type BrowserScope = Page | Frame;

type AccountOption = {
  label: string;
  value: string;
};

type CurrencyOption = {
  label: string;
  value: string;
};

const quickDateRangeSchema = z.enum(["one_week", "one_month", "three_months"]);

const channelTypeSchema = z.enum([
  "all",
  "online_bank",
  "voice",
  "business_bank",
  "mobile_bank",
]);

const customDateRangeSchema = z.object({
  startDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
  endDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
});

const inputSchema = z.object({
  dateRange: quickDateRangeSchema.default("three_months"),
  customDateRange: customDateRangeSchema.optional(),
  accountFilters: z.array(z.string()).default([]),
  currencyFilters: z.array(z.string()).default([]),
  channelType: channelTypeSchema.default("all"),
  replaceActiveSession: z.boolean().default(true),
});

const tableFileSchema = z.object({
  baseName: z.string(),
  kind: z.literal("foreign-currency-transactions"),
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
  accounts: z.array(z.string()),
  currencies: z.array(z.string()),
  dateRange: z.string(),
  channelType: channelTypeSchema,
  csvFilename: z.string(),
  jsonFilename: z.string(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  dateRange: z.string(),
  channelType: channelTypeSchema,
  usedExistingSession: z.boolean(),
  replacedActiveSession: z.boolean(),
  count: z.number().int().nonnegative(),
  files: z.array(tableFileSchema),
});

type WorkflowInput = z.infer<typeof inputSchema>;
type TableFile = z.infer<typeof tableFileSchema>;

type SourceDownloadMetadata = {
  accountValue: string;
  account: string;
  currency: string;
  filename: string;
  rowCount: number;
};

type ForeignCurrencyTransactionRow = {
  accountLabel: string;
  accountValue: string;
  queryCurrencyLabel: string;
  queryCurrencyValue: string;
  values: string[];
  sortTime: number | null;
};

const dateRangeLabels: Record<z.infer<typeof quickDateRangeSchema>, string> = {
  one_week: "一週",
  one_month: "一個月",
  three_months: "三個月",
};

const channelTypeValues: Record<z.infer<typeof channelTypeSchema>, string> = {
  all: "A",
  online_bank: "N",
  voice: "I",
  business_bank: "C",
  mobile_bank: "O",
};

const foreignCurrencyTransactionHeaders = [
  "帳戶名稱",
  "查詢幣別",
  "帳號",
  "帳務日期",
  "交易日期",
  "交易時間",
  "幣別",
  "交易說明",
  "支出金額",
  "存入金額",
  "帳面餘額",
  "交易資訊",
  "匯率",
];

const downloadedForeignCurrencyHeaders =
  foreignCurrencyTransactionHeaders.slice(2);

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Result-page contract for the Yuanta foreign-currency statement endpoint.
 *
 * The provider has changed the markup around this control before. Keep the
 * contract structural and versioned: the timestamp result marker, a nearby
 * non-empty statement table, and one explicit CSV link must all be present.
 * Raw result markup is never emitted by the workflow.
 */
export const YUANTA_FOREIGN_RESULT_RULE_VERSION =
  "yuanta-foreign-result-v2" as const;

export type YuantaForeignCurrencyResultState =
  | "download-ready"
  | "provider-no-data"
  | "provider-error"
  | "pending";

export type YuantaForeignCurrencyResultClassification = {
  state: YuantaForeignCurrencyResultState;
  hasResult: boolean;
  csvControlCount: number;
  controlKinds: readonly YuantaForeignCurrencyControlKind[];
  noticeKinds: readonly ("provider-no-data" | "provider-error")[];
};

type YuantaForeignCurrencyControlKind =
  | "link"
  | "button"
  | "form"
  | "input"
  | "role-button";

const diagnosticTagCategories = [
  "a",
  "article",
  "aside",
  "button",
  "div",
  "form",
  "h1",
  "h2",
  "h3",
  "iframe",
  "input",
  "label",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "output",
  "p",
  "section",
  "select",
  "span",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "other",
] as const;

type YuantaForeignCurrencyDiagnosticTagCategory =
  (typeof diagnosticTagCategories)[number];

const diagnosticControlTypes = [
  "link",
  "button",
  "form",
  "role-button",
  "input:button",
  "input:checkbox",
  "input:file",
  "input:hidden",
  "input:image",
  "input:radio",
  "input:reset",
  "input:submit",
  "input:text",
  "input:other",
] as const;

type YuantaForeignCurrencyDiagnosticControlType =
  (typeof diagnosticControlTypes)[number];

type YuantaForeignCurrencyResultDiagnostic = {
  containerTag: YuantaForeignCurrencyDiagnosticTagCategory;
  containerType: "id" | "class" | "data" | "unknown";
  descendantTagCounts: Readonly<
    Record<YuantaForeignCurrencyDiagnosticTagCategory, number>
  >;
  controlKindCounts: Readonly<Record<YuantaForeignCurrencyControlKind, number>>;
  controlTypeCounts: Readonly<
    Record<YuantaForeignCurrencyDiagnosticControlType, number>
  >;
  tableCount: number;
  headerCount: number;
  dataRowCountBucket: "0" | "1" | "2-10" | "11+";
  formCount: number;
  formActionKinds: readonly ("none" | "csv" | "statement" | "other")[];
  visibility: "visible" | "hidden" | "unknown";
  disabledControlCount: number;
  knownLabelIds: readonly string[];
  textLengthBucket: "0" | "1-32" | "33-128" | "129-512" | "513+";
  textHash: string;
};

type YuantaForeignCurrencyResultDiagnosticOverflowBucket =
  | "0"
  | "1-10"
  | "11-50"
  | "51+";

type YuantaForeignCurrencyResultDiagnostics = {
  resultContainers: readonly YuantaForeignCurrencyResultDiagnostic[];
  resultContainerOverflowCount: number;
  resultContainerOverflowBucket: YuantaForeignCurrencyResultDiagnosticOverflowBucket;
};

const MAX_RESULT_CONTAINER_DIAGNOSTICS = 32;

type HtmlNode = DefaultTreeAdapterTypes.Node;
type HtmlElement = DefaultTreeAdapterTypes.Element;

function isHtmlElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function htmlAttribute(element: HtmlElement, name: string): string {
  return (
    element.attrs.find((attribute) => attribute.name === name.toLowerCase())
      ?.value ?? ""
  );
}

function hasHtmlAttribute(element: HtmlElement, name: string): boolean {
  return element.attrs.some(
    (attribute) => attribute.name === name.toLowerCase(),
  );
}

function htmlNodeText(node: HtmlNode): string {
  if ("value" in node) return node.value;
  if (!("childNodes" in node)) return "";
  return node.childNodes.map(htmlNodeText).join(" ");
}

function htmlDescendants(node: HtmlNode): HtmlElement[] {
  if (!("childNodes" in node)) return [];
  return node.childNodes.flatMap((child) =>
    isHtmlElement(child)
      ? [child, ...htmlDescendants(child)]
      : htmlDescendants(child),
  );
}

type HtmlElementContext = {
  element: HtmlElement;
  parent: HtmlElement | null;
  ancestors: readonly HtmlElement[];
  depth: number;
};

function htmlElementContexts(
  node: HtmlNode,
  parent: HtmlElement | null = null,
  ancestors: readonly HtmlElement[] = [],
  depth = 0,
): HtmlElementContext[] {
  if (!("childNodes" in node)) return [];
  return node.childNodes.flatMap((child) => {
    if (!isHtmlElement(child)) return [];
    const context: HtmlElementContext = {
      element: child,
      parent,
      ancestors,
      depth,
    };
    return [
      context,
      ...htmlElementContexts(child, child, [...ancestors, child], depth + 1),
    ];
  });
}

function parseHtmlElementContexts(html: string): HtmlElementContext[] {
  try {
    return htmlElementContexts(parseFragment(html));
  } catch {
    return [];
  }
}

function parseHtmlFragment(html: string): HtmlElement[] {
  try {
    return htmlDescendants(parseFragment(html));
  } catch {
    return [];
  }
}

function htmlControlTag(
  element: HtmlElement,
): YuantaForeignCurrencyControlKind | null {
  if (element.tagName === "a") return "link";
  if (element.tagName === "button") return "button";
  if (element.tagName === "form") return "form";
  if (element.tagName === "input") return "input";
  if (htmlAttribute(element, "role").toLowerCase() === "button") {
    return "role-button";
  }
  return null;
}

function htmlControlEvidence(element: HtmlElement): string {
  const attrs = element.attrs.flatMap((attribute) => [
    attribute.name,
    attribute.value,
  ]);
  return [htmlNodeText(element), ...attrs].join(" ");
}

function normalizedProviderLabel(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\u3000]+/gu, "")
    .replace(/[：:()[\]{}<>「」『』"'`.,，。/\\_\-]+/gu, "");
}

function isCsvDownloadLabel(value: string): boolean {
  const normalized = normalizedProviderLabel(value);
  const hasCsv = /csv/u.test(normalized);
  const hasDownloadVerb = /下載|download|匯出|export|輸出/u.test(normalized);
  return hasCsv && hasDownloadVerb;
}

type YuantaForeignCurrencyControlCandidate = {
  tagName: string;
  type: string;
  disabled: boolean;
  evidence: string;
};

function isYuantaForeignCurrencyCsvControlCandidate(
  candidate: YuantaForeignCurrencyControlCandidate,
): boolean {
  if (
    candidate.tagName === "input" &&
    candidate.type &&
    !["submit", "button", "image"].includes(candidate.type)
  ) {
    return false;
  }
  return !candidate.disabled && isCsvDownloadLabel(candidate.evidence);
}

function isYuantaForeignCurrencyCsvControlElement(
  element: HtmlElement,
): boolean {
  if (!htmlControlTag(element)) return false;
  return isYuantaForeignCurrencyCsvControlCandidate({
    tagName: element.tagName,
    type: htmlAttribute(element, "type").toLowerCase(),
    disabled:
      hasHtmlAttribute(element, "disabled") ||
      htmlAttribute(element, "aria-disabled").toLowerCase() === "true",
    evidence: htmlControlEvidence(element),
  });
}

function isExplicitYuantaForeignCurrencyCsvLinkElement(
  element: HtmlElement,
): boolean {
  if (element.tagName !== "a") return false;
  if (
    hasHtmlAttribute(element, "disabled") ||
    htmlAttribute(element, "aria-disabled").toLowerCase() === "true"
  ) {
    return false;
  }
  const labelEvidence = [
    htmlNodeText(element),
    htmlAttribute(element, "aria-label"),
    htmlAttribute(element, "title"),
    htmlAttribute(element, "data-action"),
    htmlAttribute(element, "data-command"),
    htmlAttribute(element, "download"),
  ].join(" ");
  return isCsvDownloadLabel(labelEvidence);
}

const diagnosticControlKinds = [
  "link",
  "button",
  "form",
  "input",
  "role-button",
] as const satisfies readonly YuantaForeignCurrencyControlKind[];

const diagnosticTagCategorySet = new Set<string>(diagnosticTagCategories);

function diagnosticTagCategory(
  tagName: string,
): YuantaForeignCurrencyDiagnosticTagCategory {
  return diagnosticTagCategorySet.has(tagName)
    ? (tagName as YuantaForeignCurrencyDiagnosticTagCategory)
    : "other";
}

function zeroDiagnosticCounts<const Key extends string>(
  keys: readonly Key[],
): Record<Key, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
}

function resultDiagnosticLengthBucket(
  length: number,
): "0" | "1-32" | "33-128" | "129-512" | "513+" {
  if (length === 0) return "0";
  if (length <= 32) return "1-32";
  if (length <= 128) return "33-128";
  if (length <= 512) return "129-512";
  return "513+";
}

function resultDiagnosticRowBucket(
  count: number,
): "0" | "1" | "2-10" | "11+" {
  if (count === 0) return "0";
  if (count === 1) return "1";
  if (count <= 10) return "2-10";
  return "11+";
}

function resultDiagnosticVisibility(
  element: HtmlElement,
): "visible" | "hidden" | "unknown" {
  const ariaHidden = htmlAttribute(element, "aria-hidden")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
  const normalizedStyle = htmlAttribute(element, "style")
    .normalize("NFKC")
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/gu, "")
    .toLowerCase();
  if (
    hasHtmlAttribute(element, "hidden") ||
    ariaHidden === "true" ||
    /(?:display\s*:\s*none|visibility\s*:\s*hidden)/u.test(normalizedStyle)
  ) {
    return "hidden";
  }
  return "unknown";
}

function diagnosticControlType(
  element: HtmlElement,
  kind: YuantaForeignCurrencyControlKind,
): YuantaForeignCurrencyDiagnosticControlType {
  if (kind === "role-button") return "role-button";
  if (element.tagName !== "input") {
    return kind === "input" ? "input:other" : kind;
  }
  const type = htmlAttribute(element, "type").toLowerCase();
  const inputTypes = [
    "button",
    "checkbox",
    "file",
    "hidden",
    "image",
    "radio",
    "reset",
    "submit",
    "text",
  ] as const;
  return inputTypes.includes(type as (typeof inputTypes)[number])
    ? (`input:${type}` as YuantaForeignCurrencyDiagnosticControlType)
    : "input:other";
}

function diagnosticFormActionKind(
  form: HtmlElement,
): "none" | "csv" | "statement" | "other" {
  const action = normalizedProviderLabel(htmlAttribute(form, "action"));
  if (!action) return "none";
  if (/csv|download|export|匯出|下載/u.test(action)) return "csv";
  if (/fx|foreign|transaction|statement|detail|交易|明細/u.test(action)) {
    return "statement";
  }
  return "other";
}

function diagnosticContainerType(
  result: HtmlElement,
): "id" | "class" | "data" | "unknown" {
  if (htmlAttribute(result, "id")) return "id";
  if (htmlAttribute(result, "class")) return "class";
  if (
    hasHtmlAttribute(result, "data-result-container") ||
    hasHtmlAttribute(result, "data-result")
  ) {
    return "data";
  }
  return "unknown";
}

function diagnosticKnownLabelIds(elements: readonly HtmlElement[]): string[] {
  const ids = new Set<string>();
  for (const element of elements) {
    const attributes = element.attrs.map((attribute) =>
      normalizedProviderLabel(attribute.value),
    );
    const value = attributes.join(" ");
    if (
      /(?:csv.*(?:下載|download|匯出|export)|(?:下載|download|匯出|export).*csv)/u.test(
        value,
      )
    ) {
      ids.add("csv-download");
    }
    if (/result|結果/u.test(value)) ids.add("result");
    if (/foreign|currency|外幣|fx/u.test(value)) ids.add("foreign-currency");
    if (/transaction|statement|detail|交易|明細/u.test(value)) {
      ids.add("transaction");
    }
    if (/error|failed|failure|錯誤|失敗/u.test(value)) {
      ids.add("provider-error");
    }
    if (
      /nodata|norecords|notransactions|noresult|empty|查無|無資料/u.test(value)
    ) {
      ids.add("provider-no-data");
    }
  }
  return [...ids].sort();
}

function diagnoseYuantaForeignCurrencyResultElement(
  result: HtmlElement,
  visibility?: "visible" | "hidden" | "unknown",
): YuantaForeignCurrencyResultDiagnostic {
  const descendants = htmlDescendants(result);
  const controls = descendants
    .map((element) => ({ element, kind: htmlControlTag(element) }))
    .filter(
      (
        control,
      ): control is {
        element: HtmlElement;
        kind: YuantaForeignCurrencyControlKind;
      } => control.kind !== null,
    );
  const descendantTagCounts = zeroDiagnosticCounts(diagnosticTagCategories);
  for (const element of descendants) {
    descendantTagCounts[diagnosticTagCategory(element.tagName)] += 1;
  }
  const controlKindCounts = zeroDiagnosticCounts(diagnosticControlKinds);
  const controlTypeCounts = zeroDiagnosticCounts(diagnosticControlTypes);
  for (const control of controls) {
    controlKindCounts[control.kind] += 1;
    const type = diagnosticControlType(control.element, control.kind);
    controlTypeCounts[type] += 1;
  }
  const rows = descendants.filter((element) => element.tagName === "tr");
  const headerCount = descendants.filter((element) => element.tagName === "th").length;
  const dataRowCount = rows.filter(
    (row) => !htmlDescendants(row).some((element) => element.tagName === "th"),
  ).length;
  const forms = descendants.filter((element) => element.tagName === "form");
  const normalizedText = normalizedProviderLabel(htmlNodeText(result));
  return {
    containerTag: diagnosticTagCategory(result.tagName),
    containerType: diagnosticContainerType(result),
    descendantTagCounts,
    controlKindCounts,
    controlTypeCounts,
    tableCount: descendants.filter((element) => element.tagName === "table").length,
    headerCount,
    dataRowCountBucket: resultDiagnosticRowBucket(dataRowCount),
    formCount: forms.length,
    formActionKinds: [...new Set(forms.map(diagnosticFormActionKind))].sort(),
    visibility: visibility ?? resultDiagnosticVisibility(result),
    disabledControlCount: controls.filter(
      ({ element }) =>
        hasHtmlAttribute(element, "disabled") ||
        htmlAttribute(element, "aria-disabled").toLowerCase() === "true",
    ).length,
    knownLabelIds: diagnosticKnownLabelIds([result, ...descendants]),
    textLengthBucket: resultDiagnosticLengthBucket(normalizedText.length),
    textHash: createHash("sha256")
      .update(normalizedText)
      .digest("hex")
      .slice(0, 16),
  };
}

function resultDiagnosticOverflowBucket(
  count: number,
): YuantaForeignCurrencyResultDiagnosticOverflowBucket {
  if (count === 0) return "0";
  if (count <= 10) return "1-10";
  if (count <= 50) return "11-50";
  return "51+";
}

function capYuantaForeignCurrencyResultDiagnostics(
  diagnostics: readonly YuantaForeignCurrencyResultDiagnostic[],
  existingOverflowCount = 0,
): YuantaForeignCurrencyResultDiagnostics {
  const overflowCount =
    existingOverflowCount +
    Math.max(0, diagnostics.length - MAX_RESULT_CONTAINER_DIAGNOSTICS);
  return {
    resultContainers: diagnostics.slice(0, MAX_RESULT_CONTAINER_DIAGNOSTICS),
    resultContainerOverflowCount: overflowCount,
    resultContainerOverflowBucket: resultDiagnosticOverflowBucket(overflowCount),
  };
}

/**
 * Return only structural, bounded diagnostics for recognized result
 * containers. It deliberately omits all raw provider text and cell values.
 */
export function diagnoseYuantaForeignCurrencyResultMarkup(
  html: string,
  visibility?: "visible" | "hidden" | "unknown",
): YuantaForeignCurrencyResultDiagnostics {
  const diagnostics = parseHtmlFragment(html)
    .filter(isResultContainer)
    .map((result) => diagnoseYuantaForeignCurrencyResultElement(result, visibility));
  return capYuantaForeignCurrencyResultDiagnostics(diagnostics);
}

/**
 * True when a link/button/form/input contains provider-controlled evidence
 * that it submits or starts a CSV export. The source text is only inspected
 * in memory; callers must not log it.
 */
export function isYuantaForeignCurrencyCsvControl(controlHtml: string): boolean {
  return parseHtmlFragment(controlHtml).some(
    isYuantaForeignCurrencyCsvControlElement,
  );
}

function isResultContainer(element: HtmlElement): boolean {
  const id = htmlAttribute(element, "id").toLowerCase();
  const classTokens = htmlAttribute(element, "class")
    .split(/\s+/u)
    .map((value) => value.toLowerCase());
  return (
    id === "resultdiv" ||
    id === "result" ||
    id === "resultcontainer" ||
    id === "resultarea" ||
    classTokens.some((value) =>
      [
        "result",
        "resultdiv",
        "resultcontainer",
        "result-area",
        "result-container",
      ].includes(value),
    ) ||
    hasHtmlAttribute(element, "data-result-container") ||
    hasHtmlAttribute(element, "data-result")
  );
}

type YuantaForeignCurrencyTableMatch = {
  tableIndex: number;
  linkIndex: number;
  associationKey: string;
};

type YuantaForeignCurrencyCsvLinkIdentity = {
  text: string;
  className: string;
  href: string;
  ariaLabel: string;
  title: string;
  onclick: string;
  dataAction: string;
  dataCommand: string;
  download: string;
};

function isWithinRecognizedResult(context: HtmlElementContext): boolean {
  return (
    isResultContainer(context.element) ||
    context.ancestors.some(isResultContainer)
  );
}

function tableDataRowCount(table: HtmlElement): number {
  return htmlDescendants(table)
    .filter((element) => element.tagName === "tr")
    .filter(
      (row) =>
        !htmlDescendants(row).some((element) => element.tagName === "th") &&
        htmlDescendants(row).some((element) => element.tagName === "td"),
    ).length;
}

function isYuantaForeignCurrencyProviderTable(table: HtmlElement): boolean {
  const descendants = htmlDescendants(table);
  const headerCount = descendants.filter(
    (element) => element.tagName === "th",
  ).length;
  return headerCount > 0 && tableDataRowCount(table) > 0;
}

function isYuantaForeignCurrencyTimestampResult(
  result: HtmlElement,
): boolean {
  const directChildren = result.childNodes.filter(isHtmlElement);
  if (directChildren.length !== 2) return false;
  const heading = normalizedProviderLabel(htmlNodeText(directChildren[0]!));
  const timestamp = normalizedProviderLabel(htmlNodeText(directChildren[1]!));
  return (
    directChildren[0]!.tagName === "h2" &&
    directChildren[1]!.tagName === "p" &&
    /查詢結果|queryresult|result/u.test(heading) &&
    /查詢時間|查詢日期|querytime|querydate/u.test(timestamp)
  );
}

function nearestCommonElementAncestor(
  left: HtmlElementContext,
  right: HtmlElementContext,
): HtmlElement | null {
  const rightAncestors = new Set(right.ancestors);
  for (const ancestor of [...left.ancestors].reverse()) {
    if (ancestor.tagName === "body" || ancestor.tagName === "html") continue;
    if (rightAncestors.has(ancestor)) return ancestor;
  }
  return null;
}

function structuralElementIdentity(element: HtmlElement): string {
  const classTokens = htmlAttribute(element, "class")
    .split(/\s+/u)
    .filter(Boolean)
    .sort()
    .join(".");
  return [
    element.tagName,
    htmlAttribute(element, "id"),
    classTokens,
    htmlAttribute(element, "role"),
    hasHtmlAttribute(element, "data-result-container") ? "data-result" : "",
    hasHtmlAttribute(element, "data-result") ? "data-result-marker" : "",
  ].join("|");
}

function structuralPathFromAncestor(
  context: HtmlElementContext,
  ancestor: HtmlElement,
): string | null {
  const ancestorIndex = context.ancestors.indexOf(ancestor);
  if (ancestorIndex < 0) return null;

  const nodes = [...context.ancestors.slice(ancestorIndex + 1), context.element];
  return nodes.map(structuralElementIdentity).join("/");
}

function yuantaForeignCurrencyAssociationKey(
  tableContext: HtmlElementContext,
  linkContext: HtmlElementContext,
  ancestor: HtmlElement,
): string | null {
  const tablePath = structuralPathFromAncestor(tableContext, ancestor);
  const linkPath = structuralPathFromAncestor(linkContext, ancestor);
  if (!tablePath || !linkPath) return null;
  return [
    "yuanta-foreign-csv-association-v1",
    structuralElementIdentity(ancestor),
    tablePath,
    linkPath,
  ].join("|");
}

function isContainedBy(
  context: HtmlElementContext,
  ancestor: HtmlElement,
): boolean {
  return context.element === ancestor || context.ancestors.includes(ancestor);
}

function findYuantaForeignCurrencyTableMatches(
  html: string,
): {
  hasTimestampResult: boolean;
  matches: readonly YuantaForeignCurrencyTableMatch[];
} {
  const contexts = parseHtmlElementContexts(html);
  const resultContexts = contexts.filter(
    (context) =>
      isResultContainer(context.element) &&
      isYuantaForeignCurrencyTimestampResult(context.element),
  );
  if (resultContexts.length === 0) {
    return { hasTimestampResult: false, matches: [] };
  }

  const allTableContexts = contexts.filter(
    (context) => context.element.tagName === "table",
  );
  const tableContexts = allTableContexts.filter(
    (context) =>
      !isWithinRecognizedResult(context) &&
      isYuantaForeignCurrencyProviderTable(context.element),
  );
  const anchorContexts = contexts.filter(
    (context) =>
      !isWithinRecognizedResult(context) &&
      isExplicitYuantaForeignCurrencyCsvLinkElement(context.element),
  );
  const matches: YuantaForeignCurrencyTableMatch[] = [];
  for (const linkContext of anchorContexts) {
    const ancestorCandidates = tableContexts.filter((tableContext) => {
      const ancestor = nearestCommonElementAncestor(linkContext, tableContext);
      if (!ancestor) return false;
      const localTables = tableContexts.filter((candidate) =>
        isContainedBy(candidate, ancestor),
      );
      const localLinks = anchorContexts.filter((candidate) =>
        isContainedBy(candidate, ancestor),
      );
      return localTables.length === 1 && localLinks.length === 1;
    });
    if (ancestorCandidates.length !== 1) continue;
    const tableContext = ancestorCandidates[0]!;
    const ancestor = nearestCommonElementAncestor(linkContext, tableContext);
    if (!ancestor) continue;
    const associationKey = yuantaForeignCurrencyAssociationKey(
      tableContext,
      linkContext,
      ancestor,
    );
    if (!associationKey) continue;
    matches.push({
      tableIndex: allTableContexts.indexOf(tableContext),
      linkIndex: contexts.filter((context) => context.element.tagName === "a").indexOf(linkContext),
      associationKey,
    });
  }
  return { hasTimestampResult: true, matches };
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function stableYuantaForeignCurrencyCsvLinkSelector(
  identity: YuantaForeignCurrencyCsvLinkIdentity,
): string | null {
  const attributes = [
    ["class", identity.className],
    ["href", identity.href],
    ["aria-label", identity.ariaLabel],
    ["title", identity.title],
    ["onclick", identity.onclick],
    ["data-action", identity.dataAction],
    ["data-command", identity.dataCommand],
    ["download", identity.download],
  ].filter(([, value]) => value.length > 0);
  if (attributes.length > 0) {
    return `a${attributes
      .map(([name, value]) => `[${name}="${cssAttributeValue(value)}"]`)
      .join("")}`;
  }
  return null;
}

function isSameYuantaForeignCurrencyCsvLinkIdentity(
  left: YuantaForeignCurrencyCsvLinkIdentity,
  right: YuantaForeignCurrencyCsvLinkIdentity,
): boolean {
  return (
    left.text === right.text &&
    left.className === right.className &&
    left.href === right.href &&
    left.ariaLabel === right.ariaLabel &&
    left.title === right.title &&
    left.onclick === right.onclick &&
    left.dataAction === right.dataAction &&
    left.dataCommand === right.dataCommand &&
    left.download === right.download
  );
}

function providerNoticeKinds(
  result: HtmlElement,
): readonly ("provider-no-data" | "provider-error")[] {
  const notices = [result, ...htmlDescendants(result)].filter(
    isYuantaForeignCurrencyProviderNoticeElement,
  );
  const kinds = new Set<"provider-no-data" | "provider-error">();
  for (const notice of notices) {
    // A result/message wrapper around a transaction table is not itself a
    // provider notice. Inspect only structured notices that cannot contain
    // transaction rows, so a transaction description containing "error" does
    // not turn a valid download into an error state.
    if (htmlDescendants(notice).some(isTableElement)) continue;

    const state = normalizedProviderLabel(
      [
        htmlAttribute(notice, "data-result-state"),
        htmlAttribute(notice, "data-state"),
        htmlAttribute(notice, "data-status"),
      ].join(" "),
    );
    const text = normalizedProviderLabel(htmlNodeText(notice));
    if (
      /(?:查無(?:交易|資料|紀錄)|無(?:可用)?(?:交易|資料|紀錄)|沒有(?:交易|資料|紀錄)|nodata|norecords|notransactions|noresult|emptyresult)/u.test(
        `${state}${text}`,
      )
    ) {
      kinds.add("provider-no-data");
    }
    if (
      /(?:查詢失敗|系統(?:錯誤|異常|忙碌)|請稍後再試|error|failed|failure|unavailable)/u.test(
        `${state}${text}`,
      )
    ) {
      kinds.add("provider-error");
    }
  }
  return [...kinds];
}

function isTableElement(element: HtmlElement): boolean {
  return ["table", "thead", "tbody", "tfoot", "tr", "td", "th"].includes(
    element.tagName,
  );
}

function isYuantaForeignCurrencyProviderNoticeElement(
  element: HtmlElement,
): boolean {
  if (isTableElement(element)) return false;
  const role = htmlAttribute(element, "role").toLowerCase();
  if (role === "alert" || role === "status") return true;

  const marker = [
    htmlAttribute(element, "id"),
    htmlAttribute(element, "class"),
    htmlAttribute(element, "aria-live"),
    htmlAttribute(element, "data-result-state"),
    htmlAttribute(element, "data-state"),
    htmlAttribute(element, "data-status"),
  ]
    .join(" ")
    .toLowerCase();
  return /(?:^|[\s_-])(?:notice|message|alert|warning|error|failure|empty|no[-_]?data|result[-_](?:message|status|error|empty))(?:$|[\s_-])/u.test(
    marker,
  );
}

function classifyYuantaForeignCurrencyResultElement(
  result: HtmlElement,
): YuantaForeignCurrencyResultClassification {
  const csvControls = htmlDescendants(result).filter(
    isYuantaForeignCurrencyCsvControlElement,
  );
  const controlKinds = [
    ...new Set(
      csvControls
        .map((element) => htmlControlTag(element))
        .filter(
          (value): value is YuantaForeignCurrencyControlKind => value !== null,
        ),
    ),
  ];
  const noticeKinds = providerNoticeKinds(result);
  const state: YuantaForeignCurrencyResultState =
    csvControls.length > 0
      ? "download-ready"
      : noticeKinds.includes("provider-error")
        ? "provider-error"
        : noticeKinds.includes("provider-no-data")
          ? "provider-no-data"
          : "pending";
  return {
    state,
    hasResult: true,
    csvControlCount: csvControls.length,
    controlKinds,
    noticeKinds,
  };
}

function combineYuantaForeignCurrencyResultClassifications(
  classifications: readonly YuantaForeignCurrencyResultClassification[],
): YuantaForeignCurrencyResultClassification {
  const ready = classifications.find(
    (classification) => classification.state === "download-ready",
  );
  const noticeKinds = [
    ...new Set(classifications.flatMap((classification) => classification.noticeKinds)),
  ];
  const controlKinds = [
    ...new Set(classifications.flatMap((classification) => classification.controlKinds)),
  ];
  if (ready) {
    return {
      state: "download-ready",
      hasResult: true,
      csvControlCount: ready.csvControlCount,
      controlKinds,
      noticeKinds,
    };
  }

  const state = classifications.some(
    (classification) => classification.state === "provider-error",
  )
    ? "provider-error"
    : classifications.some(
        (classification) => classification.state === "provider-no-data",
      )
      ? "provider-no-data"
      : "pending";
  return {
    state,
    hasResult: classifications.some((classification) => classification.hasResult),
    csvControlCount: 0,
    controlKinds,
    noticeKinds,
  };
}

/**
 * Classify a sanitized result-page HTML snapshot. Multiple recognized result
 * containers are possible while a provider replaces an old query result; a
 * ready container wins over stale pending/error containers.
 */
export function classifyYuantaForeignCurrencyResultMarkup(
  html: string,
): YuantaForeignCurrencyResultClassification {
  const classifications = parseHtmlFragment(html)
    .filter(isResultContainer)
    .map(classifyYuantaForeignCurrencyResultElement);
  return combineYuantaForeignCurrencyResultClassifications(classifications);
}

const yuantaForeignResultSelectors = [
  "#resultdiv",
  "#resultDiv",
  "#result",
  "#resultContainer",
  "#resultArea",
  '[data-result-container]',
  '[data-result]',
  ".resultdiv",
  ".resultDiv",
  ".result",
  ".result-container",
  ".result-area",
] as const;

const yuantaForeignResultSelector = yuantaForeignResultSelectors.join(",");

export type YuantaForeignCurrencyFrameRouteCategory =
  | "fxtransactiondetails"
  | "login"
  | "menu"
  | "other";

type YuantaForeignResultObservation = {
  framePath: YuantaForeignCurrencyFrameRouteCategory;
  framePathHash: string;
  resultPresent: boolean;
  state: YuantaForeignCurrencyResultState;
  csvControlCount: number;
  controlKinds: readonly YuantaForeignCurrencyControlKind[];
  noticeKinds: readonly ("provider-no-data" | "provider-error")[];
  resultContainers: readonly YuantaForeignCurrencyResultDiagnostic[];
  resultContainerOverflowCount: number;
  resultContainerOverflowBucket: YuantaForeignCurrencyResultDiagnosticOverflowBucket;
};

const yuantaForeignFramePathHashDomain =
  "yuanta-foreign-result-frame-path-v1\0";

export function classifyYuantaForeignCurrencyFrameRoute(
  pathname: string,
): YuantaForeignCurrencyFrameRouteCategory {
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (segments.includes("fxtransactiondetails")) return "fxtransactiondetails";
  if (
    segments.some((segment) =>
      ["login", "loginpage", "signin", "signon"].includes(segment),
    )
  ) {
    return "login";
  }
  if (
    segments.some((segment) =>
      ["menu", "mainmenu", "functionoverview", "overview"].includes(segment),
    )
  ) {
    return "menu";
  }
  return "other";
}

function hashYuantaForeignFramePath(pathname: string): string {
  return createHash("sha256")
    .update(yuantaForeignFramePathHashDomain)
    .update(pathname)
    .digest("hex")
    .slice(0, 16);
}

function frameRouteObservation(scope: BrowserScope): {
  framePath: YuantaForeignCurrencyFrameRouteCategory;
  framePathHash: string;
} {
  try {
    const pathname = new URL(scope.url()).pathname;
    return {
      framePath: classifyYuantaForeignCurrencyFrameRoute(pathname),
      framePathHash: hashYuantaForeignFramePath(pathname),
    };
  } catch {
    return {
      framePath: "other",
      framePathHash: hashYuantaForeignFramePath(""),
    };
  }
}

async function findYuantaForeignCurrencyResults(
  scope: BrowserScope,
): Promise<Locator[]> {
  const results = scope.locator(yuantaForeignResultSelector);
  const count = await results.count().catch(() => 0);
  return Array.from({ length: count }, (_, index) => results.nth(index));
}

async function hasVisibleYuantaForeignCurrencyTimestampResult(
  results: readonly Locator[],
): Promise<boolean> {
  for (const result of results) {
    if (!(await result.isVisible().catch(() => false))) continue;
    const markup = await result
      .evaluate((element) => element.outerHTML)
      .catch(() => "");
    if (
      parseHtmlFragment(markup).some(
        (element) =>
          isResultContainer(element) &&
          isYuantaForeignCurrencyTimestampResult(element),
      )
    ) {
      return true;
    }
  }
  return false;
}

function logYuantaForeignCurrencyResultObservation(
  observations: readonly YuantaForeignResultObservation[],
): void {
  const serializedObservation = JSON.stringify({
    ruleVersion: YUANTA_FOREIGN_RESULT_RULE_VERSION,
    framesExamined: observations.length,
    observations,
  });
  console.log(
    "yuanta-foreign-currency-result-observation",
    serializedObservation,
  );
}

async function readYuantaForeignCurrencyFrameMarkup(
  scope: BrowserScope,
): Promise<string> {
  const body = scope.locator("body").first();
  if ((await body.count().catch(() => 0)) > 0) {
    return body.evaluate((element) => element.outerHTML).catch(() => "");
  }
  const html = scope.locator("html").first();
  if ((await html.count().catch(() => 0)) > 0) {
    return html.evaluate((element) => element.outerHTML).catch(() => "");
  }
  return "";
}

async function readYuantaForeignCurrencyCsvLinkIdentity(
  link: Locator,
): Promise<YuantaForeignCurrencyCsvLinkIdentity | null> {
  return link
    .evaluate((element) => ({
      text: element.textContent ?? "",
      className: element.getAttribute("class") ?? "",
      href: element.getAttribute("href") ?? "",
      ariaLabel: element.getAttribute("aria-label") ?? "",
      title: element.getAttribute("title") ?? "",
      onclick: element.getAttribute("onclick") ?? "",
      dataAction: element.getAttribute("data-action") ?? "",
      dataCommand: element.getAttribute("data-command") ?? "",
      download: element.getAttribute("download") ?? "",
    }))
    .catch(() => null);
}

async function stableYuantaForeignCurrencyCsvLink(
  scope: BrowserScope,
  link: Locator,
): Promise<Locator | null> {
  const identity = await readYuantaForeignCurrencyCsvLinkIdentity(link);
  if (!identity) return null;
  const selector = stableYuantaForeignCurrencyCsvLinkSelector(identity);
  if (!selector) return null;
  const stable = scope.locator(selector);
  if ((await stable.count().catch(() => 0)) !== 1) return null;
  if (!(await stable.isVisible().catch(() => false))) return null;
  const stableIdentity = await readYuantaForeignCurrencyCsvLinkIdentity(stable);
  if (
    !stableIdentity ||
    !isSameYuantaForeignCurrencyCsvLinkIdentity(identity, stableIdentity)
  ) {
    return null;
  }
  return stable;
}

async function findYuantaForeignCurrencyCsvLinkForFrame(
  scope: BrowserScope,
  markup: string,
): Promise<YuantaForeignCurrencyCsvFrameTarget | null> {
  const match = findYuantaForeignCurrencyTableMatches(markup);
  if (!match.hasTimestampResult || match.matches.length !== 1) return null;

  const target = match.matches[0]!;
  const tables = scope.locator("table");
  const links = scope.locator("a");
  if (
    (await tables.count().catch(() => 0)) <= target.tableIndex ||
    (await links.count().catch(() => 0)) <= target.linkIndex
  ) {
    return null;
  }
  const table = tables.nth(target.tableIndex);
  if (!(await table.isVisible().catch(() => false))) return null;
  const link = links.nth(target.linkIndex);
  if (!(await link.isVisible().catch(() => false))) return null;
  const stable = await stableYuantaForeignCurrencyCsvLink(scope, link);
  if (!stable) return null;
  return {
    control: stable,
    associationKey: target.associationKey,
  };
}

type YuantaForeignCurrencyCsvFrameTarget = {
  control: Locator;
  associationKey: string;
};

type YuantaForeignCurrencyCsvControlTarget = {
  scope: BrowserScope;
  control: Locator;
  refresh: () => Promise<Locator | null>;
};

async function refreshYuantaForeignCurrencyCsvControl(
  scope: BrowserScope,
  control: Locator,
  associationKey: string,
): Promise<Locator | null> {
  if (frameRouteObservation(scope).framePath !== "fxtransactiondetails") {
    return null;
  }
  const results = await findYuantaForeignCurrencyResults(scope);
  if (!(await hasVisibleYuantaForeignCurrencyTimestampResult(results))) {
    return null;
  }
  const markup = await readYuantaForeignCurrencyFrameMarkup(scope);
  if (!markup) return null;
  const refreshed = await findYuantaForeignCurrencyCsvLinkForFrame(
    scope,
    markup,
  );
  if (!refreshed || refreshed.associationKey !== associationKey) return null;
  const currentIdentity = await readYuantaForeignCurrencyCsvLinkIdentity(
    refreshed.control,
  );
  const previousIdentity = await readYuantaForeignCurrencyCsvLinkIdentity(
    control,
  );
  if (
    !currentIdentity ||
    !previousIdentity ||
    !isSameYuantaForeignCurrencyCsvLinkIdentity(
      currentIdentity,
      previousIdentity,
    )
  ) {
    return null;
  }
  return refreshed.control;
}

/**
 * Wait for a provider result state before looking for a download control.
 * Frames are enumerated on every poll because Yuanta can replace or nest the
 * result frame after submitting the query.
 */
export async function findYuantaForeignCurrencyCsvDownloadControl(
  page: Page,
  timeoutMs = 60_000,
): Promise<YuantaForeignCurrencyCsvControlTarget> {
  const deadline = Date.now() + timeoutMs;
  let lastObservations: YuantaForeignResultObservation[] = [];

  while (Date.now() < deadline) {
    const observations: YuantaForeignResultObservation[] = [];
    let providerError = false;
    let providerNoData = false;
    let readyResultFound = false;

    for (const scope of [page, ...page.frames()]) {
      const frameRoute = frameRouteObservation(scope);
      const results = await findYuantaForeignCurrencyResults(scope);
      if (results.length === 0) {
        observations.push({
          ...frameRoute,
          resultPresent: false,
          state: "pending",
          csvControlCount: 0,
          controlKinds: [],
          noticeKinds: [],
          resultContainers: [],
          resultContainerOverflowCount: 0,
          resultContainerOverflowBucket: "0",
        });
        continue;
      }

      const resultClassifications: Array<{
        result: Locator;
        classification: YuantaForeignCurrencyResultClassification;
        diagnostics: YuantaForeignCurrencyResultDiagnostics;
      }> = [];
      for (const result of results) {
        const markup = await result
          .evaluate((element) => element.outerHTML)
          .catch(() => "");
        const visible = await result.isVisible().catch(() => null);
        const visibility =
          visible === null ? "unknown" : visible ? "visible" : "hidden";
        resultClassifications.push({
          result,
          classification: classifyYuantaForeignCurrencyResultMarkup(markup),
          diagnostics: diagnoseYuantaForeignCurrencyResultMarkup(
            markup,
            visibility,
          ),
        });
      }
      const classification = combineYuantaForeignCurrencyResultClassifications(
        resultClassifications.map(({ classification: resultState }) => resultState),
      );
      observations.push({
        ...frameRoute,
        resultPresent: classification.hasResult,
        state: classification.state,
        csvControlCount: classification.csvControlCount,
        controlKinds: classification.controlKinds,
        noticeKinds: classification.noticeKinds,
        ...capYuantaForeignCurrencyResultDiagnostics(
          resultClassifications.flatMap(
            ({ diagnostics }) => diagnostics.resultContainers,
          ),
          resultClassifications.reduce(
            (overflowCount, { diagnostics }) =>
              overflowCount + diagnostics.resultContainerOverflowCount,
            0,
          ),
        ),
      });

      if (classification.state === "download-ready") {
        readyResultFound = true;
      }
      if (frameRoute.framePath === "fxtransactiondetails") {
        const frameMarkup = await readYuantaForeignCurrencyFrameMarkup(scope);
        if (
          frameMarkup &&
          (await hasVisibleYuantaForeignCurrencyTimestampResult(results))
        ) {
          const control = await findYuantaForeignCurrencyCsvLinkForFrame(
            scope,
            frameMarkup,
          );
          if (control) {
            return {
              scope,
              control: control.control,
              refresh: () =>
                refreshYuantaForeignCurrencyCsvControl(
                  scope,
                  control.control,
                  control.associationKey,
                ),
            };
          }
        }
        if (classification.state !== "download-ready") {
          providerError ||= classification.state === "provider-error";
          providerNoData ||= classification.state === "provider-no-data";
        }
      }
    }

    lastObservations = observations;
    if (!readyResultFound && providerError) {
      logYuantaForeignCurrencyResultObservation(observations);
      throw new Error(
        "YuanTa foreign-currency provider returned an explicit result error.",
      );
    }
    if (!readyResultFound && providerNoData) {
      logYuantaForeignCurrencyResultObservation(observations);
      throw new StatementComponentAbsentError(
        "YuanTa foreign-currency provider returned no transaction data.",
      );
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0)
      await page.waitForTimeout(Math.min(250, remainingMs));
  }

  logYuantaForeignCurrencyResultObservation(lastObservations);
  throw new Error(
    "Could not find YuanTa foreign-currency CSV download link in any frame.",
  );
}

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  );
}

function digitsOnly(value: string): string {
  return toAsciiDigits(value).replace(/\D/g, "");
}

function maskAccountLabel(value: string): string {
  return cleanText(value).replace(/[0-9０-９]{4,}/g, (digits) => {
    const normalized = toAsciiDigits(digits);
    return `${"*".repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-4)}`;
  });
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function createTimestampGenerator(): () => string {
  let lastTimestamp = 0;

  return () => {
    const timestamp = Date.now();
    lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
    return String(lastTimestamp);
  };
}

function stripSpreadsheetTextPrefix(value: string): string {
  const text = cleanText(value);
  return text.replace(/^'+/, "").replace(/'+$/, "");
}

function isRepeatedHeaderRow(values: string[]): boolean {
  return (
    values.length === downloadedForeignCurrencyHeaders.length &&
    values.every(
      (value, index) => value === downloadedForeignCurrencyHeaders[index],
    )
  );
}

function parseTransactionSortTime(values: string[]): number | null {
  const dateText = toAsciiDigits(stripSpreadsheetTextPrefix(values[2] ?? ""));
  const timeText = toAsciiDigits(stripSpreadsheetTextPrefix(values[3] ?? ""));
  const dateMatch = dateText.match(/^(\d{4})(\d{2})(\d{2})$/);
  const timeMatch = timeText.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = timeMatch ? Number(timeMatch[1]) : 0;
  const minute = timeMatch ? Number(timeMatch[2]) : 0;
  const second = timeMatch ? Number(timeMatch[3] ?? "0") : 0;
  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(time) ? time : null;
}

function transactionRowsFromDownloadedCsv(
  content: string,
  accountLabel: string,
  accountValue: string,
  queryCurrencyLabel: string,
  queryCurrencyValue: string,
): ForeignCurrencyTransactionRow[] {
  const rows = parseCsvMatrix(content).map((row) =>
    row.map(stripSpreadsheetTextPrefix),
  );
  const headerIndex = rows.findIndex(isRepeatedHeaderRow);
  if (headerIndex < 0) {
    throw new Error(
      "Downloaded YuanTa foreign-currency CSV did not contain expected headers.",
    );
  }

  const transactions: ForeignCurrencyTransactionRow[] = [];
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const values = rows[rowIndex];
    if (!values.some((value) => value.length > 0)) continue;
    if (isRepeatedHeaderRow(values)) continue;
    if (values.length !== downloadedForeignCurrencyHeaders.length) {
      throw new Error(
        `Downloaded YuanTa foreign-currency CSV row had ${values.length} columns; expected ${downloadedForeignCurrencyHeaders.length}.`,
      );
    }

    transactions.push({
      accountLabel,
      accountValue,
      queryCurrencyLabel,
      queryCurrencyValue,
      values,
      sortTime: parseTransactionSortTime(values),
    });
  }

  return transactions;
}

function sortedTransactionRows(
  rows: ForeignCurrencyTransactionRow[],
): ForeignCurrencyTransactionRow[] {
  return [...rows].sort((left, right) => {
    if (left.sortTime === null && right.sortTime === null) return 0;
    if (left.sortTime === null) return 1;
    if (right.sortTime === null) return -1;
    return right.sortTime - left.sortTime;
  });
}

function foreignCurrencyTransactionsToCsv(
  rows: ForeignCurrencyTransactionRow[],
): string {
  return rowsToCsv([
    foreignCurrencyTransactionHeaders,
    ...sortedTransactionRows(rows).map((row) => [
      row.accountLabel,
      row.queryCurrencyLabel,
      ...row.values,
    ]),
  ]);
}

async function readBig5DownloadAsUtf8(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return big5Decoder.decode(Buffer.concat(chunks));
}

async function writeForeignCurrencyTransactionsFile(
  nextTimestamp: () => string,
  dateRange: string,
  channelType: z.infer<typeof channelTypeSchema>,
  rows: ForeignCurrencyTransactionRow[],
  sourceDownloads: SourceDownloadMetadata[],
): Promise<TableFile> {
  const downloadsDir = join(
    process.cwd(),
    "downloads",
    "yuanta-foreign-currency-statements",
  );
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `foreign-currency-transactions-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);
  const accounts = [...new Set(rows.map((row) => row.accountLabel))];
  const currencies = [
    ...new Set(
      rows.map((row) => stripSpreadsheetTextPrefix(row.values[4] ?? "")),
    ),
  ].filter((currency) => currency.length > 0);

  await writeFile(csvPath, foreignCurrencyTransactionsToCsv(rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        schemaVersion: "download-table-metadata.v1",
        generatedAt: new Date().toISOString(),
        workflow: "yuantaForeignCurrencyStatements",
        kind: "foreign-currency-transactions",
        csvFilename,
        jsonFilename,
        rowCount: rows.length,
        headers: foreignCurrencyTransactionHeaders,
        accounts,
        currencies,
        dateRange,
        channelType,
        sourceDownloads,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);
  return {
    baseName,
    kind: "foreign-currency-transactions",
    rowCount: rows.length,
    headers: foreignCurrencyTransactionHeaders,
    accounts,
    currencies,
    dateRange,
    channelType,
    csvFilename,
    jsonFilename,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
}

function matchesFilter(
  option: { label: string; value: string },
  filters: string[],
): boolean {
  if (filters.length === 0) return true;

  const normalizedLabel = toAsciiDigits(option.label).toLowerCase();
  const normalizedValue = toAsciiDigits(option.value).toLowerCase();
  const optionDigits = digitsOnly(`${option.label} ${option.value}`);

  return filters.some((filter) => {
    const normalizedFilter = toAsciiDigits(filter).toLowerCase().trim();
    const filterDigits = digitsOnly(filter);
    return (
      normalizedLabel.includes(normalizedFilter) ||
      normalizedValue.includes(normalizedFilter) ||
      (filterDigits.length > 0 && optionDigits.endsWith(filterDigits))
    );
  });
}

function isUnavailableOption(value: string, label: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  const normalizedLabel = cleanText(label).toLowerCase();
  if (
    !normalizedValue ||
    ["0", "-1", "none", "null", "undefined"].includes(normalizedValue)
  ) {
    return true;
  }
  return (
    /^(?:請|请)?選擇(?:帳戶|账戶|幣別|币别)?$/.test(normalizedLabel) ||
    /^(?:無|无)(?:可用)?(?:帳戶|账戶|幣別|币别)$/.test(normalizedLabel)
  );
}

function describeDateRange(input: WorkflowInput): string {
  if (input.customDateRange) {
    return `${input.customDateRange.startDate}-${input.customDateRange.endDate}`;
  }
  return dateRangeLabels[input.dateRange];
}

async function findScopeWithSelector(
  page: Page,
  selector: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      if (await hasAttachedLocator(scope.locator(selector))) return scope;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find selector "${selector}" in any frame.`);
}

async function findScopeWithLocator(
  page: Page,
  locatorFor: (scope: BrowserScope) => Locator,
  description: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      if (await hasAttachedLocator(locatorFor(scope))) return scope;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find ${description} in any frame.`);
}

async function firstVisibleLocator(
  locator: Locator,
  description: string,
  timeoutMs = 60_000,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await locator.page().waitForTimeout(500);
  }

  throw new Error(`Could not find a visible ${description}.`);
}

async function settleAfterNavigation(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    // YuanTa keeps timers alive; selector waits below confirm readiness.
  });
  await page.waitForTimeout(750);
}

async function openForeignCurrencyDetailsPage(
  page: Page,
): Promise<BrowserScope> {
  const existing = await findForeignCurrencyDetailsForm(page, 5_000).catch(
    () => null,
  );
  if (existing) return existing;

  if (await clickForeignCurrencyDetailsLink(page, 5_000)) {
    return await findForeignCurrencyDetailsForm(page);
  }

  const summaryScope = await findScopeWithSelector(page, "#submenuAreaFX");
  await summaryScope.locator("#submenuAreaFX").click({ force: true });

  if (await clickForeignCurrencyDetailsLink(page, 3_000)) {
    return await findForeignCurrencyDetailsForm(page);
  }

  const demandDepositLink = await firstVisibleLocator(
    summaryScope.locator("#submenu_innerFX a").filter({ hasText: "活期明細" }),
    "YuanTa foreign-currency demand-deposit details link",
  );
  await demandDepositLink.click({ force: true });
  await settleAfterNavigation(page);

  const formAfterOverview = await findForeignCurrencyDetailsForm(page, 3_000)
    .then((scope) => scope)
    .catch(() => null);
  if (formAfterOverview) return formAfterOverview;

  if (await clickForeignCurrencyDetailsLink(page)) {
    return await findForeignCurrencyDetailsForm(page);
  }

  throw new Error("Could not open YuanTa foreign-currency details page.");
}

async function findForeignCurrencyDetailsForm(
  page: Page,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const hasAccount = await hasAttachedLocator(scope.locator("#acctno"));
      const hasCurrency = await hasAttachedLocator(
        scope.locator('select[name="currency"]'),
      );
      if (hasAccount && hasCurrency) return scope;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Could not find YuanTa foreign-currency details form.");
}

async function clickForeignCurrencyDetailsLink(
  page: Page,
  timeoutMs = 60_000,
): Promise<boolean> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate.locator('a[onclick*="fxtransactiondetails"]').filter({
        hasText: /^(外幣)?交易明細查詢$/,
      }),
    "YuanTa foreign-currency details link",
    timeoutMs,
  ).catch(() => null);
  if (!scope) return false;

  const link = await firstVisibleLocator(
    scope.locator('a[onclick*="fxtransactiondetails"]').filter({
      hasText: /^(外幣)?交易明細查詢$/,
    }),
    "YuanTa foreign-currency details link",
    timeoutMs,
  ).catch(() => null);
  if (!link) return false;

  await link.click({ force: true });
  await settleAfterNavigation(page);
  return true;
}

async function chooseDateRange(
  page: Page,
  input: WorkflowInput,
): Promise<void> {
  const scope = await findScopeWithSelector(page, "#acctno");

  if (input.customDateRange) {
    const customLink = await firstVisibleLocator(
      scope.locator("#duration a").filter({ hasText: "自選" }),
      'YuanTa date range link "自選"',
    );
    await customLink.click({ force: true });
    await scope.locator("#sdate").fill(input.customDateRange.startDate);
    await scope.locator("#edate").fill(input.customDateRange.endDate);
    return;
  }

  const label = dateRangeLabels[input.dateRange];
  const link = await firstVisibleLocator(
    scope.locator("#duration a").filter({ hasText: label }),
    `YuanTa date range link "${label}"`,
  );
  await link.click({ force: true });
}

async function waitForCurrencyOptions(
  page: Page,
  scope: BrowserScope,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      await hasAttachedLocator(scope.locator('select[name="currency"] option'))
    ) {
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("Timed out waiting for YuanTa currency options.");
}

async function selectAccount(
  page: Page,
  account: AccountOption,
): Promise<void> {
  const scope = await findScopeWithSelector(page, "#acctno");
  await scope.locator("#acctno").selectOption(account.value);
  await waitForCurrencyOptions(page, scope);
}

export async function readYuantaForeignCurrencyAccountOptions(
  page: Page,
  _filters: string[] = [],
): Promise<AccountOption[]> {
  const scope = await findScopeWithSelector(page, "#acctno");
  const options = scope.locator("#acctno option");
  const count = await options.count();
  const availableAccounts: AccountOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await option.getAttribute("value")) ?? "";
    const label = cleanText(await option.textContent());
    if (isUnavailableOption(value, label)) continue;

    const account = { label, value };
    availableAccounts.push(account);
  }

  if (availableAccounts.length === 0) {
    throw new StatementComponentAbsentError(
      "No YuanTa foreign-currency account is available for this login.",
    );
  }
  // Account filters are legacy persisted UI state. Yuanta foreign-currency
  // capture always includes every visible account; provider absence is the
  // only skip.
  return availableAccounts;
}

export async function readYuantaForeignCurrencyOptions(
  page: Page,
  filters: string[] = [],
): Promise<CurrencyOption[]> {
  const scope = await findScopeWithSelector(page, "#acctno");
  await waitForCurrencyOptions(page, scope);

  const options = scope.locator('select[name="currency"] option');
  const count = await options.count();
  const currencies: CurrencyOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await option.getAttribute("value")) ?? "";
    const label = cleanText(await option.textContent());
    if (isUnavailableOption(value, label)) continue;
    currencies.push({ label, value });
  }

  if (currencies.length === 0) {
    throw new StatementComponentAbsentError(
      "No YuanTa foreign-currency position is available for this account.",
    );
  }

  if (filters.length === 0) {
    const allCurrency = currencies.find((currency) => currency.value === "ALL");
    return allCurrency ? [allCurrency] : currencies;
  }

  const filtered = currencies.filter((currency) =>
    matchesFilter(currency, filters),
  );
  if (filtered.length === 0) {
    throw new Error("No foreign-currency options matched the input.");
  }

  return filtered;
}

async function waitForCsvDownloadLink(page: Page): Promise<void> {
  await findYuantaForeignCurrencyCsvDownloadControl(page);
}

const YUANTA_FOREIGN_CSV_CLICK_MAX_ATTEMPTS = 3;

/**
 * Re-validate the complete result/table/link fence for each native click.
 * Yuanta re-renders this page while scrolling, so an actionability wait on a
 * previously resolved locator can outlive the element it was meant to click.
 * A failed native click is the only retryable action; once click() returns,
 * waiting for its download avoids issuing a second provider request.
 */
export async function clickYuantaForeignCurrencyCsvDownloadControl(
  page: Page,
  timeoutMs = 60_000,
): Promise<Download> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  for (
    let attempt = 0;
    attempt < YUANTA_FOREIGN_CSV_CLICK_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    let target: YuantaForeignCurrencyCsvControlTarget;
    try {
      target = await findYuantaForeignCurrencyCsvDownloadControl(
        page,
        remainingMs,
      );
    } catch (error) {
      lastError = error;
      continue;
    }

    const control = await target.refresh().catch((error: unknown) => {
      lastError = error;
      return null;
    });
    if (!control) {
      lastError ??= new Error(
        "YuanTa foreign-currency CSV download control changed before click.",
      );
      continue;
    }

    const actionTimeoutMs = Math.max(1, Math.min(60_000, deadline - Date.now()));
    const downloadPromise = page.waitForEvent("download", {
      timeout: actionTimeoutMs,
    });
    try {
      await control.evaluate((element) => {
        const clickable = element as HTMLElement;
        if (typeof clickable.click !== "function") {
          throw new Error("YuanTa CSV control is not a clickable HTMLElement.");
        }
        clickable.click();
      });
    } catch (error) {
      lastError = error;
      // The failed attempt did not issue a click. Consume a later timeout
      // rejection so the abandoned wait cannot become an unhandled promise.
      void downloadPromise.catch(() => undefined);
      continue;
    }

    // Do not retry after click() returns: a delayed download must not cause a
    // duplicate provider request.
    return await downloadPromise;
  }

  throw new Error(
    `Could not safely click YuanTa foreign-currency CSV download control after ${YUANTA_FOREIGN_CSV_CLICK_MAX_ATTEMPTS} attempts.`,
    { cause: lastError },
  );
}

async function queryAccountCurrency(
  page: Page,
  input: WorkflowInput,
  account: AccountOption,
  currency: CurrencyOption,
): Promise<void> {
  await selectAccount(page, account);

  const scope = await findScopeWithSelector(page, "#acctno");
  await scope.locator('select[name="currency"]').selectOption(currency.value);
  await chooseDateRange(page, input);
  await scope
    .locator("#channelType")
    .selectOption(channelTypeValues[input.channelType]);
  await scope.locator("#submitbutton").click();
  await settleAfterNavigation(page);
  await waitForCsvDownloadLink(page);
}

async function downloadTransactionRows(
  page: Page,
  accountLabel: string,
  accountValue: string,
  currencyLabel: string,
  currencyValue: string,
): Promise<{ filename: string; rows: ForeignCurrencyTransactionRow[] }> {
  const download = await clickYuantaForeignCurrencyCsvDownloadControl(page);

  const filename = download.suggestedFilename();
  const content = await readBig5DownloadAsUtf8(download);
  return {
    filename,
    rows: transactionRowsFromDownloadedCsv(
      content,
      accountLabel,
      accountValue,
      currencyLabel,
      currencyValue,
    ),
  };
}

function sourceDateRange(input: WorkflowInput): {
  startDate: string;
  endDate: string;
} {
  if (input.customDateRange)
    return {
      startDate: input.customDateRange.startDate.replaceAll("/", "-"),
      endDate: input.customDateRange.endDate.replaceAll("/", "-"),
    };
  const end = new Date();
  const days = input.dateRange === "one_week" ? 7 : input.dateRange === "one_month" ? 31 : 93;
  const start = new Date(end.getTime() - days * 86_400_000);
  const iso = (value: Date) => value.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end) };
}

function normalizeExactDecimal(value: string, label: string): string {
  const normalized = stripSpreadsheetTextPrefix(value).replace(/[ ,]/g, "");
  if (!normalized || normalized === "-")
    throw new Error(`Yuanta foreign row is missing ${label}.`);
  if (!/^\d+(?:\.\d+)?$/.test(normalized))
    throw new Error(`Yuanta foreign ${label} is not an exact decimal.`);

  const [whole, fraction = ""] = normalized.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = fraction.replace(/0+$/u, "");
  return normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;
}

function exactCell(value: string, label: string): string {
  return normalizeExactDecimal(value, label);
}

/**
 * Yuanta's export fills the unused amount side with a zero-padded decimal
 * (for example, `000000000000.00`). It proves no direction and must not be
 * selected as the transaction amount. Blank cells are treated the same way;
 * malformed non-blank cells remain fail-closed.
 */
function optionalAmountCell(value: string, label: string): string | null {
  const normalized = stripSpreadsheetTextPrefix(value).replace(/[ ,]/g, "");
  if (!normalized || normalized === "-") return null;
  const amount = normalizeExactDecimal(normalized, label);
  return /^0+(?:\.0+)?$/.test(amount) ? null : amount;
}

function currencyCode(label: string, value: string): string {
  const rowCandidate = label.toUpperCase().match(/\b[A-Z]{3}\b/)?.[0];
  if (rowCandidate && rowCandidate !== "ALL") return rowCandidate;
  const typedCandidate = value.toUpperCase().match(/\b[A-Z]{3}\b/)?.[0];
  if (typedCandidate && typedCandidate !== "ALL") return typedCandidate;
  throw new Error("Yuanta foreign row lacks a source currency.");
}

/** Public workflow-to-canonical seam used by browser runs and deterministic checks. */
export function buildYuantaForeignCurrencyCaptureInput(
  rows: readonly ForeignCurrencyTransactionRow[],
  input: WorkflowInput,
  accountNo: string,
  observedAt = new Date().toISOString(),
  captureOccurrenceId = "",
  zeroResultAuthority?: "provider-explicit-no-data",
  settlementLoginIdentity = "",
): ForeignCurrencyDepositCaptureInput {
  if (
    rows.length === 0 &&
    zeroResultAuthority !== "provider-explicit-no-data"
  )
    throw new Error(
      "Yuanta foreign empty capture requires provider-explicit-no-data terminal evidence.",
    );
  const range = sourceDateRange(input);
  return {
    source: "yuanta",
    accountNo,
    sourceConnectionKey: "yuanta-foreign-current-login",
    identityEpochKey: "yuanta-foreign-current-identity",
    accountType: "depository",
    captureCurrencyScope: { kind: "multi-currency" },
    captureOccurrenceId,
    zeroResultAuthority,
    observedAt,
    ...range,
    completeness: "complete-range",
    records: rows.map((row) => {
      const values = row.values;
      const debit = optionalAmountCell(values[6] ?? "", "debit amount");
      const credit = optionalAmountCell(values[7] ?? "", "credit amount");
      if ((debit === null) === (credit === null))
        throw new Error("Yuanta foreign row must prove exactly one amount direction.");
      const amount = debit ?? credit;
      if (amount === null)
        throw new Error("Yuanta foreign row must prove exactly one amount direction.");
      const localDate = toAsciiDigits(values[2] ?? "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
      const localTime = toAsciiDigits(values[3] ?? "");
      const rowCurrency = currencyCode(values[4] ?? "", row.queryCurrencyValue);
      const balanceAfter = exactCell(values[8] ?? "", "balance");
      const direction = debit !== null ? ("outflow" as const) : ("inflow" as const);
      const signedAmount = `${direction === "outflow" ? "-" : "+"}${amount}`;
      const sourceKey = [
        accountNo,
        rowCurrency,
        `${localDate}T${localTime || "date"}`,
        signedAmount,
        balanceAfter,
      ].join(":");
      const reportedRateText = stripSpreadsheetTextPrefix(values[10] ?? "");
      const normalizedReportedRate = reportedRateText
        ? normalizeExactDecimal(reportedRateText, "reported rate")
        : "";
      return {
        sourceKey,
        sequence: `${localDate}T${localTime || "date"}`,
        amount,
        direction,
        currencyEvidence: {
          kind: "row" as const,
          currency: rowCurrency,
        },
        balanceAfter,
        sourceTime: {
          localDate,
          localTime: localTime || undefined,
          precision: localTime ? undefined : ("date" as const),
        },
        // Yuanta's foreign statement amount is already denominated in the
        // source row currency; preserving it as original evidence avoids
        // inventing a TWD conversion or fee from an unlabeled rate column.
        originalAmount: {
          amount: exactCell(amount, "original amount"),
          currency: rowCurrency,
        },
        sourceReportedRate: reportedRateText
          ? {
              rate: normalizedReportedRate,
              baseCurrency: rowCurrency,
              quoteCurrency: "TWD",
              observedOn: localDate,
            }
          : null,
        description: values[5] || null,
        sourcePayload: {
          identityAuthority: "human-attested",
          identityContract: "foreign-currency/yuanta/human-attested-v2",
          accountingDate: toAsciiDigits(values[1] ?? "").replace(
            /^(\d{4})(\d{2})(\d{2})$/,
            "$1-$2-$3",
          ),
          transactionInfo: values[9] ?? "",
          settlementLinkageKey: settlementLoginIdentity.trim()
            ? deriveYuantaForeignSettlementLinkageKey(
                settlementLoginIdentity,
                rowCurrency,
              )
            : "",
          settlementLinkageContractVersion:
            YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
          reportedRate: normalizedReportedRate,
        },
      };
    }),
  };
}

export async function commitYuantaForeignCurrencyCapture(
  store: ForeignCurrencyDepositCommitStore,
  input: ForeignCurrencyDepositCaptureInput,
) {
  const results = await commitForeignCurrencyDepositCaptureBatch(store, [input]);
  await resolveCanonicalInvestmentFundingRelations(store);
  return results;
}

export default workflow("yuantaForeignCurrencyStatements", {
  credentials: ["yuanta_user_id", "yuanta_account", "yuanta_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page } = ctx;
    const credentials = (
      input as typeof input & { credentials: YuantaCredentials }
    ).credentials;
    const authResult = await sharedAuthenticateYuantaBank(
      ctx,
      credentials,
      input.replaceActiveSession,
    );
    const replacedActiveSession = authResult.replacedActiveSession;

    await openForeignCurrencyDetailsPage(page);

    const accounts = await readYuantaForeignCurrencyAccountOptions(
      page,
      input.accountFilters,
    );
    const rows: ForeignCurrencyTransactionRow[] = [];
    const sourceDownloads: SourceDownloadMetadata[] = [];
    const nextTimestamp = createTimestampGenerator();

    for (const account of accounts) {
      await selectAccount(page, account);
      const currencies = await readYuantaForeignCurrencyOptions(
        page,
        input.currencyFilters,
      );

      for (const currency of currencies) {
        const maskedAccount = maskAccountLabel(account.label);
        await queryAccountCurrency(page, input, account, currency);
        const download = await downloadTransactionRows(
          page,
          maskedAccount,
          account.value,
          currency.label,
          currency.value,
        );
        rows.push(...download.rows);
        sourceDownloads.push({
          accountValue: account.value,
          account: maskedAccount,
          currency: currency.label,
          filename: download.filename,
          rowCount: download.rows.length,
        });
      }
    }

    const dateRange = describeDateRange(input);
    const file = await writeForeignCurrencyTransactionsFile(
      nextTimestamp,
      dateRange,
      input.channelType,
      rows,
      sourceDownloads,
    );

    const financialLedgerDir =
      process.env.OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR;
    if (financialLedgerDir) {
      const captureOccurrenceId = randomUUID();
      const financialStore = createCanonicalSourceStore(
        canonicalSqlitePath(financialLedgerDir),
      );
      try {
        const grouped = new Map<string, ForeignCurrencyTransactionRow[]>();
        for (const row of rows) {
          const accountRows = grouped.get(row.accountValue) ?? [];
          accountRows.push(row);
          grouped.set(row.accountValue, accountRows);
        }
        const captures = accounts.map((account) => {
          const accountRows = grouped.get(account.value) ?? [];
          const accountDownloads = sourceDownloads.filter(
            (download) => download.accountValue === account.value,
          );
          const zeroResultAuthority =
            accountRows.length === 0 &&
            accountDownloads.length > 0 &&
            accountDownloads.every((download) => download.rowCount === 0)
              ? ("provider-explicit-no-data" as const)
              : undefined;
          return buildYuantaForeignCurrencyCaptureInput(
            accountRows,
            input,
            account.value,
            new Date().toISOString(),
            captureOccurrenceId,
            zeroResultAuthority,
            credentials.yuanta_user_id ?? "",
          );
        });
        await commitForeignCurrencyDepositCaptureBatch(financialStore, captures);
        await resolveCanonicalInvestmentFundingRelations(financialStore);
      } finally {
        financialStore.close();
      }
    }

    return {
      dateRange,
      channelType: input.channelType,
      usedExistingSession: authResult.usedProfile,
      replacedActiveSession,
      count: 1,
      files: [file],
    };
  },
});
