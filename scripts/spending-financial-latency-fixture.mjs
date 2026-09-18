import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { initializeCanonicalRuntime } from "../electron/canonical-reset.ts";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  commitCathayDomesticDeposit,
  createCanonicalSourceStore,
} from "../src/ledger/canonical/canonical-source-store.ts";
import {
  E_INVOICE_CONTRACT_VERSION,
  E_INVOICE_CURRENCY_AUTHORITY,
  E_INVOICE_ROUTE,
  commitCanonicalEInvoiceCapture,
} from "../src/ledger/canonical/einvoice.ts";

export const FIXTURE_MODE = "spending-financial-latency-cdp";
export const FIXTURE_SCALES = Object.freeze(["1x", "2x"]);
export const FIXTURE_BASE_CARDINALITIES = Object.freeze({
  invoices: 4_096,
  transactions: 4_096,
  candidates: 4_096,
});
export const FIXTURE_STRESS_MULTIPLIER = 2;

const SQLITE_FILES = Object.freeze(["canonical.sqlite", "canonical.sqlite-wal", "canonical.sqlite-shm", "canonical.sqlite-journal"]);

function assertScale(value) {
  if (!FIXTURE_SCALES.includes(value)) throw new Error(`Unsupported spending fixture scale: ${value}`);
  return value;
}

function assertDisposableFixtureRoot(userData) {
  const root = resolve(userData);
  const temporaryRoot = resolve(tmpdir());
  if (root !== temporaryRoot && !root.startsWith(`${temporaryRoot}${sep}`) && !root.startsWith(`/tmp${sep}`)) {
    throw new Error(`Spending latency fixture user-data must be inside a temporary directory: ${root}`);
  }
  return root;
}

async function assertSeededDesktopFixture(root) {
  const markerPath = join(root, ".libretto", "canonical-reset.json");
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    throw new Error(`Spending latency fixture requires a completed desktop CDP fixture: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (marker?.status !== "completed" || resolve(marker.userData) !== root) {
    throw new Error("Spending latency fixture requires a completed disposable canonical reset.");
  }
}

function hashToken(seed, kind, index) {
  return `sha256:${createHash("sha256").update(`${seed}/${kind}/${index}`).digest("base64url")}`;
}

function hashId(seed, kind, index) {
  return Buffer.from(createHash("sha256").update(`${seed}/${kind}/${index}`).digest().subarray(0, 16));
}

function uuidFromBuffer(value) {
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cardinalities(scale, baseCardinalities = FIXTURE_BASE_CARDINALITIES) {
  const multiplier = scale === "2x" ? FIXTURE_STRESS_MULTIPLIER : 1;
  return Object.freeze({
    invoices: baseCardinalities.invoices * multiplier,
    transactions: baseCardinalities.transactions * multiplier,
    candidates: baseCardinalities.candidates * multiplier,
  });
}

function invoiceFor(seed, index) {
  const serial = String(index + 1).padStart(8, "0");
  return {
    stableInvoiceKey: `synthetic-invoice-${serial}`,
    sourceRevisionKey: `synthetic-invoice-${serial}-revision-1`,
    revisionNumber: 1,
    revisionKind: "issued",
    sourceIdentifiers: { invoiceNumber: `AB${serial}` },
    seller: { taxId: "12345678", name: "Synthetic Seller" },
    total: { coefficient: String(1000 + (index % 37)), scale: 0, currency: "TWD", currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY },
    occurrence: { value: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`, precision: "date", timeZone: "Asia/Taipei", origin: "source-reported" },
    items: [],
    authority: { routeKey: E_INVOICE_ROUTE, contractVersion: E_INVOICE_CONTRACT_VERSION },
    provenance: { kind: "fixture", reference: `synthetic/spending-latency/invoice/${index}` },
  };
}

