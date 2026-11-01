import assert from "node:assert/strict";
import test from "node:test";
import { withPreviewStore } from "../../lib/preview-sources/preview-store-harness.ts";
import type { PreviewLoan, PreviewLoanCollection, PreviewVisibility, PreviewWrite } from "./preview-financial-data.ts";

const LOANS: PreviewVisibility = { visible: [{ sourceId: "synthetic-preview", product: "loan" }] };

const loan = (key: string, amount: string, at: string, patch: Partial<PreviewLoan> = {}): PreviewLoan => ({
  sourceAccountKey: key,
  displayLabel: `Loan ****${key.slice(-4)}`,
  currency: "TWD",
  category: "housing",
  outstandingBalance: { amount, observedAt: { at, source: "reported" } },
  originalAmount: "8000000",
  interestRate: "2.185",
  paymentAmount: "32150.00",
  nextPaymentDate: "2026-11-10",
  installmentsPaid: 60,
  installmentsTotal: 360,
  openedOn: "2021-09-01",
  maturityDate: "2051-09-01",
  ...patch,
});

const loanWrite = (
  collectedAt: string,
  loans: readonly PreviewLoan[],
  completeness: PreviewLoanCollection["completeness"] = "complete",
): PreviewWrite => ({
  sourceId: "synthetic-preview",
  institution: "bank-017",
  product: "loan",
  collection: { collectedAt, completeness, loans },
});

test("a loan snapshot keeps its terms exactly, and the newest balance wins while history keeps every one", async () => {
  await withPreviewStore(async (preview) => {
    assert.deepEqual(
      await preview.write(loanWrite("2026-10-15T01:00:00.000Z", [loan("001234567", "6000000.50", "2026-10-15T01:00:00.000Z")])),
      { accounts: 1, balances: 1, transactions: 0, statements: 0, closedAccounts: 0 },
    );
    await preview.write(loanWrite("2026-10-16T01:00:00.000Z", [loan("001234567", "5990000", "2026-10-16T01:00:00.000Z", {
      paymentAmount: null, nextPaymentDate: "2026-12-10", installmentsPaid: 61,
    })]));
    const [account] = await preview.loanAccounts(LOANS);
    assert.equal(account!.displayLabel, "Loan ****5678");
    assert.deepEqual(account!.latestBalance, {
      amount: "5990000", currency: "TWD", observedAt: { at: "2026-10-16T01:00:00.000Z", source: "reported" },
    });
    assert.deepEqual(account!.loan, {
      category: "housing", originalAmount: "8000000", interestRate: "2.185", paymentAmount: null,
      nextPaymentDate: "2026-12-10", installmentsPaid: 61, installmentsTotal: 360, openedOn: "2021-09-01",
      maturityDate: "2051-09-01", closedAt: null,
    }, "the latest snapshot replaces every term, including one it no longer reports");
  });
});

test("a complete loan list closes the loans it lacks and reopens one that returns", async () => {
  await withPreviewStore(async (preview) => {
    await preview.write(loanWrite("2026-10-15T01:00:00.000Z", [
      loan("loan-1111", "100000", "2026-10-15T01:00:00.000Z"),
      loan("loan-2222", "5000", "2026-10-15T01:00:00.000Z"),
    ]));
    const second = await preview.write(loanWrite("2026-10-16T01:00:00.000Z", [loan("loan-1111", "99000", "2026-10-16T01:00:00.000Z")]));
    assert.equal(second.closedAccounts, 1);
    assert.deepEqual((await preview.loanAccounts(LOANS)).map((account) => [account.displayLabel, account.loan.closedAt]), [
      ["Loan ****1111", null],
      ["Loan ****2222", "2026-10-16T01:00:00.000Z"],
    ]);
    await preview.write(loanWrite("2026-10-17T01:00:00.000Z", [
      loan("loan-1111", "98000", "2026-10-17T01:00:00.000Z"),
      loan("loan-2222", "4000", "2026-10-17T01:00:00.000Z"),
    ]));
    assert.deepEqual((await preview.loanAccounts(LOANS)).map((account) => account.loan.closedAt), [null, null]);
    assert.equal((await preview.write(loanWrite("2026-10-18T01:00:00.000Z", []))).closedAccounts, 2,
      "a complete empty list closes every loan");
  });
});

