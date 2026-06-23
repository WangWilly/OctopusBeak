import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow, pause, type LibrettoWorkflowContext } from "libretto";
import type { Frame, Locator, Page } from "playwright";
import XLSX from "xlsx";
import { z } from "zod";

const BANK_ENTRY_URL =
  "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces";

type BrowserScope = Page | Frame;

export const fubonStatementDateRangeSchema = z.enum([
  "1",
  "3",
  "7",
  "14",
  "21",
  "30",
  "60",
  "90",
  "180",
  "180_365",
]);

export const fubonStatementsInputSchema = z.object({
  dateRanges: z
    .array(fubonStatementDateRangeSchema)
    .min(1)
    .default(["180", "180_365"]),
  downloadFormat: z.enum(["TXT", "EXCEL", "PDF"]).default("EXCEL"),
});

export const fubonStatementsOutputSchema = z.object({
  dateRanges: z.array(fubonStatementDateRangeSchema),
  downloadFormat: z.enum(["TXT", "EXCEL", "PDF"]),
  count: z.number().int().nonnegative(),
  downloads: z.array(
    z.object({
      account: z.string(),
      dateRange: fubonStatementDateRangeSchema,
      filename: z.string(),
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      csvPath: z.string().optional(),
      csvBytes: z.number().int().nonnegative().optional(),
    }),
  ),
});

export type FubonCredentials = {
  fubon_user_id?: string;
  fubon_account?: string;
  fubon_password?: string;
};

export type FubonStatementsInput = z.infer<typeof fubonStatementsInputSchema>;
export type FubonStatementsOutput = z.infer<typeof fubonStatementsOutputSchema>;

type Input = FubonStatementsInput & {
  credentials: FubonCredentials;
};

function requireCredential(
  credentials: FubonCredentials,
  name: keyof FubonCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing credential ${name}. Set LIBRETTO_CLOUD_${name.toUpperCase()} in .env.`,
    );
  }
  return value;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function maskAccount(account: string): string {
  const digits = digitsOnly(account);
  if (digits.length <= 4) return "****";
  return `${"*".repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
}

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function csvPathFor(path: string): string {
  const csvPath = path.replace(/\.[^/.]+$/, ".csv");
  return csvPath === path ? `${path}.csv` : csvPath;
}

async function convertXlsToCsv(path: string) {
  const workbook = XLSX.readFile(path);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error(`Downloaded Excel file has no worksheets: ${path}`);
  }

  const worksheet = workbook.Sheets[sheetName];
  const csv = XLSX.utils.sheet_to_csv(worksheet);
  const csvPath = csvPathFor(path);
  await writeFile(csvPath, csv.endsWith("\n") ? csv : `${csv}\n`, "utf8");

  const csvStat = await stat(csvPath);
  return { csvPath, csvBytes: csvStat.size };
}

