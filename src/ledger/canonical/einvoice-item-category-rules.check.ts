import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveEInvoiceItemCategory,
  EINVOICE_ITEM_CATEGORY_RULES_V1,
  type EInvoiceItemCategoryRuleSet,
} from "./einvoice-item-category-rules.ts";
import { isPersonalCategoryCode } from "./personal-category-codes.ts";
import { producerAllowsOutput } from "./transaction-taxonomy.ts";

const seller = { sellerTaxId: "00000000", sellerName: null };

test("the item name decides before the seller", () => {
  assert.deepEqual(
    deriveEInvoiceItemCategory({ itemName: "電影票", sellerTaxId: "12345678", sellerName: "台灣中油股份有限公司" }),
    { code: "recreation_sports_and_culture", evidenceKind: "item-name", matchedRule: "電影票" },
  );
  assert.deepEqual(
    deriveEInvoiceItemCategory({ itemName: "Unlabelled", sellerTaxId: "12345678", sellerName: "台灣中油股份有限公司" }),
    { code: "transportation", evidenceKind: "seller-name", matchedRule: "中油" },
  );
});

test("a registered seller tax ID decides before the seller name", () => {
  const rules: EInvoiceItemCategoryRuleSet = {
    ...EINVOICE_ITEM_CATEGORY_RULES_V1,
    sellerTaxId: { "12345678": "healthcare" },
  };
  assert.deepEqual(
    deriveEInvoiceItemCategory({ itemName: "Unlabelled", sellerTaxId: "12345678", sellerName: "台灣中油股份有限公司" }, rules),
    { code: "healthcare", evidenceKind: "seller-tax-id", matchedRule: "12345678" },
  );
  assert.equal(
    deriveEInvoiceItemCategory({ itemName: "Unlabelled", sellerTaxId: "87654321", sellerName: "台灣中油股份有限公司" }, rules)?.evidenceKind,
    "seller-name",
  );
});

test("no match emits nothing instead of a fallback code", () => {
  assert.equal(deriveEInvoiceItemCategory({ itemName: "Unknown", ...seller }), null);
  assert.equal(deriveEInvoiceItemCategory({ itemName: null, sellerTaxId: "12345678", sellerName: "網路家庭國際資訊" }), null);
  assert.equal(deriveEInvoiceItemCategory({ itemName: "", sellerTaxId: "12345678", sellerName: "   " }), null);
});

test("ported keyword rules land on canonical codes", () => {
  const cases: readonly [string, string][] = [
    ["咖啡", "dining"],
    ["衛生紙", "household_goods_and_services"],
    ["洗髮精", "personal_and_family_care"],
    ["汽油", "transportation"],
    ["書籍", "recreation_sports_and_culture"],
    ["電費", "housing_and_utilities"],
    ["電影票", "recreation_sports_and_culture"],
    ["維他命", "healthcare"],
    ["啤酒", "alcohol_and_tobacco"],
    ["酒精棉片", "healthcare"],
    ["洗衣精", "household_goods_and_services"],
    ["球鞋", "clothing_and_footwear"],
    ["鮮奶", "food_and_groceries"],
    ["飯店住宿", "travel"],
  ];
  for (const [itemName, code] of cases)
    assert.equal(deriveEInvoiceItemCategory({ itemName, ...seller })?.code, code, itemName);
});

test("every rule emits a registered code the producer is declared compatible with", () => {
  const rules = [...EINVOICE_ITEM_CATEGORY_RULES_V1.itemName, ...EINVOICE_ITEM_CATEGORY_RULES_V1.sellerName];
  for (const rule of rules) {
    assert.ok(isPersonalCategoryCode(rule.code), rule.code);
    assert.ok(rule.keywords.length > 0);
    for (const evidenceKind of ["item-name", "seller-tax-id", "seller-name"])
      assert.ok(producerAllowsOutput("einvoice/item-category-enrichment", "v1", "derived", "category", rule.code, evidenceKind), `${rule.code}:${evidenceKind}`);
  }
  for (const code of Object.values(EINVOICE_ITEM_CATEGORY_RULES_V1.sellerTaxId)) assert.ok(isPersonalCategoryCode(code));
});
