import assert from "node:assert/strict";
import {
  classifyPersonalInvoiceItem,
  isSpendingCategory,
} from "./categories.ts";

assert.equal(classifyPersonalInvoiceItem({
  productName: "咖啡",
  sellerName: "Unknown store",
  sellerAddr: "Taipei",
}), "food");

assert.equal(classifyPersonalInvoiceItem({
  productName: "衛生紙",
  sellerName: "Unknown store",
  sellerAddr: "Taipei",
}), "daily");

assert.equal(classifyPersonalInvoiceItem({
  productName: "汽油",
  sellerName: "Unknown store",
  sellerAddr: "Taipei",
}), "transport");

assert.equal(classifyPersonalInvoiceItem({
  productName: "書籍",
  sellerName: "Unknown store",
  sellerAddr: "Taipei",
}), "shopping");

assert.equal(classifyPersonalInvoiceItem({
  productName: "電費",
  sellerName: "Unknown store",
  sellerAddr: "Taipei",
}), "home");

assert.equal(classifyPersonalInvoiceItem({
  productName: "電影票",
  sellerName: "Unknown store",
  sellerAddr: "Taipei",
}), "leisure");

assert.equal(classifyPersonalInvoiceItem({
  productName: "Unlabelled item",
  sellerName: "台灣中油股份有限公司",
  sellerAddr: "新北市",
}), "transport");

assert.equal(classifyPersonalInvoiceItem({
  productName: "電影票",
  sellerName: "台灣中油股份有限公司",
  sellerAddr: "新北市",
}), "leisure");

assert.equal(classifyPersonalInvoiceItem({
  productName: "Unknown",
  sellerName: "Unknown",
  sellerAddr: "Unknown",
}), "other");

assert.equal(isSpendingCategory("shopping"), true);
assert.equal(isSpendingCategory("invalid"), false);