async function seedScale(root, scale, seed, baseCardinalities) {
  const plan = cardinalities(scale, baseCardinalities);
  const ledgerDir = join(root, "data", "ledger");
  initializeCanonicalRuntime({ userData: root });
  const details = Array.from({ length: plan.transactions }, (_, index) => ({
    sequenceNumber: index + 1,
    txnDateTime: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00`,
    accountDate: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
    description: `Synthetic payment ${index}`,
    expendAmt: 1000 + (index % 37),
    incomeAmt: null,
    balance: 1000000 - index * 1000,
  }));
  const rawResponse = JSON.stringify({
    success: true,
    returnCode: "0000",
    content: { datas: [{
      queryStatus: "Success",
      accountNumber: "SYNTHETIC-ACCOUNT-001",
      count: details.length,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      details,
    }] },
  });
  await commitCathayDomesticDeposit(ledgerDir, {
    ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    rawResponse,
    scope: { startDate: "2026-01-01", endDate: "2026-12-31" },
    observedAt: "2026-09-18T00:00:00+08:00",
  });
  const store = createCanonicalSourceStore(ledgerDir, { commitClock: () => 1_800_000_000_000_000 });
  try {
    const invoices = Array.from({ length: plan.invoices }, (_, index) => invoiceFor(seed, index));
    await commitCanonicalEInvoiceCapture(store, {
      captureId: `synthetic-spending-latency-${scale}`,
      sourceConnectionKey: hashToken(seed, "connection", 0),
      identityEpoch: hashToken(seed, "epoch", 0),
      subjectDigest: hashToken(seed, "subject", 0),
      observedAt: "2026-09-18T00:00:00Z",
      scope: {
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        kind: "bounded-range",
        completeness: "complete-range",
        invoiceCompleteness: "complete",
        itemCompleteness: "complete",
        absenceAuthority: "comparable-complete-range",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: invoices.length, terminal: true, metadata: { synthetic: true, cardinality: invoices.length } }],
      invoices,
    });
    const db = store.db;
    const candidateCommit = db.prepare("SELECT commit_id FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1").get();
    const invoiceRows = db.prepare("SELECT invoice_id FROM einvoice_invoices ORDER BY rowid").all();
    const transactionRows = db.prepare("SELECT transaction_id FROM financial_transactions ORDER BY rowid").all();
    if (invoiceRows.length !== plan.invoices || transactionRows.length !== plan.transactions) {
      throw new Error(`Spending latency fixture cardinality admission failed: invoices=${invoiceRows.length}/${plan.invoices}, transactions=${transactionRows.length}/${plan.transactions}.`);
    }
    const insertCandidate = db.prepare("INSERT INTO spending_match_candidates(candidate_id, candidate_key, invoice_id, transaction_id, algorithm, algorithm_version, similarity_evidence_json, created_commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (let index = 0; index < plan.candidates; index += 1) {
      insertCandidate.run(
        hashId(seed, "candidate", index),
        `synthetic-candidate-${String(index).padStart(8, "0")}`,
        Buffer.from(invoiceRows[index].invoice_id),
        Buffer.from(uuidFromBuffer(transactionRows[index].transaction_id).replaceAll("-", ""), "hex"),
        "synthetic-exact-amount-date",
        "v1",
        JSON.stringify({ exactAmountAndCurrency: true, calendarDayDistance: 0 }),
        Buffer.from(candidateCommit.commit_id),
      );
    }
    const latest = Number(db.prepare("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits").get().value);
    return Object.freeze({ scale, multiplier: scale === "2x" ? 2 : 1, cardinalities: plan, knowledgePoint: latest });
  } finally {
    store.close();
  }
}

async function removeSqliteSidecars(ledgerDir) {
  for (const file of SQLITE_FILES.slice(1)) await rm(join(ledgerDir, file), { force: true });
}

async function snapshotSqliteFiles(sourceDirectory, destinationDirectory) {
  for (const file of SQLITE_FILES) {
    const source = join(sourceDirectory, file);
    const destination = join(destinationDirectory, file);
    if (existsSync(source)) await copyFile(source, destination);
    else await rm(destination, { force: true });
  }
}

async function restoreSqliteFiles(sourceDirectory, destinationDirectory) {
  await removeSqliteSidecars(destinationDirectory);
  for (const file of SQLITE_FILES) {
    const source = join(sourceDirectory, file);
    if (existsSync(source)) await copyFile(source, join(destinationDirectory, file));
  }
}

/**
 * Fixture-only control plane. It is intentionally a script-side module rather
 * than a renderer or production API. The root check and completed reset
 * marker make it impossible to point this controller at a normal user store.
 */
export async function createSpendingLatencyFixtureController({ userData, seed = "octopusbeak-spending-latency-v1", baseCardinalities = FIXTURE_BASE_CARDINALITIES }) {
  const root = assertDisposableFixtureRoot(userData);
  await assertSeededDesktopFixture(root);
  if (!baseCardinalities || Object.keys(baseCardinalities).some((key) => !["invoices", "transactions", "candidates"].includes(key)) || Object.values(baseCardinalities).some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error("Spending latency fixture base cardinalities are invalid.");
  }
  const ledgerDir = join(root, "data", "ledger");
  const databasePath = join(ledgerDir, "canonical.sqlite");
  const pristineDirectory = await mkdtemp(join(tmpdir(), "octopusbeak-spending-latency-pristine-"));
  const baselineDirectory = await mkdtemp(join(tmpdir(), "octopusbeak-spending-latency-baseline-"));
  await snapshotSqliteFiles(ledgerDir, pristineDirectory);
  let activeScale = null;
  let activeDataset = null;
  let closed = false;

  async function ensureOpen() {
    if (closed) throw new Error("Spending latency fixture controller is closed.");
  }

  async function setScale(scale) {
    await ensureOpen();
    assertScale(scale);
    await restoreSqliteFiles(pristineDirectory, ledgerDir);
    const result = await seedScale(root, scale, seed, baseCardinalities);
    await snapshotSqliteFiles(ledgerDir, baselineDirectory);
    activeScale = scale;
    activeDataset = result;
    return Object.freeze({ mode: FIXTURE_MODE, ready: true, ...result });
  }

  async function resetScenario(scale = activeScale) {
    await ensureOpen();
    assertScale(scale);
    if (scale !== activeScale || !activeDataset) throw new Error("Spending latency fixture scale is not prepared.");
    await restoreSqliteFiles(baselineDirectory, ledgerDir);
    return Object.freeze({ mode: FIXTURE_MODE, ready: true, scale, cardinalities: activeDataset.cardinalities });
  }

  async function latestKnowledgePoint() {
    await ensureOpen();
    const store = createCanonicalSourceStore(ledgerDir);
    try {
      return Number(store.db.prepare("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits").get().value);
    } finally {
      store.close();
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    await Promise.all([
      rm(pristineDirectory, { recursive: true, force: true }),
      rm(baselineDirectory, { recursive: true, force: true }),
    ]);
  }

  return Object.freeze({
    mode: FIXTURE_MODE,
    databasePath,
    setScale,
    resetScenario,
    latestKnowledgePoint,
    close,
  });
}