async function waitForFrame(
  page: Page,
  name: string,
  timeoutMs = 60_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frame({ name });
    if (frame) return frame;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for frame "${name}".`);
}

async function fillLoginForm(page: Page, credentials: FubonCredentials) {
  const userId = requireCredential(credentials, "fubon_user_id");
  const account = requireCredential(credentials, "fubon_account");
  const password = requireCredential(credentials, "fubon_password");

  await page.goto(BANK_ENTRY_URL, { waitUntil: "domcontentloaded" });

  const headerFrame = await waitForFrame(page, "frame1");
  await headerFrame.locator("#menu_CDS").click({ force: true });

  const landingFrame = await waitForFrame(page, "txnFrame");
  const myDepositsHref = await landingFrame
    .locator("a.task_CBOQU003.menu_CDS0102")
    .first()
    .getAttribute("href");
  if (!myDepositsHref) {
    throw new Error("Could not find the My Deposits navigation href.");
  }
  await landingFrame.goto(new URL(myDepositsHref, BANK_ENTRY_URL).toString(), {
    waitUntil: "domcontentloaded",
  });

  await headerFrame
    .locator("a")
    .filter({ hasText: "登入" })
    .first()
    .click({ force: true });

  const loginFrame = await waitForFrame(page, "txnFrame");
  const visiblePasswordFields = loginFrame.locator(
    'input[type="password"]:visible',
  );
  await visiblePasswordFields.first().waitFor({ timeout: 60_000 });

  // The bank page renders these fields as password inputs even for user ID/account.
  await visiblePasswordFields.nth(0).fill(userId);
  await visiblePasswordFields.nth(1).fill(account);
  await visiblePasswordFields.nth(2).fill(password);
  await loginFrame.locator("#m1_userCaptcha").focus();
}

async function waitForSignedInState(page: Page) {
  const headerFrame = await waitForFrame(page, "frame1");
  await headerFrame.locator("#header_form\\:header_logout").waitFor({
    state: "visible",
    timeout: 120_000,
  });
}

function depositRows(scope: BrowserScope): Locator {
  return scope
    .locator("tr")
    .filter({ has: scope.locator("a.btn_sel").filter({ hasText: "交易明細查詢" }) });
}

async function countDepositRows(scope: BrowserScope): Promise<number> {
  await scope
    .locator("a.btn_sel")
    .filter({ hasText: "交易明細查詢" })
    .first()
    .waitFor({
      state: "attached",
      timeout: 60_000,
    });
  return await depositRows(scope).count();
}

async function readMaskedAccountLabel(row: Locator): Promise<string> {
  const raw = await row
    .locator("td")
    .first()
    .innerText()
    .catch(async () => await row.innerText());
  return maskAccount(raw);
}

async function findScopeWithSelector(
  page: Page,
  selector: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await page.locator(selector).count().catch(() => 0)) > 0) {
      return page;
    }

    for (const frame of page.frames()) {
      if ((await frame.locator(selector).count().catch(() => 0)) > 0) {
        return frame;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`Timed out waiting for selector ${selector}.`);
}

async function clickFirstLinkByText(
  page: Page,
  text: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const link = scope.locator("a").filter({ hasText: text }).first();
      if ((await link.count().catch(() => 0)) > 0) {
        const href = await link.getAttribute("href");
        if (href && href !== "#" && !href.startsWith("javascript:")) {
          await scope.goto(new URL(href, BANK_ENTRY_URL).toString(), {
            waitUntil: "domcontentloaded",
          });
        } else {
          await link.click({ force: true });
        }
        return;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`Could not find link with text "${text}".`);
}

async function openMyDepositsPage(page: Page): Promise<BrowserScope> {
  const existing = await findScopeWithSelector(
    page,
    "a.input_sel.fastFunctionLinks",
    15_000,
  ).catch(() => null);
  if (existing) return existing;

  await clickFirstLinkByText(page, "我的存款");
  return await findScopeWithSelector(page, "a.input_sel.fastFunctionLinks");
}

async function openTransactionDetailForAccountIndex(
  page: Page,
  accountIndex: number,
): Promise<string> {
  const scope = await openMyDepositsPage(page);

  const rowCount = await countDepositRows(scope);
  if (accountIndex >= rowCount) {
    throw new Error(
      `Deposit account index ${accountIndex} is out of range; only ${rowCount} account rows are visible.`,
    );
  }

  const accountRow = depositRows(scope).nth(accountIndex);
  const maskedAccount = await readMaskedAccountLabel(accountRow);
  const fastFunctionLink = accountRow.locator("a.input_sel.fastFunctionLinks");
  if ((await fastFunctionLink.count()) > 0) {
    await fastFunctionLink.click({ force: true }).catch(() => undefined);
  }

  const transactionDetails = accountRow
    .locator("a.btn_sel")
    .filter({ hasText: "交易明細查詢" });
  await transactionDetails.waitFor({ state: "attached", timeout: 30_000 });
  await transactionDetails.dispatchEvent("click");

  return maskedAccount;
}

async function queryStatements(
  page: Page,
  dateRange: z.infer<typeof fubonStatementDateRangeSchema>,
) {
  const scope = await findScopeWithSelector(
    page,
    'a[id="form1:doValidateAndSubmit"]',
  );
  const dateRangeId = `input[id="form1:rdoDay${dateRange}"]`;
  await scope.locator(dateRangeId).check({ force: true });
  await scope.locator('a[id="form1:doValidateAndSubmit"]').click();
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    // The bank keeps background frames alive; a short settle wait below is enough.
  });
  await page.waitForTimeout(1_000);
  await findScopeWithSelector(page, "#multipleDownload");
}

async function downloadStatements(
  page: Page,
  downloadFormat: "TXT" | "EXCEL" | "PDF",
) {
  const scope = await findScopeWithSelector(page, "#multipleDownload");
  await scope.locator("#multipleDownload").click();
  await scope
    .locator(`input[name="download_format"][value="${downloadFormat}"]`)
    .check({ force: true });

  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await scope.locator("a.confirm").click();
  const download = await downloadPromise;

  const downloadsDir = join(process.cwd(), "downloads", "fubon-statements");
  await mkdir(downloadsDir, { recursive: true });

  const filename = download.suggestedFilename();
  const path = join(downloadsDir, `${Date.now()}-${safeFilename(filename)}`);
  await download.saveAs(path);

  const fileStat = await stat(path);
  const converted =
    downloadFormat === "EXCEL" ? await convertXlsToCsv(path) : undefined;
  return { filename, path, bytes: fileStat.size, ...converted };
}

export async function signInFubon(
  page: Page,
  session: string,
  credentials: FubonCredentials,
): Promise<void> {
  await fillLoginForm(page, credentials);

  console.log(
    "manual-auth-required: enter the CAPTCHA in the browser, then run `npx libretto resume --session " +
      session +
      "`.",
  );
  await pause(session);

  const loginFrame = await waitForFrame(page, "txnFrame");
  await loginFrame.locator("#btnLogin2").click();

  if (
    await loginFrame
      .locator("#m1_inputOTP")
      .isVisible()
      .catch(() => false)
  ) {
    console.log(
      "manual-otp-required: complete OTP in the browser, then run `npx libretto resume --session " +
        session +
        "`.",
    );
    await pause(session);
  }

  await waitForSignedInState(page);
}

