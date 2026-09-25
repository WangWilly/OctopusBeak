import type { Locator, Page, Response } from "playwright";
import { z } from "zod";
import {
  PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
  PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import {
  admitCanonicalInvestmentCapture,
  YUANTA_FOREIGN_SETTLEMENT_CONTRACT_VERSION,
  type InvestmentFundingEvidence,
  type InvestmentTransactionAction,
  type InvestmentValidatedCapture,
} from "../ledger/canonical/investment-financial-admission.ts";
import {
  buildYuantaInvestmentCapture,
  YUANTA_TRADE_ACCOUNT_NUMBER_EVIDENCE_VERSION,
  YUANTA_TRADE_BROKERAGE_ACCOUNT_NUMBER_EVIDENCE_VERSION,
  type YuantaCanonicalInvestmentRow,
  type YuantaTradeAccountNumberEvidence,
} from "../ledger/canonical/yuanta-investment-adapters.ts";
import {
  deriveYuantaForeignSettlementLinkageKey,
  isYuantaForeignSettlementMarketCode,
  YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
  type YuantaForeignSettlementMarketCode,
} from "../ledger/canonical/investment-funding-contract.ts";
import { deriveSourceConnectionIdentityKey } from "../ledger/canonical/source-connection-identity.ts";
import {
  YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR as YUANTA_TRADE_CAPTCHA_MODAL_SELECTOR,
  YUANTA_TRADE_CAPTCHA_IMAGE_SELECTOR,
  YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR,
} from "../lib/automation/yuanta-trade-captcha.ts";
import { emitHumanAssistanceStage, type WorkflowHumanAssistanceStage } from "./human-assistance.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import type { HumanAssistanceContractInput } from "../lib/automation/human-assistance.ts";

export {
  YUANTA_TRADE_CAPTCHA_IMAGE_SELECTOR,
  YUANTA_TRADE_CAPTCHA_MODAL_SELECTOR,
  YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR,
};

export const YUANTA_TRADE_LOGIN_URL =
  "https://global.yuanta.com.tw/NexusWebTrade/Login/OTPLogin?urlid=6020";

export function yuantaTradeCaptchaCheckbox(page: Page) {
  return page.locator(".check-area");
}

export function yuantaTradeCaptchaModal(page: Page) {
  return page.locator(YUANTA_TRADE_CAPTCHA_MODAL_SELECTOR).first();
}

export function yuantaTradeCaptchaImages(modal: Locator) {
  return modal.locator(YUANTA_TRADE_CAPTCHA_IMAGE_SELECTOR);
}

export function yuantaTradeCaptchaSubmit(modal: Locator) {
  return modal.locator(YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR).first();
}

export function deriveYuantaTradeAccountNumberEvidence(
  accountNumber: string,
): YuantaTradeAccountNumberEvidence | null {
  const value = accountNumber.trim().normalize("NFKC");
  const isNumericAccount = /^\d{6,24}$/u.test(value);
  const isBrokerageAccount = /^\d{3}C-\d{7}$/u.test(value);
  if (!isNumericAccount && !isBrokerageAccount) return null;
  return {
    value,
    kind: "brokerage-account",
    evidenceVersion: isBrokerageAccount
      ? YUANTA_TRADE_BROKERAGE_ACCOUNT_NUMBER_EVIDENCE_VERSION
      : YUANTA_TRADE_ACCOUNT_NUMBER_EVIDENCE_VERSION,
    sourceField: isBrokerageAccount ? "BrkAccount_C50" : "CSV account_number",
  };
}

export function yuantaTradeAudioAssistanceStage(
  authPage: Page,
): WorkflowHumanAssistanceStage {
  return {
    stageId: "yuanta-trade-audio-verification",
    title: "Enter the YuanTa Trade audio verification code",
    challengeKind: "audio-captcha" as const,
    challengeAudioSource: {
      id: "audio-challenge",
      label: "Verification audio challenge",
      semanticId: "yuanta-trade.login.audio-challenge",
    },
    charset: "digits" as const,
    expectedAnswerLength: 6,
    targets: [
      {
        id: "audio-code-input",
        label: "Verification code",
        semanticId: "yuanta-trade.login.audio-code-input",
        modes: ["type"] as const,
        locator: authPage.locator("#verificationCode"),
      },
    ],
    contextRegions: [
      {
        id: "audio-verification",
        label: "Audio verification controls",
        semanticId: "yuanta-trade.login.audio-verification",
      },
    ],
    completion: { mode: "inline", targetIds: ["audio-code-input"] },
    focus: {
      targetId: "audio-code-input",
      contextRegionIds: ["audio-verification"],
      initialZoom: 1.15,
    },
  };
}

export function yuantaTradeCaptchaCheckboxAssistanceStage(
  authPage: Page,
): WorkflowHumanAssistanceStage {
  return {
    stageId: "yuanta-trade-captcha-checkbox",
    title: "Complete the YuanTa Trade CAPTCHA checkbox",
    challengeKind: "checkbox",
    targets: [{
      id: "captcha-checkbox",
      label: "CAPTCHA checkbox",
      semanticId: "yuanta-trade.login.captcha-checkbox",
      modes: ["click"],
      locator: yuantaTradeCaptchaCheckbox(authPage),
    }],
    contextRegions: [{
      id: "captcha-control",
      label: "CAPTCHA control",
      semanticId: "yuanta-trade.login.captcha-control",
    }],
    completion: { mode: "independent", targetIds: ["captcha-checkbox"] },
    focus: {
      targetId: "captcha-checkbox",
      contextRegionIds: ["captcha-control"],
      initialZoom: 1.15,
    },
  };
}

export async function yuantaTradeImageAssistanceStage(
  authPage: Page,
): Promise<WorkflowHumanAssistanceStage> {
  const modal = yuantaTradeCaptchaModal(authPage);
  const images = yuantaTradeCaptchaImages(modal);
  const imageCount = Math.min(await images.count(), 12);
  if (imageCount === 0) {
    throw new Error("YuanTa Trade image challenge is unavailable.");
  }
  const targets = Array.from({ length: imageCount }, (_, index) => ({
    id: `challenge-image-${index + 1}`,
    label: `Challenge image ${index + 1}`,
    semanticId: "yuanta-trade.login.challenge-control",
    modes: ["click"] as const,
    locator: images.nth(index),
  }));
  targets.push({
    id: "challenge-submit",
    label: "Verify challenge",
    semanticId: "yuanta-trade.login.challenge-submit",
    modes: ["click"],
    locator: yuantaTradeCaptchaSubmit(modal),
  });
  return {
    stageId: "yuanta-trade-challenge",
    title: "Select the requested YuanTa Trade challenge images",
    challengeKind: "image-selection",
    targets,
    contextRegions: [{
      id: "image-challenge",
      label: "Image challenge",
      semanticId: "yuanta-trade.login.challenge-region",
      locator: modal,
    }],
    challengeImageRegion: {
      id: "challenge-image-grid",
      label: "YuanTa Trade image challenge",
      semanticId: "yuanta-trade.login.challenge-image",
      locator: images.first(),
    },
    completion: { mode: "inline", targetIds: ["challenge-submit"] },
    focus: {
      targetId: targets[0]!.id,
      contextRegionIds: ["image-challenge"],
      initialZoom: 1.15,
    },
  };
}

export async function requestYuantaTradeAssistance(
  context: WorkflowContext,
  stage: WorkflowHumanAssistanceStage,
): Promise<"entered" | "verified"> {
  context.signal.throwIfAborted();
  let contract: HumanAssistanceContractInput;
  try {
    contract = await emitHumanAssistanceStage(stage, () => undefined);
  } catch (error) {
    await context.event("authentication", "human-assistance-failed");
    throw error;
  }
  await context.event("authentication", "human-assistance-requested");
  let status: Awaited<ReturnType<WorkflowContext["humanAssistance"]["request"]>>;
  try {
    status = await context.humanAssistance.request(contract, context.signal);
  } catch (error) {
    await context.event("authentication", "human-assistance-failed");
    throw error;
  }
  context.signal.throwIfAborted();
  if (status !== "entered" && status !== "verified") {
    await context.event("authentication", "human-assistance-failed");
    throw new Error(`YuanTa Trade human assistance ended with status ${status}.`);
  }
  await context.event("authentication", "human-assistance-completed");
  return status;
}

type YuantaTradeCredentials = {
  yuanta_trade_user_id?: string;
  yuanta_trade_password?: string;
  yuanta_trade_ca_path?: string;
  yuanta_trade_ca_password?: string;
};

const dateSchema = z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/);

