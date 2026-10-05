import type { PersonalCategoryCode } from "./personal-category-codes.ts";
import type { EInvoiceItemCategoryEvidenceKind } from "./transaction-taxonomy.ts";

/**
 * First Derived Personal Category producer for e-invoice items (ADR 0038).
 *
 * The item name decides first, then the seller tax ID, then the seller name.
 * Within one table the first matching rule wins, so the tables are ordered
 * from the most specific vocabulary to the broadest. A rule that does not
 * match emits nothing; there is no fallback code.
 */

export type EInvoiceItemCategoryInput = Readonly<{
  itemName: string | null;
  sellerTaxId: string;
  sellerName: string | null;
}>;

export type EInvoiceItemCategoryDerivation = Readonly<{
  code: PersonalCategoryCode;
  evidenceKind: EInvoiceItemCategoryEvidenceKind;
  matchedRule: string;
}>;

export type EInvoiceItemKeywordRule = Readonly<{
  code: PersonalCategoryCode;
  keywords: readonly string[];
}>;

export type EInvoiceItemCategoryRuleSet = Readonly<{
  itemName: readonly EInvoiceItemKeywordRule[];
  sellerTaxId: Readonly<Record<string, PersonalCategoryCode>>;
  sellerName: readonly EInvoiceItemKeywordRule[];
}>;

const ITEM_NAME_RULES: readonly EInvoiceItemKeywordRule[] = [
  { code: "healthcare", keywords: ["藥品", "維他命", "保健", "口罩", "酒精", "繃帶", "OK繃", "體溫計", "掛號費", "看診", "診療", "醫療", "藥"] },
  { code: "alcohol_and_tobacco", keywords: ["啤酒", "威士忌", "紅酒", "白酒", "清酒", "高粱", "燒酒", "香菸", "菸", "酒"] },
  { code: "transportation", keywords: ["汽油", "柴油", "停車", "租借費", "機油", "車資", "票價", "高鐵", "台鐵", "捷運", "悠遊卡", "過路費", "計程車", "uber"] },
  { code: "travel", keywords: ["飯店", "旅館", "住宿", "機票", "航空", "民宿", "行李", "旅行"] },
  { code: "housing_and_utilities", keywords: ["電費", "水費", "瓦斯費", "房租", "管理費"] },
  { code: "information_and_communication", keywords: ["電信", "通話費", "月租費", "網路費", "手機", "充電", "耳機", "傳輸線", "行動電源", "筆電", "電腦", "配件"] },
  { code: "education", keywords: ["學費", "補習", "課程", "教材", "參考書"] },
  { code: "gifts_and_donations", keywords: ["捐款", "香油錢"] },
  { code: "household_goods_and_services", keywords: ["衛生紙", "清潔", "洗衣", "垃圾袋", "洗碗", "廚房紙巾", "抹布", "電池", "燈泡", "家電", "寢具", "餐具", "鍋"] },
  { code: "personal_and_family_care", keywords: ["洗髮", "沐浴", "牙膏", "牙刷", "濕紙巾", "衛生棉", "護唇", "乳液", "化妝", "保養", "面膜", "刮鬍", "尿布"] },
  { code: "clothing_and_footwear", keywords: ["衣服", "上衣", "褲", "鞋", "襪", "外套", "帽", "內衣", "服飾"] },
  { code: "recreation_sports_and_culture", keywords: ["月費", "入會費", "電影票", "門票", "書籍", "文具", "健身", "遊戲", "玩具", "樂器", "展覽", "演唱會", "書"] },
  { code: "dining", keywords: ["便當", "套餐", "定食", "拉麵", "牛肉麵", "咖啡", "拿鐵", "美式", "卡布", "奶茶", "珍珠", "三明治", "漢堡", "薯條", "炸雞", "披薩", "壽司", "可頌", "蛋糕", "甜點", "手搖", "飯", "麵", "餐", "湯", "茶"] },
  { code: "food_and_groceries", keywords: ["牛奶", "鮮奶", "水果", "蔬菜", "巧克力", "麵包", "吐司", "優格", "起司", "零食", "泡麵", "飲料", "礦泉水", "果汁", "蘋果", "香蕉", "豆腐", "麥片", "肉", "蛋", "雞", "豬", "魚", "餅", "醬", "米"] },
];