export async function runFubonStatements(
  page: Page,
  input: FubonStatementsInput,
): Promise<FubonStatementsOutput> {
  const depositScope = await openMyDepositsPage(page);
  const accountCount = await countDepositRows(depositScope);
  const downloads: FubonStatementsOutput["downloads"] = [];

  for (let accountIndex = 0; accountIndex < accountCount; accountIndex += 1) {
    for (const dateRange of input.dateRanges) {
      const account = await openTransactionDetailForAccountIndex(
        page,
        accountIndex,
      );
      await queryStatements(page, dateRange);
      const download = await downloadStatements(page, input.downloadFormat);
      downloads.push({
        account,
        dateRange,
        ...download,
      });
    }
  }

  return {
    dateRanges: input.dateRanges,
    downloadFormat: input.downloadFormat,
    count: downloads.length,
    downloads,
  };
}

export default workflow("fubonStatements", {
  credentials: ["fubon_user_id", "fubon_account", "fubon_password"],
  input: fubonStatementsInputSchema,
  output: fubonStatementsOutputSchema,
  handler: async (ctx: LibrettoWorkflowContext, rawInput) => {
    const input = rawInput as Input;
    const { page, session } = ctx;

    page.on("dialog", async (dialog) => {
      console.warn("bank-dialog", { type: dialog.type() });
      await dialog.accept();
    });

    await signInFubon(page, session, input.credentials);
    return await runFubonStatements(page, input);
  },
});