const holdingTypeSchema = z.enum([
  "Stock",
  "SecuritiesLending",
  "UnlimitedUseLending",
  "Ledger",
  "Futures",
  "Oversea",
  "Wealth",
  "Bond",
  "Derivative",
  "InternationalSecurities",
]);

const tradeTypeSchema = z.enum([
  "StockTrade",
  "SecuritiesLendingTrade",
  "UnlimitedUseLendingTrade",
  "LedgerTrade",
  "FuturesTrade",
  "OverseaTrade",
  "WealthTrade",
  "BondTrade",
  "DerivativeTrade",
  "InternationalSecuritiesTrade",
]);

const typedInputSchema = z.object({
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  accountIndex: z.number().int().default(-1),
  includeHoldings: z.boolean().default(true),
  includeTrades: z.boolean().default(true),
  holdingTypes: z.array(holdingTypeSchema).default(holdingTypeSchema.options),
  tradeTypes: z.array(tradeTypeSchema).default(tradeTypeSchema.options),
  credentials: z.object({
    yuanta_trade_user_id: z.string().trim().min(1),
    yuanta_trade_password: z.string().trim().min(1),
    yuanta_trade_ca_path: z.string().trim().min(1),
    yuanta_trade_ca_password: z.string().trim().min(1),
  }),
});

type YuantaTradeProviderInput = z.infer<typeof typedInputSchema>;
type HoldingType = z.infer<typeof holdingTypeSchema>;
type TradeType = z.infer<typeof tradeTypeSchema>;
type NormalizedRow = Record<string, string>;

export type YuantaTradeProviderWorkflowOutput = Readonly<{
  usedExistingSession: boolean;
  dateRange: Readonly<{ startDate: string; endDate: string }>;
  holdingPageCount: number;
  holdingGridCount: number;
  holdingRowCount: number;
  tradePageCount: number;
  tradeGridCount: number;
  tradeRowCount: number;
  canonicalAdmission: "admitted";
  canonicalCaptureCount: number;
}>;

type GridColumn = {
  field: string;
  title: string;
};

type CapturedGrid = {
  gridId: string;
  category: string;
  columns: GridColumn[];
  rows: Record<string, unknown>[];
};

type AssetSummaryRow = {
  assetType: string;
  assetName: string;
  assetValueTwd: string;
  unrealizedPnlTwd: string;
};

type ReportPage = {
  reportType: string;
  url: string;
  title: string;
  currentAssetType: string | null;
  currentTradeType: string | null;
  currentFinanceType: string | null;
  queryDateType: string | null;
  startDate: string | null;
  endDate: string | null;
  subCategory: string | null;
  accountOptions: unknown[];
  summaryRows: AssetSummaryRow[];
  grids: CapturedGrid[];
};

export type YuantaTradeReportPage = ReportPage;

const DEFAULT_TRADE_SUBCATEGORIES: Partial<Record<TradeType, string>> = {
  SecuritiesLendingTrade: "Lend",
  UnlimitedUseLendingTrade: "Collateral",
  FuturesTrade: "DomesticFutures",
  OverseaTrade: "Stock",
  WealthTrade: "Cash",
  DerivativeTrade: "ASO",
  InternationalSecuritiesTrade: "Stock",
};