test("an unproven loan list writes what it holds, closes nothing, and keeps the last snapshot of a missing loan", async () => {
  await withPreviewStore(async (preview) => {
    await preview.write(loanWrite("2026-10-15T01:00:00.000Z", [
      loan("loan-1111", "100000", "2026-10-15T01:00:00.000Z"),
      loan("loan-2222", "5000", "2026-10-15T01:00:00.000Z"),
    ]));
    const receipt = await preview.write(loanWrite("2026-10-16T01:00:00.000Z", [
      loan("loan-1111", "99000", "2026-10-16T01:00:00.000Z"),
    ], "unproven"));
    assert.equal(receipt.closedAccounts, 0);
    assert.equal((await preview.write(loanWrite("2026-10-17T01:00:00.000Z", [], "unproven"))).closedAccounts, 0);
    assert.deepEqual((await preview.loanAccounts(LOANS)).map((account) =>
      [account.displayLabel, account.latestBalance.amount, account.lastCollectedAt, account.loan.closedAt]), [
      ["Loan ****1111", "99000", "2026-10-16T01:00:00.000Z", null],
      ["Loan ****2222", "5000", "2026-10-15T01:00:00.000Z", null],
    ]);
  });
});

test("a loan list is refused whole at the boundary and leaves nothing behind", async () => {
  await withPreviewStore(async (preview) => {
    const at = "2026-10-15T01:00:00.000Z";
    const base = loan("loan-1111", "100000", at);
    const { currency: _currency, ...withoutCurrency } = base;
    for (const [rejected, reason] of [
      [withoutCurrency, "no currency"],
      [{ ...base, outstandingBalance: { amount: 100000, observedAt: base.outstandingBalance.observedAt } }, "a numeric balance"],
      [{ ...base, outstandingBalance: null }, "no balance"],
      [{ ...base, originalAmount: "8e6" }, "an inexact original amount"],
      [{ ...base, interestRate: undefined }, "an absent term not given as null"],
      [{ ...base, nextPaymentDate: "2026/11/10" }, "a payment date that is not a local date"],
      [{ ...base, maturityDate: "2051-09-01T00:00" }, "a maturity with a time"],
      [{ ...base, installmentsPaid: -1 }, "negative installments"],
      [{ ...base, installmentsTotal: 360.5 }, "fractional installments"],
      [{ ...base, installmentsPaid: "60" }, "installments as text"],
      [{ ...base, installmentsPaid: 361 }, "more installments paid than in total"],
      [{ ...base, category: "mortgage" }, "a category the model does not name"],
      [{ ...base, displayLabel: "Loan 001234567" }, "a label that shows the account number"],
    ] as const) {
      await assert.rejects(preview.write(loanWrite(at, [rejected as unknown as PreviewLoan])), reason);
    }
    await assert.rejects(preview.write(loanWrite(at, [base, base])), "a duplicated loan");
    await assert.rejects(preview.write(loanWrite(at, [base], "partial" as "complete")), "an unknown completeness");
    assert.deepEqual(await preview.loanAccounts(LOANS), []);

    await preview.write(loanWrite(at, [{ ...base, installmentsPaid: 0, installmentsTotal: null, category: null }]));
    assert.deepEqual((await preview.loanAccounts(LOANS)).map((account) => [account.loan.installmentsPaid, account.loan.category]), [[0, null]]);
  });
});

test("loans read only while their source and product are visible, and delete-all removes them", async () => {
  await withPreviewStore(async (preview) => {
    await preview.write(loanWrite("2026-10-15T01:00:00.000Z", [loan("loan-1111", "100000", "2026-10-15T01:00:00.000Z")]));
    assert.deepEqual(await preview.loanAccounts({ visible: [] }), [], "Preview features off");
    assert.deepEqual(await preview.loanAccounts({ visible: [{ sourceId: "synthetic-preview", product: "deposit" }] }), [],
      "visibility is per product");
    assert.deepEqual(await preview.accounts({ visible: [{ sourceId: "synthetic-preview", product: "deposit" }] }), [],
      "a loan never reads as a deposit account");
    await preview.deleteAll();
    assert.deepEqual(await preview.loanAccounts(LOANS), []);
  });
});
