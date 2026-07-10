export const SPENDING_CATEGORY_IDS = [
  "food",
  "daily",
  "transport",
  "shopping",
  "home",
  "leisure",
  "other",
] as const;

export type SpendingCategory = (typeof SPENDING_CATEGORY_IDS)[number];

const spendingCategorySet = new Set<string>(SPENDING_CATEGORY_IDS);

export function isSpendingCategory(value: unknown): value is SpendingCategory {
  return typeof value === "string" && spendingCategorySet.has(value);
}

type CategoryRule = {
  id: SpendingCategory;
  keywords: readonly string[];
};

const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    id: "daily",
    keywords: ["全聯", "全家便利", "統一超商", "好市多", "家福股份", "寶雅", "統一生活事業", "三商家購", "日商樂比亞", "冠樺生活", "日藥本舖"],
  },
  {
    id: "transport",
    keywords: ["中油", "加油站", "停車場", "停車", "威摩科技", "租借費", "機油", "車容坊", "辰淵企業", "新儀科技", "儲值點數", "詮營股份"],
  },
  { id: "home", keywords: ["台灣電力", "自來水", "電費", "水費"] },
  {
    id: "leisure",
    keywords: ["柏文健康", "威秀影城", "故宮", "策動文化", "藥局", "生物科技", "健康事業", "月費", "入會費", "展拓管理"],
  },
  {
    id: "shopping",
    keywords: ["網路家庭", "富邦媒體", "蝦皮", "燦坤", "蘋果亞洲", "誠品生活", "星裕國際", "商品－", "文物藝術"],
  },
  {
    id: "food",
    keywords: ["餐飲", "晨食", "牛排", "小吃", "海鮮", "咖啡", "茶店", "優食", "悠旅生活", "和德昌", "安心食品", "富利餐飲", "四海遊龍", "好味是", "穩穩", "流浪者", "慧澄國際", "奇奧國際食品", "瑞立昊", "固德富得", "聖塔蘿莎", "躺著喝", "瀚傑股份", "金登龍", "宏帆商號", "藶峰", "曼巴企業", "鳩極餐飲", "南園綠茶", "太古食品"],
  },
];

const ITEM_CATEGORY_RULES: readonly CategoryRule[] = [
  { id: "transport", keywords: ["汽油", "停車", "租借費", "機油", "車資", "票價"] },
  { id: "home", keywords: ["電費", "水費", "瓦斯費"] },
  { id: "leisure", keywords: ["月費", "入會費", "電影票", "門票", "藥品", "維他命", "保健"] },
  { id: "daily", keywords: ["衛生紙", "清潔", "洗衣", "洗髮", "牙膏", "牙刷", "垃圾袋", "口罩", "濕紙巾"] },
  { id: "shopping", keywords: ["書籍", "衣服", "鞋", "充電", "耳機", "配件", "家電", "文具"] },
  { id: "food", keywords: ["咖啡", "茶", "飯", "麵", "肉", "吐司", "蛋", "牛奶", "鮮奶", "飲料", "雞", "豬", "牛", "魚", "水果", "蔬菜", "餅", "巧克力", "麵包", "醬", "米", "湯", "酒", "餐", "可頌", "拿鐵", "美式", "三明治", "漢堡", "蛋糕", "便當", "優格", "起司"] },
];

function matches(text: string, keywords: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function firstMatchingCategory(text: string, rules: readonly CategoryRule[]): SpendingCategory | undefined {
  return rules.find((rule) => matches(text, rule.keywords))?.id;
}

export function classifyPersonalInvoiceItem({
  productName,
  sellerName,
  sellerAddr,
}: {
  productName: string;
  sellerName: string;
  sellerAddr: string;
}): SpendingCategory {
  return firstMatchingCategory(productName, ITEM_CATEGORY_RULES)
    ?? firstMatchingCategory(`${sellerName} ${sellerAddr}`, CATEGORY_RULES)
    ?? "other";
}