function requireCredential(
  credentials: YuantaTradeCredentials,
  name: keyof YuantaTradeCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(`Missing credential ${name}.`);
  }
  return value;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(
    date.getDate(),
  )}`;
}

function defaultStartDate(endDate: Date): Date {
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 90);
  return startDate;
}

function cleanText(value: string | null | undefined): string {
  return decodeHtml(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type YuantaSettlementMarket =
  typeof YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY;

/**
 * MarketNo is a provider-owned code, not a ticker or currency hint.  Its
 * explicit 52/53/54 mapping is part of the canonical market-v2 contract
 * emitted by buildYuantaTradeFundingEvidence below.
 */
const YUANTA_SOURCE_MARKET_NO_FIELD = "__source_market_no";

function normalizeYuantaSourceMarketCode(
  value: string | number | null | undefined,
): YuantaForeignSettlementMarketCode | undefined {
  const normalized = cleanText(
    value === null || value === undefined ? "" : String(value),
  ).normalize("NFKC");
  return isYuantaForeignSettlementMarketCode(normalized)
    ? normalized
    : undefined;
}

/**
 * Normalize only the provider's explicit MarketNo code. Currency, asset type,
 * security identifiers, and human-readable labels are deliberately excluded:
 * YuanTa's settlement schedule varies by market even when the currency is the
 * same, and the current canonical contract requires the raw source code.
 */
export function normalizeYuantaSettlementMarket(
  value: string | number | null | undefined,
): YuantaSettlementMarket | undefined {
  if (normalizeYuantaSourceMarketCode(value))
    return YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY;
  return undefined;
}

export function buildYuantaTradeFundingEvidence(input: {
  sourceRecordKey: string;
  stableLoginIdentity: string;
  currency: string;
  market?: string | number | null;
}): InvestmentFundingEvidence {
  const sourceMarketCode = normalizeYuantaSourceMarketCode(input.market);
  if (!sourceMarketCode)
    return { kind: "unresolved", sourceRecordKey: input.sourceRecordKey };
  const settlementMarket = normalizeYuantaSettlementMarket(sourceMarketCode);
  if (!settlementMarket)
    return { kind: "unresolved", sourceRecordKey: input.sourceRecordKey };

  return {
    kind: "source-settlement-contract",
    sourceRecordKey: input.sourceRecordKey,
    sourceLinkageKey: deriveYuantaForeignSettlementLinkageKey(
      input.stableLoginIdentity,
      input.currency,
    ),
    linkageContractVersion: YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
    settlementMarket,
    settlementMarketContractVersion:
      YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
    sourceMarketCode,
    settlementModel: "account-currency-date-net",
    contractVersion: YUANTA_FOREIGN_SETTLEMENT_CONTRACT_VERSION,
  };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, digits: string) =>
      String.fromCharCode(Number.parseInt(digits, 10)),
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html: string): string {
  return cleanText(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function rowValue(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined && String(value).length > 0) {
      return cleanText(String(value));
    }
  }
  return "";
}

function cleanOptionalAmount(value: string): string {
  const text = cleanText(value);
  return text === "--" ? "" : text;
}

function periodLabel(dateRange: {
  startDate: string;
  endDate: string;
}): string {
  return `${dateRange.startDate}~${dateRange.endDate}`;
}

function reportPeriod(page: ReportPage): string {
  if (page.startDate && page.endDate)
    return `${page.startDate}~${page.endDate}`;
  return page.startDate || page.endDate || "";
}

function dateSortKey(value: string): string {
  const match = cleanText(value).match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!match) return "";
  return `${match[1]}${match[2]}${match[3]}`;
}

function compareTradeRowsByDateDesc(
  left: NormalizedRow,
  right: NormalizedRow,
): number {
  return dateSortKey(right.trade_date).localeCompare(
    dateSortKey(left.trade_date),
  );
}

function getStringVar(html: string, name: string): string | null {
  const match = html.match(new RegExp(`var\\s+${name}\\s*=\\s*'([^']*)'`));
  return match?.[1] ?? null;
}

function findMatchingDelimiter(
  source: string,
  openIndex: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function parseJsonArrayAt(source: string, openIndex: number): unknown[] {
  const closeIndex = findMatchingDelimiter(source, openIndex, "[", "]");
  if (closeIndex < 0) return [];
  const raw = source.slice(openIndex, closeIndex + 1);
  return JSON.parse(raw) as unknown[];
}

function extractJsonArrayVar(html: string, name: string): unknown[] {
  const match = new RegExp(`var\\s+${name}\\s*=\\s*\\[`).exec(html);
  if (!match) return [];
  const openIndex = match.index + match[0].lastIndexOf("[");
  return parseJsonArrayAt(html, openIndex);
}

function extractDataArray(gridChunk: string): unknown[] {
  const dataMatch = /data\s*:\s*\[/.exec(gridChunk);
  if (!dataMatch) return [];
  const openIndex = dataMatch.index + dataMatch[0].lastIndexOf("[");
  return parseJsonArrayAt(gridChunk, openIndex);
}

function extractColumns(gridChunk: string): GridColumn[] {
  const columns: GridColumn[] = [];
  for (const match of gridChunk.matchAll(
    /field:\s*'([^']+)'\s*,\s*title:\s*'([^']*)'/g,
  )) {
    columns.push({
      field: match[1],
      title: stripTags(match[2]) || match[1],
    });
  }
  return columns;
}

function uniqueKey(
  baseKey: string,
  record: Record<string, unknown>,
  suffix: string,
): string {
  if (!(baseKey in record)) return baseKey;
  const withSuffix = `${baseKey} (${suffix})`;
  if (!(withSuffix in record)) return withSuffix;
  let index = 2;
  while (`${withSuffix} ${index}` in record) index += 1;
  return `${withSuffix} ${index}`;
}

export function normalizeRows(
  rawRows: unknown[],
  columns: GridColumn[],
): Record<string, unknown>[] {
  return rawRows
    .filter((row): row is Record<string, unknown> => {
      return typeof row === "object" && row !== null && !Array.isArray(row);
    })
    .map((row) => {
      if (columns.length === 0) return row;

      const normalized: Record<string, unknown> = {};
      for (const column of columns) {
        if (!(column.field in row)) continue;
        const key = uniqueKey(
          column.title || column.field,
          normalized,
          column.field,
        );
        normalized[key] = row[column.field];
      }
      // Kendo receives MarketNo in the raw row even though the UI omits that
      // metadata column. Preserve only this contract-approved source field;
      // arbitrary server properties must not leak into normalized evidence.
      if ("MarketNo" in row)
        normalized[YUANTA_SOURCE_MARKET_NO_FIELD] = row.MarketNo;
      return normalized;
    });
}

function gridCategory(gridId: string): string {
  return gridId.replace(/^grid/, "") || gridId;
}

function extractGrids(html: string): CapturedGrid[] {
  const grids: CapturedGrid[] = [];
  const gridRegex = /\$\(['"]#(grid[^'"]+)['"]\)\.kendoGrid\(/g;
  let match: RegExpExecArray | null;

  while ((match = gridRegex.exec(html))) {
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = findMatchingDelimiter(html, openIndex, "(", ")");
    if (closeIndex < 0) continue;

    const gridChunk = html.slice(openIndex + 1, closeIndex);
    const columns = extractColumns(gridChunk);
    const rawRows = extractDataArray(gridChunk);

    grids.push({
      gridId: match[1],
      category: gridCategory(match[1]),
      columns,
      rows: normalizeRows(rawRows, columns),
    });
  }

  return grids;
}

function extractAssetSummaryRows(html: string): AssetSummaryRow[] {
  const tableMatch = html.match(
    /<table\b[^>]*class=["'][^"']*\btable-asset\b[^"']*["'][^>]*>[\s\S]*?<\/table>/i,
  );
  if (!tableMatch) return [];

  const rows: AssetSummaryRow[] = [];
  for (const rowMatch of tableMatch[0].matchAll(
    /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi,
  )) {
    const assetType = rowMatch[1].match(
      /data-asset-type=["']([^"']+)["']/i,
    )?.[1];
    if (!assetType) continue;

    const cells = [
      ...rowMatch[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi),
    ].map((cellMatch) => stripTags(cellMatch[1]));
    if (cells.length < 3) continue;

    rows.push({
      assetType,
      assetName: cleanText(cells[0]),
      assetValueTwd: cleanOptionalAmount(cells[1]),
      unrealizedPnlTwd: cleanOptionalAmount(cells[2]),
    });
  }

  return rows;
}

export function parseReportPage(
  html: string,
  url: string,
  reportType: string,
): ReportPage {
  return {
    reportType,
    url,
    title: stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""),
    currentAssetType: getStringVar(html, "currAssetType"),
    currentTradeType: getStringVar(html, "currTradeType"),
    currentFinanceType: getStringVar(html, "currFinanceType"),
    queryDateType: getStringVar(html, "queryDateType"),
    startDate: getStringVar(html, "startDate"),
    endDate: getStringVar(html, "endDate"),
    subCategory: getStringVar(html, "subCategory"),
    accountOptions: extractJsonArrayVar(html, "accountData"),
    summaryRows: extractAssetSummaryRows(html),
    grids: extractGrids(html),
  };
}

async function settleAfterNavigation(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    // YuanTa pages keep analytics and local signing requests alive.
  });
  await page.waitForTimeout(750);
}

const YUANTA_SECURITY_COMPONENT_MESSAGE = "系統找不到安控元件";

export async function isYuantaSecurityComponentMissing(
  page: Page,
): Promise<boolean> {
  return page
    .getByText(YUANTA_SECURITY_COMPONENT_MESSAGE, { exact: false })
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false);
}

