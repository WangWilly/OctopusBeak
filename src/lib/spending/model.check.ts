import assert from "node:assert/strict";
import { buildSpendingModel, type SpendingInvoiceDto } from "./model.ts";

const invoices: SpendingInvoiceDto[] = [
  {
    invoiceKey: "jan",
    invoiceId: "JAN00001",
    issuedAt: Date.parse("2026-01-15T04:00:00Z") / 1000,
    amount: 25,
    sellerBusinessAccountNumber: null,
    sellerName: "January seller",
    sellerAddr: null,
    items: [{
      itemKey: "jan-1",
      sequence: 1,
      quantity: 1,
      unitPrice: 25,
      paidAmount: 25,
      productName: "January item",
      category: "transport",
    }],
  },
  {
    invoiceKey: "feb-boundary",
    invoiceId: "FEB00001",
    issuedAt: Date.parse("2026-01-31T16:30:00Z") / 1000,
    amount: 100,
    sellerBusinessAccountNumber: "12345678",
    sellerName: "Boundary seller",
    sellerAddr: "Taipei",
    items: [
      {
        itemKey: "feb-food-1",
        sequence: 1,
        quantity: 1,
        unitPrice: 80,
        paidAmount: 80,
        productName: "Meal",
        category: "food",
      },
      {
        itemKey: "feb-food-2",
        sequence: 2,
        quantity: 1,
        unitPrice: -20,
        paidAmount: -20,
        productName: "Refund",
        category: "food",
      },
      {
        itemKey: "feb-daily-1",
        sequence: 3,
        quantity: 1,
        unitPrice: 30,
        paidAmount: 30,
        productName: "Soap",
        category: "daily",
      },
    ],
  },
  {
    invoiceKey: "feb-empty",
    invoiceId: "FEB00002",
    issuedAt: Date.parse("2026-02-02T02:00:00Z") / 1000,
    amount: 50,
    sellerBusinessAccountNumber: null,
    sellerName: "No items",
    sellerAddr: null,
    items: [],
  },
  {
    invoiceKey: "feb-shopping",
    invoiceId: "FEB00003",
    issuedAt: Date.parse("2026-02-02T03:00:00Z") / 1000,
    amount: 30,
    sellerBusinessAccountNumber: null,
    sellerName: "Shop",
    sellerAddr: null,
    items: [
      {
        itemKey: "feb-shopping-1",
        sequence: 1,
        quantity: 1,
        unitPrice: 10,
        paidAmount: 10,
        productName: "Book",
        category: "shopping",
      },
      {
        itemKey: "feb-shopping-2",
        sequence: 2,
        quantity: 1,
        unitPrice: 20,
        paidAmount: 20,
        productName: "Pen",
        category: "shopping",
      },
    ],
  },
  {
    invoiceKey: "mar",
    invoiceId: "MAR00001",
    issuedAt: Date.parse("2026-03-03T04:00:00Z") / 1000,
    amount: 40,
    sellerBusinessAccountNumber: null,
    sellerName: "March seller",
    sellerAddr: null,
    items: [{
      itemKey: "mar-1",
      sequence: 1,
      quantity: 1,
      unitPrice: 40,
      paidAmount: 40,
      productName: "Ticket",
      category: "leisure",
    }],
  },
];

const latest = buildSpendingModel(invoices);
assert.deepEqual(latest.months, ["2026-01", "2026-02", "2026-03"]);
assert.equal(latest.selectedMonth, "2026-03");

const february = buildSpendingModel(invoices, "2026-02");
assert.deepEqual(february.monthlyRows.map((row) => row.month), [
  "2026-01",
  "2026-02",
  "2026-03",
]);
assert.deepEqual(
  february.monthlyRows.find((row) => row.month === "2026-02"),
  {
    month: "2026-02",
    total: 180,
    food: 70,
    daily: 30,
    transport: 0,
    shopping: 30,
    home: 0,
    leisure: 0,
    other: 50,
  },
);
assert.deepEqual(february.selectedMonthSummary, { total: 180, invoiceCount: 3 });
assert.deepEqual(february.dailyRows, [
  {
    date: "2026-02-01",
    total: 100,
    food: 70,
    daily: 30,
    transport: 0,
    shopping: 0,
    home: 0,
    leisure: 0,
    other: 0,
  },
  {
    date: "2026-02-02",
    total: 80,
    food: 0,
    daily: 0,
    transport: 0,
    shopping: 30,
    home: 0,
    leisure: 0,
    other: 50,
  },
]);
assert.deepEqual(february.presentCategories, ["food", "daily", "shopping", "other"]);
assert.deepEqual(february.invoices.map((invoice) => invoice.invoiceKey), [
  "feb-boundary",
  "feb-empty",
  "feb-shopping",
]);

const food = buildSpendingModel(invoices, "2026-02", "food");
assert.deepEqual(food.invoices.map((invoice) => invoice.invoiceKey), ["feb-boundary"]);
assert.equal(JSON.parse(JSON.stringify({ invoices })).invoices.length, invoices.length);