/**
 * No seller tax ID is registered yet: the table is the hook the ADR orders
 * before seller names, and a verified identifier belongs here, not in the
 * name table.
 */
const SELLER_TAX_ID_RULES: Readonly<Record<string, PersonalCategoryCode>> = Object.freeze({});

const SELLER_NAME_RULES: readonly EInvoiceItemKeywordRule[] = [
  { code: "personal_and_family_care", keywords: ["寶雅", "統一生活事業", "日藥本舖", "屈臣氏", "康是美"] },
  { code: "food_and_groceries", keywords: ["全聯", "全家便利", "統一超商", "好市多", "家福股份", "家樂福", "三商家購", "日商樂比亞", "冠樺生活", "美廉社", "大潤發", "愛買", "萊爾富", "來來超商"] },
  { code: "transportation", keywords: ["中油", "加油站", "停車場", "停車", "威摩科技", "車容坊", "辰淵企業", "新儀科技", "詮營股份", "台灣高鐵", "臺灣鐵路", "捷運", "悠遊卡", "台灣大車隊"] },
  { code: "housing_and_utilities", keywords: ["台灣電力", "自來水", "天然氣", "瓦斯"] },
  { code: "information_and_communication", keywords: ["中華電信", "台灣大哥大", "遠傳", "台灣之星", "亞太電信", "蘋果亞洲"] },
  { code: "healthcare", keywords: ["藥局", "生物科技", "健康事業", "診所", "醫院"] },
  { code: "recreation_sports_and_culture", keywords: ["柏文健康", "威秀影城", "故宮", "策動文化", "展拓管理", "誠品", "博客來", "國賓影城", "秀泰", "文物藝術"] },
  { code: "household_goods_and_services", keywords: ["燦坤", "特力屋", "宜得利", "全國電子"] },
  { code: "dining", keywords: ["餐飲", "晨食", "牛排", "小吃", "海鮮", "咖啡", "茶店", "優食", "悠旅生活", "和德昌", "安心食品", "富利餐飲", "四海遊龍", "好味是", "穩穩", "流浪者", "慧澄國際", "奇奧國際食品", "瑞立昊", "固德富得", "聖塔蘿莎", "躺著喝", "瀚傑股份", "金登龍", "宏帆商號", "藶峰", "曼巴企業", "鳩極餐飲", "南園綠茶", "太古食品", "麥當勞", "肯德基", "摩斯", "鼎泰豐", "星巴克", "路易莎", "八方雲集", "麥味登"] },
];

export const EINVOICE_ITEM_CATEGORY_RULES_V1: EInvoiceItemCategoryRuleSet = Object.freeze({
  itemName: ITEM_NAME_RULES,
  sellerTaxId: SELLER_TAX_ID_RULES,
  sellerName: SELLER_NAME_RULES,
});

function firstKeywordMatch(
  text: string | null,
  rules: readonly EInvoiceItemKeywordRule[],
): Readonly<{ code: PersonalCategoryCode; matchedRule: string }> | null {
  if (text === null) return null;
  const normalized = text.toLowerCase();
  if (normalized.trim() === "") return null;
  for (const rule of rules) {
    const keyword = rule.keywords.find((candidate) => normalized.includes(candidate.toLowerCase()));
    if (keyword !== undefined) return { code: rule.code, matchedRule: keyword };
  }
  return null;
}

export function deriveEInvoiceItemCategory(
  input: EInvoiceItemCategoryInput,
  rules: EInvoiceItemCategoryRuleSet = EINVOICE_ITEM_CATEGORY_RULES_V1,
): EInvoiceItemCategoryDerivation | null {
  const byName = firstKeywordMatch(input.itemName, rules.itemName);
  if (byName) return { ...byName, evidenceKind: "item-name" };
  const taxId = input.sellerTaxId.trim();
  const byTaxId = rules.sellerTaxId[taxId];
  if (byTaxId !== undefined) return { code: byTaxId, evidenceKind: "seller-tax-id", matchedRule: taxId };
  const bySeller = firstKeywordMatch(input.sellerName, rules.sellerName);
  if (bySeller) return { ...bySeller, evidenceKind: "seller-name" };
  return null;
}
