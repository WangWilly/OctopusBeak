import assert from "node:assert/strict";
import type { Page } from "playwright";
import { closeInvoiceDetailModal } from "./einvoice-personal-invoices.ts";

const actions: string[] = [];
let modalVisible = true;
let closeClicks = 0;
const closeButton = {
  async click() {
    actions.push("click-close");
    closeClicks += 1;
    if (closeClicks === 2) modalVisible = false;
  },
};
const modal = {
  first() {
    return this;
  },
  async isVisible() {
    actions.push("modal-visible");
    return modalVisible;
  },
  getByRole(role: string, options: { name: string }) {
    assert.equal(role, "button");
    assert.equal(options.name, "關閉視窗");
    return closeButton;
  },
  async waitFor(options: { state: string }) {
    actions.push(`wait-modal-${options.state}`);
    if (modalVisible) throw new Error("Modal is still visible");
  },
};
const backdrop = {
  first() {
    return this;
  },
  async waitFor(options: { state: string }) {
    actions.push(`wait-backdrop-${options.state}`);
  },
};
const page = {
  locator(selector: string) {
    if (selector === ".modal_barcode_detail.show") return modal;
    if (selector === ".simple-modal-backdrop") return backdrop;
    throw new Error(`Unexpected selector: ${selector}`);
  },
};

await closeInvoiceDetailModal(page as unknown as Page);

assert.deepEqual(actions, [
  "modal-visible",
  "click-close",
  "wait-modal-hidden",
  "modal-visible",
  "click-close",
  "wait-modal-hidden",
  "wait-backdrop-hidden",
]);

actions.length = 0;
modalVisible = false;
await closeInvoiceDetailModal(page as unknown as Page);
assert.deepEqual(actions, [
  "modal-visible",
  "wait-backdrop-hidden",
]);