export async function dismissPasswordChangeReminderIfPresent(
  page: Page,
): Promise<void> {
  const postpone = page.getByRole("button", {
    name: "暫不變更",
    exact: true,
  });
  const visible = await postpone
    .isVisible({ timeout: 2_000 })
    .catch((error: unknown) => {
      if (
        error instanceof Error &&
        error.message.includes("Execution context was destroyed")
      ) {
        return false;
      }
      throw error;
    });
  if (!visible) return;

  await postpone.click();
  await settleAfterNavigation(page);
}

async function grantYuantaBrowserPermissions(page: Page): Promise<void> {
  await page.context().grantPermissions(["local-network-access"], {
    origin: "https://global.yuanta.com.tw",
  });
}

async function isSignedIn(page: Page): Promise<boolean> {
  if (!page.url().includes("/NexusWebTrade/AssetReport/")) return false;
  return await page
    .locator("#btnLogout")
    .isVisible({ timeout: 2_000 })
    .catch(() => false);
}

async function acceptDisclaimerIfPresent(page: Page): Promise<void> {
  const checkbox = page.locator("#checkDisclaimer");
  if (!(await checkbox.isVisible({ timeout: 2_000 }).catch(() => false))) {
    return;
  }

  await checkbox.check({ force: true });
  await page.locator("#btnConfirm").click();
  await settleAfterNavigation(page);
}

async function dismissPersonalMessageIfPresent(page: Page): Promise<void> {
  if (!page.url().includes("/NexusWebTrade/RA/PersonalMessage")) return;

  const closeButton = page.locator("button.close").first();
  if (!(await closeButton.isVisible({ timeout: 5_000 }).catch(() => false))) {
    return;
  }

  await closeButton.click();
  await settleAfterNavigation(page);
}

