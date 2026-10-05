import assert from "node:assert/strict";
import test from "node:test";
import {
  SPENDING_CATEGORY_GROUP_BY_CODE,
  SPENDING_CATEGORY_GROUP_IDS,
  spendingCategoryCodesForGroup,
  spendingCategoryGroup,
} from "./category-groups.ts";
import { PERSONAL_CATEGORY_CODES } from "../../ledger/canonical/personal-category-codes.ts";
import { translations } from "../i18n/i18n.ts";

test("every published code maps to exactly one group and the groups partition the codes", () => {
  const seen = new Set<string>();
  for (const code of PERSONAL_CATEGORY_CODES) {
    const group = spendingCategoryGroup(code);
    assert.ok(SPENDING_CATEGORY_GROUP_IDS.includes(group), `${code} -> ${group}`);
    assert.ok(!seen.has(code));
    seen.add(code);
  }
  assert.deepEqual(Object.keys(SPENDING_CATEGORY_GROUP_BY_CODE).sort(), [...PERSONAL_CATEGORY_CODES].sort());
  const expanded = SPENDING_CATEGORY_GROUP_IDS.flatMap((group) => spendingCategoryCodesForGroup(group));
  assert.deepEqual([...expanded].sort(), [...PERSONAL_CATEGORY_CODES].sort());
});

test("the groups follow Spending v2 plan decision 1", () => {
  assert.deepEqual(spendingCategoryCodesForGroup("dining"), ["dining", "alcohol_and_tobacco"]);
  assert.deepEqual(spendingCategoryCodesForGroup("daily"), ["food_and_groceries", "healthcare", "personal_and_family_care"]);
  assert.deepEqual(spendingCategoryCodesForGroup("transport"), ["transportation"]);
  assert.deepEqual(spendingCategoryCodesForGroup("shopping"), ["clothing_and_footwear"]);
  assert.deepEqual(spendingCategoryCodesForGroup("home"), ["housing_and_utilities", "household_goods_and_services", "information_and_communication"]);
  assert.deepEqual(spendingCategoryCodesForGroup("leisure"), ["travel", "recreation_sports_and_culture"]);
  assert.deepEqual(spendingCategoryCodesForGroup("other"), ["education", "insurance", "taxes_and_government", "gifts_and_donations", "work_and_business"]);
});

test("every group and the Unclassified bucket have zh-TW and en labels", () => {
  for (const group of SPENDING_CATEGORY_GROUP_IDS) {
    assert.ok(translations["zh-TW"].spending.categoryGroups[group].length > 0, group);
    assert.ok(translations.en.spending.categoryGroups[group].length > 0, group);
  }
  assert.deepEqual(
    SPENDING_CATEGORY_GROUP_IDS.map((group) => translations["zh-TW"].spending.categoryGroups[group]),
    ["餐飲", "日常", "交通", "購物", "居家", "休閒", "其他"],
  );
  assert.equal(translations["zh-TW"].spending.unclassifiedCategory, "未分類");
  assert.equal(translations.en.spending.unclassifiedCategory, "Unclassified");
});