export async function fillTradeLoginForm(
  page: Page,
  credentials: YuantaTradeCredentials,
): Promise<void> {
  const userId = requireCredential(credentials, "yuanta_trade_user_id");
  const password = requireCredential(credentials, "yuanta_trade_password");

  await page.goto(YUANTA_TRADE_LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.locator("#loginid").fill(userId);
  await page.locator("#loginPWD").fill(password);
  await page.locator("#loginPWD").blur();
}

function responseCharset(headers: Record<string, string>, bytes: Uint8Array): string {
  const contentType = headers["content-type"] ?? headers["Content-Type"] ?? "";
  const headerCharset = contentType.match(/\bcharset\s*=\s*["']?([^\s;"']+)/i)?.[1];
  if (headerCharset) return headerCharset;

  // Charset declarations are ASCII, so inspecting a small byte prefix does
  // not decode or normalize the provider's financial payload.
  const asciiPrefix = Buffer.from(bytes.subarray(0, 4096)).toString("latin1");
  const metaCharset = asciiPrefix.match(
    /<meta\b[^>]*\bcharset\s*=\s*["']?([^\s;"'/>]+)/i,
  )?.[1];
  if (metaCharset) return metaCharset;
  throw new Error("Yuanta Trade source response did not declare a text encoding.");
}

/** Decode the original report response bytes through the injected strict text port. */
export async function decodeYuantaTradeReportResponse(
  response: Response,
  text: SourceTextPort,
  reportType: string,
): Promise<ReportPage> {
  const expectedUrl = new URL(
    `/NexusWebTrade/AssetReport/${reportType}`,
    YUANTA_TRADE_LOGIN_URL,
  );
  let actualUrl: URL;
  try {
    actualUrl = new URL(response.url());
  } catch {
    throw new Error("Yuanta Trade report response URL is invalid.");
  }
  if (
    response.status() < 200 ||
    response.status() >= 300 ||
    response.request().method().toUpperCase() !== "POST" ||
    actualUrl.origin !== expectedUrl.origin ||
    actualUrl.pathname !== expectedUrl.pathname
  ) {
    throw new Error("Yuanta Trade report response did not match the requested source.");
  }

  const headers = response.headers();
  const contentType = headers["content-type"] ?? headers["Content-Type"] ?? "";
  if (!/^text\/html\b/i.test(contentType)) {
    throw new Error("Yuanta Trade report response was not HTML.");
  }
  const bytes = await response.body();
  const html = text.decode(bytes, responseCharset(headers, bytes));
  text.assertIntact(html);
  return parseReportPage(html, response.url(), reportType);
}

async function captureTypedReport(
  page: Page,
  reportType: string,
  params: Record<string, string | number>,
  context: WorkflowContext,
): Promise<ReportPage> {
  context.signal.throwIfAborted();
  const navigation = page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.evaluate(
    ({ reportType, params }) => {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = reportType;
      for (const [key, value] of Object.entries(params)) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = key;
        input.value = String(value);
        form.appendChild(input);
      }
      document.body.appendChild(form);
      window.setTimeout(() => form.submit(), 0);
    },
    { reportType, params },
  );
  const response = await navigation;
  context.signal.throwIfAborted();
  if (!response) {
    throw new Error("Yuanta Trade report navigation returned no source response.");
  }
  const captured = await decodeYuantaTradeReportResponse(
    response,
    context.text,
    reportType,
  );
  await acceptDisclaimerIfPresent(page);
  await page.locator("#btnLogout").waitFor({ timeout: 60_000 });
  return captured;
}

function tradeParams(
  input: Pick<YuantaTradeProviderInput, "accountIndex">,
  tradeType: TradeType,
  dateRange: { startDate: string; endDate: string },
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    index: input.accountIndex,
    queryDateType: "6",
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
  };

  const subCategory = DEFAULT_TRADE_SUBCATEGORIES[tradeType];
  if (subCategory) params.subCategory = subCategory;

  return params;
}

function gridCount(pages: ReportPage[]): number {
  return pages.reduce((total, page) => total + page.grids.length, 0);
}

type HoldingCaptureEvidence = Pick<
  ReportPage,
  "reportType" | "url" | "currentAssetType" | "summaryRows" | "grids"
>;

export function isCompleteHoldingCapture(
  pages: HoldingCaptureEvidence[],
  requestedTypes: readonly string[],
): boolean {
  if (requestedTypes.length === 0 || pages.length !== requestedTypes.length) {
    return false;
  }
  const pagesByType = new Map(pages.map((page) => [page.reportType, page]));
  return requestedTypes.every((reportType) => {
    const page = pagesByType.get(reportType);
    if (!page || page.currentAssetType !== reportType) return false;
    let routeName = "";
    try {
      routeName =
        new URL(page.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    } catch {
      return false;
    }
    const hasParsedReportStructure =
      page.grids.length > 0 || page.summaryRows.length > 0;
    return routeName === reportType && hasParsedReportStructure;
  });
}

export function isCompleteTradeCapture(
  pages: readonly ReportPage[],
  requestedTypes: readonly string[],
  dateRange: Readonly<{ startDate: string; endDate: string }>,
): boolean {
  if (requestedTypes.length === 0 || pages.length !== requestedTypes.length) {
    return false;
  }
  const pagesByType = new Map(pages.map((page) => [page.reportType, page]));
  return requestedTypes.every((reportType) => {
    const page = pagesByType.get(reportType);
    if (
      !page ||
      page.currentTradeType !== reportType ||
      page.queryDateType !== "6" ||
      page.startDate !== dateRange.startDate ||
      page.endDate !== dateRange.endDate ||
      page.grids.length === 0
    ) return false;
    let routeName = "";
    try {
      routeName = new URL(page.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    } catch {
      return false;
    }
    return routeName === reportType;
  });
}

export function normalizeTradeRows(
  pages: ReportPage[],
  dateRange: { startDate: string; endDate: string },
): NormalizedRow[] {
  const period = periodLabel(dateRange);
  const rows: NormalizedRow[] = [];

  for (const page of pages) {
    for (const grid of page.grids) {
      for (const row of grid.rows) {
        const tradeDate = rowValue(row, ["交易日期"]);
        if (!tradeDate) continue;

        rows.push({
          trade_date: tradeDate,
          account_number: rowValue(row, ["交易帳號"]),
          asset_type: page.currentAssetType ?? "",
          trade_type: page.reportType,
          sub_category: page.subCategory || grid.category,
          product_code: rowValue(row, [
            "商品代號",
            "證券代號",
            "股票代號",
            "標的代號",
            "債券代號",
          ]),
          product_name: rowValue(row, [
            "商品名稱",
            "證券名稱",
            "投資標的",
            "標的名稱",
            "擔保品名稱",
          ]),
          currency: rowValue(row, [
            "商品幣別",
            "交易幣別",
            "幣別",
            "計價幣別",
            "投資幣別",
          ]),
          action: rowValue(row, ["交易類別"]),
          description: rowValue(row, [
            "交易備註",
            "備註",
            "備註說明",
            "描述",
            "說明",
            "交易摘要",
          ]),
          source_transaction_reference: rowValue(row, [
            "交易序號",
            "委託書號",
            "成交序號",
            "交割序號",
            "參考號碼",
          ]),
          quantity: rowValue(row, [
            "面額/股數",
            "股數",
            "數量",
            "成交口數",
            "沖銷單位",
            "原始單位",
            "單位數",
            "交易單位數",
            "交易面額",
            "名目本金",
            "契約名目本金",
          ]),
          price: rowValue(row, [
            "價格",
            "成交價",
            "成交價格",
            "淨值",
            "約定利率 (年化)",
          ]),
          gross_amount: rowValue(row, [
            "交易價金",
            "成交金額",
            "價金",
            "交易金額",
            "交割金額",
            "現金收入(元)",
          ]),
          fee: rowValue(row, [
            "手續費",
            "手續/處理費",
            "手續處理費",
            "借券費",
            "入券費",
            "設質費",
          ]),
          tax: rowValue(row, ["稅/費", "交易稅", "代扣稅", "分離課稅"]),
          settlement_amount: rowValue(row, [
            "交割金額(原幣)",
            "應收付",
            "淨收付",
            "給付淨額",
            "應收付金額",
            "交割金額",
            "現金收入(元)",
            "現金支出(元)",
            "收入",
            "支出",
          ]),
          settlement_currency: rowValue(row, ["交割幣別"]),
          market: rowValue(row, [YUANTA_SOURCE_MARKET_NO_FIELD, "MarketNo"]),
          realized_pnl: rowValue(row, [
            "已實現損益",
            "含息投資損益",
            "客戶損益(稅前)",
          ]),
          cost_amount: rowValue(row, [
            "成本金額(原幣)",
            "投資成本",
            "累計投資成本",
          ]),
          __period: period,
        });
      }
    }
  }

  return rows.sort(compareTradeRowsByDateDesc);
}

function normalizeHoldingRows(
  pages: ReportPage[],
  _fallbackDateRange: { startDate: string; endDate: string },
): NormalizedRow[] {
  const rows: NormalizedRow[] = [];

  for (const page of pages) {
    const asOfDate = page.endDate || page.startDate || "";
    const period = reportPeriod(page) || asOfDate;

    for (const grid of page.grids) {
      for (const row of grid.rows) {
        const productCode = rowValue(row, [
          "商品代號",
          "證券代號",
          "股票代號",
          "標的代號",
        ]);
        const productName = rowValue(row, [
          "商品名稱",
          "證券名稱",
          "股票名稱",
          "基金名稱",
          "商品",
          "標的",
        ]);

        if (!productCode && !productName) continue;

        rows.push({
          as_of_date: asOfDate,
          account_number: rowValue(row, ["交易帳號"]),
          asset_type: page.currentAssetType ?? page.reportType,
          sub_category: page.subCategory || grid.category,
          product_code: productCode,
          product_name: productName,
          currency: rowValue(row, ["交易幣別", "商品幣別", "計價幣別", "幣別"]),
          quantity: rowValue(row, [
            "面額/股數",
            "股數",
            "數量",
            "餘額單位",
            "單位數",
            "未平倉口數",
            "票面餘額",
            "名目本金",
          ]),
          market_date: rowValue(row, [
            "市價日期",
            "淨值日",
            "價格參考日",
            "交易日",
          ]),
          market_price: rowValue(row, ["參考市價", "參考價格", "參考淨值"]),
          market_value_original: rowValue(row, [
            "原幣現值",
            "參考現值 (原幣)",
            "資產淨值",
          ]),
          market_value_twd: rowValue(row, [
            "台幣現值",
            "市值",
            "參考現值 (約當台幣)",
            "擔保品市值",
            "約當台幣",
          ]),
          cost_price: rowValue(row, ["成本價格"]),
          cost_amount: rowValue(row, [
            "買入成本",
            "投資成本",
            "期初投入 (約當台幣)",
          ]),
          unrealized_pnl_original: rowValue(row, [
            "未實現損益 (原幣)",
            "未實現損益",
          ]),
          unrealized_pnl_twd: rowValue(row, [
            "未實現損益 (約當台幣)",
            "未實現損益 (台幣)",
            "損益",
          ]),
          return_rate: rowValue(row, [
            "參考報酬率",
            "含息報酬率",
            "不含息報酬率",
          ]),
          fx_rate: rowValue(row, ["參考匯率 (原幣)", "參考匯率"]),
          __period: period,
          __trade_type: page.currentTradeType ?? "",
        });
      }
    }
  }

  return rows;
}

function exactAmount(value: string): { coefficient: string; scale: number } {
  const normalized = value.replaceAll(",", "").trim();
  const match = /^-?(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match)
    throw new Error(
      "Yuanta Trade canonical amount is not an exact non-negative decimal.",
    );
  return {
    coefficient: `${match[1]}${match[2] ?? ""}`.replace(/^0+(?=\d)/, ""),
    scale: match[2]?.length ?? 0,
  };
}
function sourceDate(value: string): string {
  const normalized = value.trim().replaceAll("/", "-");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized))
    throw new Error("Yuanta Trade canonical source date is missing.");
  return normalized;
}

export function mapYuantaTradeCanonicalInvestmentRow(
  accountNumber: string,
  row: NormalizedRow,
  rowKind: "holding" | "transaction",
  occurrenceOrdinal: number,
): YuantaCanonicalInvestmentRow {
  const originalValue = row.market_value_original?.trim();
  const twdValue = row.market_value_twd?.trim();
  const originalCurrency = (
    row.currency || row.settlement_currency || "TWD"
  ).trim();

  return {
    sourceRecordKey: yuantaTradeCanonicalOccurrenceIdentity(
      accountNumber,
      rowKind,
      row,
      occurrenceOrdinal,
    ),
    producerSecurityId: row.product_code?.trim() ?? "",
    securityName: row.product_name?.trim() || undefined,
    ticker: row.product_code?.trim() || undefined,
    currency: originalCurrency,
    effectiveOn: sourceDate(row.as_of_date || row.trade_date || ""),
    quantity: row.quantity ? exactAmount(row.quantity) : undefined,
    description: row.description?.trim() || undefined,
    valuation: originalValue
      ? { ...exactAmount(originalValue), currency: originalCurrency }
      : twdValue
        ? { ...exactAmount(twdValue), currency: "TWD" }
        : undefined,
  };
}

export function explicitAction(value: string): InvestmentTransactionAction {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (["b", "buy", "買進", "買入", "普通買進"].includes(normalized))
    return "buy";
  if (["s", "sell", "賣出", "普通賣出"].includes(normalized))
    return "sell";
  if (normalized === "公司活動-移入") return "corporate_action_in";
  if (normalized === "公司活動-移出") return "corporate_action_out";
  if (normalized === "配息") return "dividend";
  throw new Error(
    "Yuanta Trade canonical action is not an explicit supported provider event.",
  );
}
export function yuantaTradeCanonicalOccurrenceIdentity(
  accountNumber: string,
  rowKind: "holding" | "transaction",
  row: NormalizedRow,
  _occurrenceOrdinal: number,
): string {
  const stableSourceIdentity = row.source_transaction_reference?.trim();
  // Holdings are point-in-time observations, not buy/sell events. The source
  // does not provide an action for them, so make that semantic distinction
  // explicit instead of passing an empty required identity part downstream.
  const actionIdentity =
    rowKind === "holding" ? "holding-observation" : row.action ?? "";
  return deriveSourceConnectionIdentityKey("yuanta-trade-record", [
    accountNumber,
    rowKind,
    row.product_code ?? "",
    row.as_of_date ?? row.trade_date ?? "",
    actionIdentity,
    row.quantity ?? "",
    row.settlement_amount ?? row.market_value_twd ?? "",
    stableSourceIdentity || "no-source-reference",
  ]);
}
export function assertYuantaTradeCanonicalOccurrenceIdentities(
  accountNumber: string,
  rowKind: "holding" | "transaction",
  rows: readonly NormalizedRow[],
): string[] {
  const identities = rows.map((row, index) =>
    yuantaTradeCanonicalOccurrenceIdentity(accountNumber, rowKind, row, index),
  );
  if (new Set(identities).size !== identities.length)
    throw new Error(
      "Yuanta Trade canonical capture contains indistinguishable duplicate rows without a provider-stable row identity.",
    );
  return identities;
}
export function buildYuantaTradeCanonicalCaptures(
  credentials: YuantaTradeCredentials,
  holdingRows: NormalizedRow[],
  tradeRows: NormalizedRow[],
): InvestmentValidatedCapture[] {
  const accountNumbers = [
    ...new Set(
      [...holdingRows, ...tradeRows]
        .map((row) => row.account_number?.trim())
        .filter(Boolean),
    ),
  ];
  const captures: InvestmentValidatedCapture[] = [];
  for (const accountNumber of accountNumbers) {
    const accountNumberEvidence = deriveYuantaTradeAccountNumberEvidence(
      accountNumber!,
    );
    const accountHoldings = holdingRows.filter(
      (row) => row.account_number?.trim() === accountNumber,
    );
    const accountTrades = tradeRows.filter(
      (row) => row.account_number?.trim() === accountNumber,
    );
    if (accountHoldings.length === 0 && accountTrades.length === 0) continue;
    assertYuantaTradeCanonicalOccurrenceIdentities(
      accountNumber!,
      "holding",
      accountHoldings,
    );
    assertYuantaTradeCanonicalOccurrenceIdentities(
      accountNumber!,
      "transaction",
      accountTrades,
    );
    const observedAt = new Date().toISOString();
    const effectiveDates = [
      ...new Set(
        accountHoldings.map((row) => sourceDate(row.as_of_date ?? "")),
      ),
    ];
    if (effectiveDates.length !== 1)
      throw new Error(
        "Yuanta Trade canonical holdings require one source-proven as-of date.",
      );
    const mapRow = (
      row: NormalizedRow,
      rowKind: "holding" | "transaction",
      occurrenceOrdinal: number,
    ): YuantaCanonicalInvestmentRow =>
      mapYuantaTradeCanonicalInvestmentRow(
        accountNumber!,
        row,
        rowKind,
        occurrenceOrdinal,
      );
    const holdings = accountHoldings.map((row, index) =>
      mapRow(row, "holding", index),
    );
    const sourceConnectionKey = deriveSourceConnectionIdentityKey(
      "yuanta-trade",
      credentials.yuanta_trade_user_id ?? "",
    );
    const accountKey = deriveSourceConnectionIdentityKey(
      "yuanta-trade-account",
      accountNumber!,
    );
    const transactions = accountTrades.map((row, index) => {
      const mapped = mapRow(row, "transaction", index);
      const cashEffect = {
        ...exactAmount(row.settlement_amount || row.gross_amount || ""),
        currency: (row.settlement_currency || row.currency || "TWD").trim(),
      };
      const action = explicitAction(row.action ?? "");
      return {
        ...mapped,
        action,
        cashEffect,
        fundingEvidence:
          action === "buy" || action === "sell"
            ? buildYuantaTradeFundingEvidence({
                sourceRecordKey: mapped.sourceRecordKey,
                stableLoginIdentity: credentials.yuanta_trade_user_id ?? "",
                currency: cashEffect.currency,
                market: row.market,
              })
            : { kind: "unresolved" as const, sourceRecordKey: mapped.sourceRecordKey },
      };
    });
    const capture = buildYuantaInvestmentCapture({
      sourceId: "yuanta-trade",
      captureId: `yuanta-trade-investment:${deriveSourceConnectionIdentityKey("yuanta-trade-capture", [sourceConnectionKey, accountKey, observedAt])}`,
      sourceConnectionKey,
      identityEpochKey: deriveSourceConnectionIdentityKey(
        "yuanta-trade-epoch",
        [sourceConnectionKey, accountNumber!],
      ),
      accountKey,
      ...(accountNumberEvidence
        ? { accountNumber: accountNumberEvidence }
        : {}),
      reportingCurrency: "TWD",
      observedAt,
      sourceEffectiveOn: effectiveDates[0]!,
      holdings,
      transactions,
    });
    captures.push(admitCanonicalInvestmentCapture(capture));
  }
  return captures;
}

export async function assertYuantaTradeServiSignAvailable(
  page: Page,
  context: WorkflowContext,
): Promise<void> {
  if (!(await isYuantaSecurityComponentMissing(page))) return;
  await context.event("authentication", "servisign-unavailable");
  throw new Error(
    "The YuanTa security component is unavailable. Install or update it, then run the task again.",
  );
}

async function completeTypedCertificateIfPresent(
  page: Page,
  credentials: YuantaTradeCredentials,
  context: WorkflowContext,
): Promise<void> {
  const selectFileButton = page.locator("#btnPfxFile");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    context.signal.throwIfAborted();
    if (await page.locator("#btnLogout, #checkDisclaimer").first().isVisible().catch(() => false)) {
      return;
    }
    await assertYuantaTradeServiSignAvailable(page, context);
    if (await selectFileButton.isVisible().catch(() => false)) break;
    await page.waitForTimeout(500);
  }

  if (!(await selectFileButton.isVisible().catch(() => false))) {
    await assertYuantaTradeServiSignAvailable(page, context);
    throw new Error("Timed out waiting for the YuanTa certificate form.");
  }

  await page.locator("#jpki_PfxFile").fill(
    requireCredential(credentials, "yuanta_trade_ca_path"),
  );
  const passwordField = page.locator("#jpki_PfxFilePwd");
  if (!(await passwordField.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const stage: WorkflowHumanAssistanceStage = {
      stageId: "yuanta-trade-certificate-selection",
      title: "Select the YuanTa Trade certificate",
      targets: [{
        id: "certificate-picker",
        label: "Certificate file selection",
        semanticId: "yuanta-trade.login.certificate-picker",
        modes: ["click"],
        locator: selectFileButton,
      }],
      contextRegions: [{
        id: "certificate-form",
        label: "Certificate sign-in form",
        semanticId: "yuanta-trade.login.certificate-form",
      }],
      completion: { mode: "inline", targetIds: ["certificate-picker"] },
      focus: {
        targetId: "certificate-picker",
        contextRegionIds: ["certificate-form"],
      },
    };
    await requestYuantaTradeAssistance(context, stage);
    await passwordField.waitFor({ state: "visible", timeout: 60_000 });
  }
  await passwordField.fill(
    requireCredential(credentials, "yuanta_trade_ca_password"),
  );
  await page.locator("#btnGo").click();
  await settleAfterNavigation(page);
}

async function submitTypedLoginIfReady(page: Page): Promise<void> {
  const loginButton = page.locator("#loginBtn");
  if (!(await loginButton.isVisible({ timeout: 2_000 }).catch(() => false))) return;

  const checkbox = page.locator("#chbYCaptchaV2");
  if (await checkbox.isVisible({ timeout: 1_000 }).catch(() => false)) {
    const checked = await checkbox.isChecked().catch(() => false);
    if (!checked) {
      throw new Error("YuanTa Trade CAPTCHA checkbox was not completed.");
    }
  }
  if (await yuantaTradeCaptchaModal(page).isVisible().catch(() => false)) {
    throw new Error("YuanTa Trade image challenge was not completed.");
  }
  await loginButton.click();
  await settleAfterNavigation(page);
}

async function authenticateYuantaTradePage(
  page: Page,
  credentials: YuantaTradeCredentials,
  context: WorkflowContext,
): Promise<boolean> {
  await grantYuantaBrowserPermissions(page);
  if (await isSignedIn(page)) return true;

  await fillTradeLoginForm(page, credentials);
  const canSwitchCaptcha = await page.evaluate(() =>
    typeof (window as unknown as { switchCaptchaType?: unknown }).switchCaptchaType === "function",
  ).catch(() => false);
  if (canSwitchCaptcha) {
    await page.evaluate(() => (
      window as unknown as { switchCaptchaType: (type: string) => void }
    ).switchCaptchaType("A"));
  }
  const audioInput = page.locator("#verificationCode");
  if (await audioInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await requestYuantaTradeAssistance(
      context,
      yuantaTradeAudioAssistanceStage(page),
    );
    if (!(await audioInput.inputValue()).trim()) {
      throw new Error("YuanTa Trade audio verification code was not entered.");
    }
  }

  const checkbox = page.locator("#chbYCaptchaV2");
  if (
    await checkbox.isVisible({ timeout: 2_000 }).catch(() => false) &&
    !(await checkbox.isChecked().catch(() => false))
  ) {
    await requestYuantaTradeAssistance(
      context,
      yuantaTradeCaptchaCheckboxAssistanceStage(page),
    );
  }
  const modal = yuantaTradeCaptchaModal(page);
  if (await modal.isVisible().catch(() => false)) {
    await requestYuantaTradeAssistance(
      context,
      await yuantaTradeImageAssistanceStage(page),
    );
    if (await modal.isVisible().catch(() => false)) {
      throw new Error("YuanTa Trade image challenge was not completed.");
    }
  }

  await assertYuantaTradeServiSignAvailable(page, context);
  await submitTypedLoginIfReady(page);
  await completeTypedCertificateIfPresent(page, credentials, context);
  await dismissPasswordChangeReminderIfPresent(page);
  await dismissPersonalMessageIfPresent(page);
  await acceptDisclaimerIfPresent(page);
  await page.locator("#btnLogout").waitFor({ timeout: 120_000 });
  return false;
}

export type YuantaTradeWorkflowDependencies = Readonly<{
  authenticate?: (
    page: Page,
    credentials: YuantaTradeCredentials,
    context: WorkflowContext,
  ) => Promise<boolean>;
  captureReport?: (
    page: Page,
    reportType: string,
    params: Record<string, string | number>,
    context: WorkflowContext,
  ) => Promise<YuantaTradeReportPage>;
}>;

/** App-owned Yuanta Trade path: complete in-memory collection and admission precede one injected commit request. */
export async function runYuantaTradeProviderWorkflow(
  context: WorkflowContext,
  rawInput: unknown,
  dependencies: YuantaTradeWorkflowDependencies = {},
): Promise<YuantaTradeProviderWorkflowOutput> {
  const parsed = typedInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new Error("YuanTa Trade workflow credentials or selection are invalid.");
  }
  if (!context.financialCommit) {
    throw new Error("Canonical Financial Commit port is unavailable.");
  }
  const financialCommit = context.financialCommit;
  const input = parsed.data;
  if (!input.includeHoldings || !input.includeTrades) {
    throw new Error("YuanTa Trade canonical collection requires holdings and trades.");
  }
  if (
    new Set(input.holdingTypes).size !== input.holdingTypes.length ||
    new Set(input.tradeTypes).size !== input.tradeTypes.length
  ) {
    throw new Error("YuanTa Trade source selection contains duplicate report types.");
  }

  context.signal.throwIfAborted();
  const now = new Date(context.now());
  const dateRange = {
    startDate: input.startDate ?? formatDate(defaultStartDate(now)),
    endDate: input.endDate ?? formatDate(now),
  };
  const authenticate = dependencies.authenticate ?? authenticateYuantaTradePage;
  const readReport = dependencies.captureReport ?? captureTypedReport;

  return context.browser.withPage(async (page) => {
    context.signal.throwIfAborted();
    page.on("dialog", (dialog) => {
      void dialog.accept().catch(() => undefined);
    });
    await context.event("authentication", "authentication-started");
    let usedExistingSession: boolean;
    try {
      usedExistingSession = await authenticate(page, input.credentials, context);
    } catch (error) {
      await context.event("authentication", "authentication-failed");
      throw error;
    }
    context.signal.throwIfAborted();
    await context.event("authentication", "authentication-completed");

    const requestedHoldingTypes = input.holdingTypes as HoldingType[];
    const requestedTradeTypes = input.tradeTypes as TradeType[];
    const requests = [
      ...requestedHoldingTypes.map((type) => ({
        reportType: type,
        params: { index: input.accountIndex },
        category: "holding" as const,
      })),
      ...requestedTradeTypes.map((type) => ({
        reportType: type,
        params: tradeParams(input, type, dateRange),
        category: "trade" as const,
      })),
    ];
    await context.event("collection", "collection-started", {
      completed: 0,
      total: requests.length,
    });
    await context.event("decoding", "source-decoding-started");
    const holdings: ReportPage[] = [];
    const trades: ReportPage[] = [];
    try {
      for (const [index, request] of requests.entries()) {
        context.signal.throwIfAborted();
        const reportPage = await readReport(
          page,
          request.reportType,
          request.params,
          context,
        );
        (request.category === "holding" ? holdings : trades).push(reportPage);
        await context.event("collection", "report-collected", {
          completed: index + 1,
          total: requests.length,
        });
      }
    } catch (error) {
      await context.event("collection", "source-collection-failed");
      await context.event("decoding", "source-decoding-failed");
      throw error;
    }
    await context.event("decoding", "source-decoding-completed");
    context.signal.throwIfAborted();

    const completeHoldings = isCompleteHoldingCapture(
      holdings,
      requestedHoldingTypes,
    );
    const completeTrades = isCompleteTradeCapture(
      trades,
      requestedTradeTypes,
      dateRange,
    );
    if (!completeHoldings || !completeTrades) {
      await context.event("validation", "source-validation-rejected", {
        completed: holdings.length + trades.length,
        total: requests.length,
      });
      throw new Error("YuanTa Trade source is incomplete; Canonical Financial Commit was rejected.");
    }

    await context.event("validation", "source-validation-started", {
      completed: requests.length,
      total: requests.length,
    });
    const tradeRows = normalizeTradeRows(trades, dateRange);
    const holdingRows = normalizeHoldingRows(holdings, dateRange);
    let captures: InvestmentValidatedCapture[];
    try {
      captures = buildYuantaTradeCanonicalCaptures(
        input.credentials,
        holdingRows,
        tradeRows,
      );
      if (captures.length === 0) {
        throw new Error("YuanTa Trade source contains no account-scoped investment capture.");
      }
    } catch (error) {
      await context.event("validation", "source-validation-rejected");
      throw error;
    }
    await context.event("validation", "source-validation-completed", {
      completed: captures.length,
      total: captures.length,
    });
    context.signal.throwIfAborted();

    const items: PGliteWorkflowRunItem[] = captures.map((capture) => ({
      provider: "yuanta-trade",
      product: "investment",
      itemKey: capture.captureId,
      command: {
        kind: PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
        request: { capture },
      },
      relationCommands: () => [{
        kind: PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
        request: {
          sourceConnectionKey: capture.identity.sourceConnectionKey,
          observedAt: capture.observedAt,
        },
      }],
    }));
    await context.event("commit", "canonical-commit-started", {
      completed: 0,
      total: items.length,
    });
    const result = await financialCommit.execute(items, {
      provider: "yuanta-trade",
      product: "investment",
      signal: context.signal,
    });
    if (
      result.status !== "completed" ||
      result.items.length !== items.length ||
      result.items.some((item) => item.status !== "committed")
    ) {
      const codes = result.diagnostics
        .map((diagnostic) => `${diagnostic.stage}/${diagnostic.errorCode}`)
        .join(", ");
      throw new Error(`YuanTa Trade Canonical Financial Commit failed: ${codes || result.status}.`);
    }
    await context.event("commit", "canonical-commit-completed", {
      completed: items.length,
      total: items.length,
    });
    return {
      usedExistingSession,
      dateRange,
      holdingPageCount: holdings.length,
      holdingGridCount: gridCount(holdings),
      holdingRowCount: holdingRows.length,
      tradePageCount: trades.length,
      tradeGridCount: gridCount(trades),
      tradeRowCount: tradeRows.length,
      canonicalAdmission: "admitted",
      canonicalCaptureCount: captures.length,
    };
  });
}
