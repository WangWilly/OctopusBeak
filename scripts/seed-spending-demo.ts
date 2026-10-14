import { mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteBaseline } from "../src/ledger/pglite/baseline.ts";
import { applyPgliteOperationalBaseline } from "../src/ledger/pglite/operational.ts";
import { PGliteStore } from "../src/ledger/pglite/transaction.ts";
import { commitPGliteCanonicalEInvoiceCapture } from "../src/ledger/pglite/einvoice.ts";
import { commitPGliteCanonicalCreditCardCapture } from "../src/ledger/pglite/credit-card.ts";
import { commitPGliteCanonicalCreditCardBalanceCapture } from "../src/ledger/pglite/credit-card.ts";
import { creditCardBalanceCommandRequest, creditCardCommandRequestFromCanonicalCapture } from "../src/ledger/pglite/credit-card-adapters.ts";
import { setPGliteSpendingPurchaseCategory } from "../src/ledger/pglite/purchase-category-command.ts";
import { applyPGliteSpendingPageAction } from "../src/ledger/pglite/spending-command.ts";
import { createPGliteSpendingQuery } from "../src/ledger/pglite/spending-query.ts";
import {
  esunCanonicalSpineCapture,
  esunNeutralCreditCardCapture,
} from "../src/ledger/canonical/esun-credit-card-admission.ts";
import {
  attachEsunIssuerStatementPeriods,
  buildEsunCanonicalCreditCardCapture,
  buildEsunSettledPeriodsFromIssuerSummaries,
  deriveEsunCanonicalHumanAttestation,
  esunCreditCurrentSnapshotCapture,
  type StatementRow,
} from "../src/workflows/esun-credit-card-statements.ts";
import {
  buildCanonicalEInvoiceCaptureFromApp,
  type InvoiceCaptureRecord,
} from "../src/workflows/einvoice-personal-invoices.ts";
import { writeAutomationSettingsFile } from "../src/lib/automation/server/config-files.ts";
import { SPENDING_UNCLASSIFIED_CATEGORY_SELECTOR } from "../src/lib/spending/model.ts";

/**
 * Disposable Spending demo for screen recordings of the merge flow.
 *
 * Purchases enter through the same builders and canonical commits the
 * production E-Invoice and E.SUN credit-card workflows use, so projections,
 * pairing candidates and the merge log behave like collected data. Card-only
 * purchases are then categorized through the Spending page's own category
 * command, and one September pair is merged through the page action so the
 * merged tab and log are not empty.
 *
 * Usage:
 *   node --no-warnings --experimental-strip-types scripts/seed-spending-demo.ts /tmp/octopusbeak-spending-demo
 *   OCTOPUSBEAK_USER_DATA=/tmp/octopusbeak-spending-demo npm run desktop:dev
 */

/** The demo's "today". Purchases dated after it are left out, so a later date simply adds the next days. */
const TODAY = process.env.DEMO_TODAY ?? "2026-10-11";
const MONTHS = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"] as const;
/** Inert placeholders: they only seed opaque identity digests, never a login. */
const DEMO_EINVOICE_CREDENTIALS = { einvoice_phone_number: "0900000000", einvoice_password: "demo-only" };
const DEMO_ESUN_CREDENTIALS = { esun_user_id: "DEMO-USER", esun_account: "DEMO-ACCOUNT", esun_password: "demo-only" };
const DEMO_ESUN_SECRET = "octopusbeak-spending-demo-secret";
const CARD_LABEL = "4563-****-****-5512";
const CREDIT_LIMIT = 200_000;

/** Collection-run dates shared with the whole-app demo: every third day from 5 June, daily for the last three weeks. */
export const SNAPSHOT_DATES: readonly string[] = (() => {
  const dates: string[] = [];
  const dailyFrom = Date.UTC(2026, 8, 20);
  for (let day = Date.UTC(2026, 5, 5); day <= Date.parse(`${TODAY}T00:00:00Z`); day += (day >= dailyFrom ? 1 : 3) * 86_400_000)
    dates.push(new Date(day).toISOString().slice(0, 10));
  return dates.at(-1) === TODAY ? dates : [...dates, TODAY];
})();

type Category =
  | "dining" | "food_and_groceries" | "personal_and_family_care" | "transportation"
  | "clothing_and_footwear" | "household_goods_and_services" | "housing_and_utilities"
  | "information_and_communication" | "recreation_sports_and_culture" | "travel" | "healthcare";

type Item = readonly [name: string, unitPrice: number, quantity?: number];

type Invoice = Readonly<{
  number: string;
  at: string; // YYYY-MM-DDTHH:mm
  seller: string;
  sellerTaxId: string;
  items: readonly Item[];
  category: Category;
}>;

type CardCharge = Readonly<{
  date: string; // YYYY-MM-DD consume date
  description: string;
  amount: number;
  category: Category;
}>;

const SELLERS = {
  pxmart: ["全聯實業股份有限公司", "83457112"],
  seven: ["統一超商股份有限公司", "70815529"],
  family: ["全家便利商店股份有限公司", "61328460"],
  starbucks: ["統一星巴克股份有限公司", "92617348"],
  shopee: ["樂購蝦皮股份有限公司", "50372811"],
  eslite: ["誠品生活股份有限公司", "26049153"],
  ikea: ["宜家家居股份有限公司", "41850237"],
  carrefour: ["家福股份有限公司", "38102946"],
  mcdonalds: ["和德昌股份有限公司", "57203184"],
  bafang: ["八方雲集國際股份有限公司", "64821937"],
  louisa: ["路易莎職人咖啡股份有限公司", "73650218"],
  watsons: ["屈臣氏台灣股份有限公司", "18374620"],
  cosmed: ["康是美股份有限公司", "29475163"],
  uniqlo: ["台灣優衣庫有限公司", "45738201"],
  cpc: ["台灣中油股份有限公司", "03707901"],
  vieshow: ["威秀影城股份有限公司", "87264310"],
} as const;

const KEEP_DERIVED_CATEGORY_SELLERS = new Set<string>([SELLERS.pxmart[0], SELLERS.carrefour[0]]);

function invoice(
  number: string,
  at: string,
  seller: keyof typeof SELLERS,
  category: Category,
  items: readonly Item[],
): Invoice {
  const [name, taxId] = SELLERS[seller];
  return { number, at, seller: name, sellerTaxId: taxId, items, category };
}

const total = (items: readonly Item[]) => items.reduce((sum, [, price, quantity = 1]) => sum + price * quantity, 0);

/**
 * October to date. Three purchases appear on both the e-invoice carrier and
 * the E.SUN card: 全聯 (hero, 1,444), 星巴克 and 蝦皮. Every other amount is
 * unique so no accidental duplicate is flagged.
 */
const OCTOBER_INVOICES: readonly Invoice[] = [
  invoice("AB38201745", "2026-10-03T18:21", "pxmart", "food_and_groceries", [
    ["光泉鮮乳 1857ml", 98, 2], ["台灣雞胸肉 600g", 189], ["有機地瓜葉", 45], ["高麗菜", 79],
    ["義美雞蛋 10入", 85], ["桂冠火鍋餃 1kg", 169], ["衛生紙 12捲", 299],
    ["愛之味麥仔茶 x6", 119], ["蘋果 4入", 179], ["香蕉 1串", 84],
  ]),
  invoice("ST41930628", "2026-10-05T09:12", "starbucks", "dining", [["那堤 大杯", 140], ["可頌", 85], ["美式咖啡 中杯", 105]]),
  invoice("SH52018467", "2026-10-07T22:40", "shopee", "household_goods_and_services", [["收納箱 三入組", 699], ["Type-C 快充線 2入", 389], ["運費", 60]]),
  invoice("UN20481937", "2026-10-01T08:05", "seven", "food_and_groceries", [["鮪魚飯糰", 35], ["茶葉蛋 x2", 26], ["CITY CAFE 大美式", 50]]),
  invoice("FM31740285", "2026-10-01T20:47", "family", "food_and_groceries", [["Fami 便當 雞腿", 99], ["御茶園", 30]]),
  invoice("MC60492817", "2026-10-02T12:31", "mcdonalds", "dining", [["大麥克套餐", 179], ["蘋果派", 39]]),
  invoice("LS27406193", "2026-10-02T15:10", "louisa", "dining", [["厚奶茶 中", 75], ["巧克力布朗尼", 75]]),
  invoice("UN20493355", "2026-10-03T07:58", "seven", "food_and_groceries", [["御飯糰 照燒雞", 39], ["純喫茶 紅茶", 25], ["國民便當", 79]]),
  invoice("BF18305726", "2026-10-04T19:02", "bafang", "dining", [["招牌鍋貼 10顆", 65], ["韭菜水餃 10顆", 65], ["酸辣湯", 40]]),
  invoice("WT55210489", "2026-10-04T16:20", "watsons", "personal_and_family_care", [["洗髮精 750ml", 259], ["牙膏 3入", 189], ["面紙 10包", 129]]),
  invoice("FM31752014", "2026-10-05T23:18", "family", "food_and_groceries", [["燕麥奶", 55], ["關東煮", 70], ["茶葉蛋", 13]]),
  invoice("ES70316284", "2026-10-06T20:44", "eslite", "recreation_sports_and_culture", [["《原子習慣》", 330], ["Moleskine 筆記本", 720], ["誠品書籤", 45]]),
  invoice("UN20518832", "2026-10-07T08:02", "seven", "food_and_groceries", [["雞肉飯糰", 39], ["拿鐵 大杯", 55]]),
  invoice("MC60511046", "2026-10-07T12:48", "mcdonalds", "dining", [["麥香雞套餐", 149], ["玉米濃湯", 49]]),
  invoice("CM83620174", "2026-10-08T17:35", "cosmed", "personal_and_family_care", [["維他命 C 60錠", 399], ["隱形眼鏡藥水", 230]]),
  invoice("FM31760573", "2026-10-08T21:09", "family", "food_and_groceries", [["冷凍水餃", 89], ["優格", 42], ["香蕉牛奶", 35]]),
  invoice("LS27419055", "2026-10-09T09:40", "louisa", "dining", [["經典拿鐵 大", 90], ["火腿起司帕尼尼", 95]]),
  invoice("UN20530417", "2026-10-10T08:10", "seven", "food_and_groceries", [["鮭魚飯糰", 39], ["美式咖啡 中杯", 45]]),
  invoice("FM31771208", "2026-10-11T19:30", "family", "food_and_groceries", [["咖哩雞飯", 89], ["無糖綠茶", 25]]),
  invoice("LS27431560", "2026-10-12T09:05", "louisa", "dining", [["燕麥拿鐵 中", 85], ["可頌", 55]]),
  invoice("BF18322941", "2026-10-13T12:20", "bafang", "dining", [["招牌鍋貼 10顆", 65], ["玉米濃湯", 40]]),
];

const OCTOBER_CARD: readonly CardCharge[] = [
  { date: "2026-10-03", description: "全聯福利中心－台北民生", amount: 1444, category: "food_and_groceries" },
  { date: "2026-10-05", description: "星巴克－信義誠品門市", amount: 330, category: "dining" },
  { date: "2026-10-07", description: "蝦皮購物", amount: 1148, category: "household_goods_and_services" },
  { date: "2026-10-01", description: "台灣高鐵－台北站", amount: 1490, category: "transportation" },
  { date: "2026-10-01", description: "UBER EATS", amount: 512, category: "dining" },
  { date: "2026-10-02", description: "NETFLIX.COM", amount: 390, category: "information_and_communication" },
  { date: "2026-10-02", description: "中華電信－電信費", amount: 999, category: "information_and_communication" },
  { date: "2026-10-03", description: "UBER TRIP", amount: 286, category: "transportation" },
  { date: "2026-10-04", description: "IKEA 新店店", amount: 2890, category: "household_goods_and_services" },
  { date: "2026-10-04", description: "台灣高鐵－左營站", amount: 1490 + 0, category: "transportation" },
  { date: "2026-10-05", description: "饗食天堂－京站店", amount: 2178, category: "dining" },
  { date: "2026-10-06", description: "台灣中油－直營民權站", amount: 1350, category: "transportation" },
  { date: "2026-10-06", description: "UBER EATS", amount: 438, category: "dining" },
  { date: "2026-10-08", description: "威秀影城－信義", amount: 640, category: "recreation_sports_and_culture" },
  { date: "2026-10-08", description: "UNIQLO 微風南山", amount: 1780, category: "clothing_and_footwear" },
  { date: "2026-10-09", description: "台北市停車管理工程處", amount: 120, category: "transportation" },
  { date: "2026-10-11", description: "誠品生活－松菸店", amount: 860, category: "recreation_sports_and_culture" },
  { date: "2026-10-12", description: "台灣大車隊", amount: 245, category: "transportation" },
  { date: "2026-10-13", description: "UBER EATS", amount: 356, category: "dining" },
];

/** The September pair merged up front, so 已合併 starts at 1 and becomes 2 after the demo merge. */
const SEPTEMBER_MERGED_INVOICE = invoice("AB37982214", "2026-09-14T17:52", "pxmart", "food_and_groceries", [
  ["光泉鮮乳 1857ml", 98], ["五花肉片", 215], ["雞蛋 10入", 85], ["小白菜", 39], ["白米 3kg", 329], ["沐浴乳", 189],
]);
const SEPTEMBER_MERGED_CARD: CardCharge = { date: "2026-09-14", description: "全聯福利中心－台北民生", amount: 955, category: "food_and_groceries" };

/** Deterministic pseudo-random so every run seeds the same history. */
function generator(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** Larger one-off card purchases that make each past month look different. */
const MONTH_EXTRAS: Readonly<Record<string, readonly CardCharge[]>> = {
  "2026-06": [
    { date: "2026-06-12", description: "國泰人壽－保費", amount: 4860, category: "personal_and_family_care" },
    { date: "2026-06-21", description: "全國電子－內湖店", amount: 3990, category: "household_goods_and_services" },
  ],
  "2026-07": [
    { date: "2026-07-05", description: "中華航空－網路訂位", amount: 8960, category: "travel" },
    { date: "2026-07-18", description: "AGODA 飯店預訂", amount: 6420, category: "travel" },
  ],
  "2026-08": [
    { date: "2026-08-09", description: "誠品生活－信義店", amount: 2180, category: "recreation_sports_and_culture" },
    { date: "2026-08-23", description: "NIKE 台北忠孝門市", amount: 3680, category: "clothing_and_footwear" },
  ],
  "2026-09": [
    { date: "2026-09-12", description: "國泰人壽－保費", amount: 4860, category: "personal_and_family_care" },
    { date: "2026-09-27", description: "Apple.com/TW", amount: 2990, category: "information_and_communication" },
  ],
};

/** June to September history, so the trend, usual-spending band and comparisons have data. */
function historyFor(month: string, seed: number): { invoices: Invoice[]; card: CardCharge[] } {
  const random = generator(seed);
  const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const day = (index: number, count: number) => String(Math.min(days, 1 + Math.floor((index * days) / count + random() * 1.5))).padStart(2, "0");
  const vary = (base: number) => Math.round(base * (0.85 + random() * 0.35));
  const invoiceTemplates: readonly [keyof typeof SELLERS, Category, readonly Item[]][] = [
    ["seven", "food_and_groceries", [["鮪魚飯糰", 35], ["CITY CAFE 大美式", 50]]],
    ["louisa", "dining", [["經典拿鐵 大", 90], ["火腿起司帕尼尼", 95]]],
    ["pxmart", "food_and_groceries", [["光泉鮮乳 1857ml", 98], ["雞胸肉 600g", 189], ["高麗菜", 79], ["雞蛋 10入", 85], ["白米 3kg", 329]]],
    ["mcdonalds", "dining", [["大麥克套餐", 179], ["蘋果派", 39]]],
    ["family", "food_and_groceries", [["Fami 便當", 99], ["御茶園", 30]]],
    ["bafang", "dining", [["招牌鍋貼 10顆", 65], ["酸辣湯", 40]]],
    ["watsons", "personal_and_family_care", [["洗髮精 750ml", 259], ["牙膏 3入", 189]]],
    ["seven", "food_and_groceries", [["國民便當", 79], ["純喫茶 紅茶", 25]]],
    ["carrefour", "food_and_groceries", [["衛生紙 24捲", 459], ["洗衣精補充包", 329], ["冷凍水餃", 189], ["牛奶 2L", 145], ["咖啡豆 1lb", 499], ["水果禮盒", 680]]],
    ["starbucks", "dining", [["那堤 大杯", 140], ["肉桂捲", 75]]],
    ["family", "food_and_groceries", [["關東煮", 70], ["燕麥奶", 55]]],
    ["eslite", "recreation_sports_and_culture", [["小說", 380], ["文具", 120]]],
    ["mcdonalds", "dining", [["早餐套餐", 99]]],
    ["louisa", "dining", [["厚奶茶 中", 75], ["布朗尼", 75]]],
    ["pxmart", "food_and_groceries", [["豬五花肉片", 215], ["小白菜", 39], ["豆腐", 35], ["沐浴乳", 189], ["洗碗精", 89]]],
    ["cosmed", "healthcare", [["維他命 C 60錠", 399], ["OK 繃", 59]]],
    ["seven", "food_and_groceries", [["雞肉飯糰", 39], ["拿鐵 大杯", 55]]],
    ["vieshow", "recreation_sports_and_culture", [["電影票 x2", 330, 2], ["爆米花套餐", 200]]],
    ["family", "food_and_groceries", [["冷凍水餃", 89], ["優格", 42]]],
    ["bafang", "dining", [["韭菜水餃 10顆", 65], ["豆漿", 25]]],
  ];
  const cardTemplates: readonly [string, Category, number, boolean][] = [
    ["中華電信－電信費", "information_and_communication", 999, false],
    ["NETFLIX.COM", "information_and_communication", 390, false],
    ["健身工廠－月費", "recreation_sports_and_culture", 1288, false],
    ["UBER EATS", "dining", 460, true],
    ["台灣中油－直營民權站", "transportation", 1280, true],
    ["鼎泰豐－信義店", "dining", 1620, true],
    ["UBER TRIP", "transportation", 260, true],
    ["台灣高鐵－台北站", "transportation", 1490, false],
    ["台灣高鐵－左營站", "transportation", 1490, false],
    ["UNIQLO 微風南山", "clothing_and_footwear", 1290, true],
    ["UBER EATS", "dining", 380, true],
    ["台電－電費代繳", "housing_and_utilities", 1860, true],
    ["IKEA 新店店", "household_goods_and_services", 2350, true],
    ["饗食天堂－京站店", "dining", 2178, false],
    ["UBER TRIP", "transportation", 310, true],
    ["台北自來水事業處", "housing_and_utilities", 420, true],
    ["UBER EATS", "dining", 520, true],
    ["台灣中油－直營民權站", "transportation", 1150, true],
  ];
  const prefix = String.fromCharCode(80 + MONTHS.indexOf(month as typeof MONTHS[number]));
  const invoices = invoiceTemplates.map(([seller, category, items], index): Invoice => {
    const date = `${month}-${day(index, invoiceTemplates.length)}`;
    const hour = String(8 + Math.floor(random() * 13)).padStart(2, "0");
    const minute = String(Math.floor(random() * 60)).padStart(2, "0");
    const number = `${prefix}${String.fromCharCode(65 + index)}${String(10_000_000 + Math.floor(random() * 89_999_999))}`;
    return invoice(number, `${date}T${hour}:${minute}`, seller, category,
      items.map(([name, price, quantity]) => [name, price >= 100 ? vary(price) : price, quantity] as const));
  });
  const card = cardTemplates.map(([description, category, base, varies], index): CardCharge => ({
    date: `${month}-${day(index, cardTemplates.length)}`,
    description,
    amount: varies ? vary(base) : base,
    category,
  }));
  return { invoices, card: [...card, ...(MONTH_EXTRAS[month] ?? [])] };
}

function assertDisposableRoot(userData: string) {
  const root = resolve(userData);
  const allowedRoots = ["/tmp", "/private/tmp", resolve(tmpdir())];
  if (allowedRoots.some((allowedRoot) => root.startsWith(`${allowedRoot}${sep}`))) return root;
  throw new Error(`Spending demo user-data must be inside a temporary directory: ${root}`);
}

function invoiceRecord(entry: Invoice, ordinal: number): InvoiceCaptureRecord {
  const [date, time] = entry.at.split("T") as [string, string];
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const amount = String(total(entry.items));
  return {
    month: { year, month },
    listPageIndex: 0,
    header: {
      rowNum: String(ordinal + 1),
      invPeriod: `${year - 1911}${String(month + (month % 2)).padStart(2, "0")}`,
      invNum: entry.number,
      invoiceTime: `${time}:00`,
      invStatus: "開立已確認",
      cardType: "3J0002",
      sellerBan: entry.sellerTaxId,
      sellerName: entry.seller,
      amount,
      currency: "TWD",
      invDate: { year: String(year - 1911), month: String(month), date: String(day) },
    },
    items: entry.items.map(([name, price, quantity = 1], index) => ({
      rowNum: String(index + 1),
      description: name,
      quantity: String(quantity),
      unitPrice: String(price),
      amount: String(price * quantity),
    })),
  };
}

function statementRow(charge: CardCharge): StatementRow {
  const billed = charge.date < "2026-10-01";
  return {
    cardNumber: CARD_LABEL,
    consumeDate: charge.date.replaceAll("-", "/"),
    description: charge.description,
    foreignCurrency: "",
    foreignAmount: "",
    paymentCurrency: "TWD",
    twdAmount: String(charge.amount),
    paymentStatus: billed ? "billed" : "unbilled",
    sourcePaymentStatus: billed ? "已入帳" : "未入帳",
  };
}

async function latestKnowledge(store: PGliteStore): Promise<number> {
  const row = (await store.query<{ value: number | string }>("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits")).rows[0];
  return Number(row?.value ?? 0);
}

function uuidText(value: Uint8Array): string {
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function seedSpendingDemo(userData: string) {
  const root = assertDisposableRoot(userData);
  mkdirSync(join(root, "data"), { recursive: true });
  writeAutomationSettingsFile(join(root, "settings.json"), {
    AUTOMATION_BUSINESS_TIMEZONE: "Asia/Taipei",
    EXCHANGE_RATE_UPDATE_TIME: "23:59",
    LIBRETTO_CLOUD_ESUN_ENABLED: true,
    LIBRETTO_CLOUD_EINVOICE_ENABLED: true,
  });

  const history = MONTHS.slice(0, 4).map((month, index) => historyFor(month, 7_919 * (index + 3)));
  const invoices = [...history.flatMap((entry) => entry.invoices), SEPTEMBER_MERGED_INVOICE, ...OCTOBER_INVOICES.filter((entry) => entry.at.slice(0, 10) <= TODAY)];
  const charges = [...history.flatMap((entry) => entry.card), SEPTEMBER_MERGED_CARD, ...OCTOBER_CARD.filter((entry) => entry.date <= TODAY)];

  const dataDir = join(root, "data", "pglite");
  const database = await PGlite.create({ dataDir });
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    await applyPgliteOperationalBaseline(store);

    // E-Invoice: one complete four-month capture, exactly as the workflow assembles it.
    const records = invoices.map(invoiceRecord);
    const pages = MONTHS.map((month) => {
      const content = records.filter((record) => `${record.month.year}-${String(record.month.month).padStart(2, "0")}` === month);
      return {
        month: { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) },
        pageIndex: 0,
        rowCount: content.length,
      };
    });
    const einvoiceCapture = buildCanonicalEInvoiceCaptureFromApp(
      { records, pages, months: [...MONTHS] },
      DEMO_EINVOICE_CREDENTIALS,
      { captureId: "einvoice-capture:spending-demo", observedAt: `${TODAY}T02:00:00.000Z`, today: new Date(`${TODAY}T12:00:00+08:00`) },
    );
    await commitPGliteCanonicalEInvoiceCapture(store, einvoiceCapture);

    // E.SUN: one complete one-year timeline with issuer cycle summaries for July to September.
    const identity = deriveEsunCanonicalHumanAttestation(DEMO_ESUN_CREDENTIALS, DEMO_ESUN_SECRET);
    if (!identity) throw new Error("Demo E.SUN identity could not be derived.");
    const monthSum = (month: string) => String(charges.filter((charge) => charge.date.startsWith(month)).reduce((sum, charge) => sum + charge.amount, 0));
    const settledPeriods = buildEsunSettledPeriodsFromIssuerSummaries([
      { cycleEnd: "2026/05/31", dueDate: "2026/06/15", balance: "0", minimumPayment: "0" },
      { cycleEnd: "2026/06/30", dueDate: "2026/07/15", balance: monthSum("2026-06"), minimumPayment: "1000" },
      { cycleEnd: "2026/07/31", dueDate: "2026/08/15", balance: monthSum("2026-07"), minimumPayment: "1000" },
      { cycleEnd: "2026/08/31", dueDate: "2026/09/15", balance: monthSum("2026-08"), minimumPayment: "1000" },
      { cycleEnd: "2026/09/30", dueDate: "2026/10/15", balance: monthSum("2026-09"), minimumPayment: "1000" },
    ]);
    const rows = attachEsunIssuerStatementPeriods(charges.map(statementRow), settledPeriods);
    const billedRows = rows.filter((row) => row.paymentStatus === "billed");
    const unbilledRows = rows.filter((row) => row.paymentStatus === "unbilled");
    const months = Array.from({ length: 13 }, (_, index) =>
      new Date(Date.UTC(2026, 9 - index, 1)).toISOString().slice(0, 7).replace("-", "/"));
    const esunCapture = buildEsunCanonicalCreditCardCapture({
      startDate: "2025/10/11",
      endDate: "2026/10/11",
      identity,
      statementRows: billedRows,
      unbilledRows,
      grid: {
        kind: "past-year-timeline",
        firstMonth: months[0]!,
        lastMonth: months.at(-1)!,
        months,
        pageCount: 13,
        monthCount: 13,
        capturedRowCount: rows.length,
        terminal: true,
        terminalCursor: 4,
      },
      capture: {
        snapshotMode: "full",
        captureId: "esun-capture-spending-demo",
        capturedAt: `${TODAY}T02:05:00.000Z`,
        captureKinds: ["billed", "unbilled"],
        completenessEvidence: { bank: "esun", range: "default_one_year" },
      },
      instrumentFingerprintSecret: DEMO_ESUN_SECRET,
      settledPeriods,
    });
    if (!esunCapture) throw new Error("Demo E.SUN capture was not admitted.");
    const cardRequest = creditCardCommandRequestFromCanonicalCapture(
      esunCanonicalSpineCapture(esunCapture),
      esunNeutralCreditCardCapture(esunCapture),
    );
    await commitPGliteCanonicalCreditCardCapture(store, cardRequest);

    // Current used credit, as each collection run reads it: every charge so far
    // minus the cycles already paid from the Fubon account on the 15th.
    const paidThrough = (date: string) => settledPeriods
      .filter((period) => period.dueDate && period.dueDate.replaceAll("/", "-") <= date)
      .reduce((sum, period) => sum + Number(period.balance ?? 0), 0);
    for (const date of SNAPSHOT_DATES) {
      const charged = charges.filter((charge) => charge.date <= date).reduce((sum, charge) => sum + charge.amount, 0);
      const used = charged - paidThrough(date);
      const queryTime = `${date.replaceAll("-", "/")} 09:30:00`;
      const snapshot = esunCreditCurrentSnapshotCapture(esunCapture, {
        usedCredit: used.toLocaleString("en-US"),
        available: (CREDIT_LIMIT - used).toLocaleString("en-US"),
        sourceField: "usedCreditLimit",
        endpoint: "https://ebank.esunbank.com.tw/esb/mib-ccm-portal/ccmA1/ccmA1001/home/getCardSummary",
        queryTime,
        httpDate: new Date(`${date}T01:30:00Z`).toUTCString(),
      });
      await commitPGliteCanonicalCreditCardBalanceCapture(store, creditCardBalanceCommandRequest(
        { ...snapshot, captureId: `${snapshot.captureId}:${date}` },
        cardRequest.identity,
      ));
    }

    // Card rows carry no taxonomy evidence of their own; categorize them the
    // way a user does on the Spending page. Grocery invoices keep their
    // item-derived split (food, household goods); other invoices get one
    // user category so a coffee shop does not read as a split purchase.
    const intendedCard = new Map(charges.map((charge) => [`${charge.date}|${charge.description}|${charge.amount}`, charge.category]));
    const cardRows = (await store.query<{ transaction_id: Uint8Array; effective_on: string; description: string; amount: string }>(
      `SELECT current_row.transaction_id, revision.effective_on, revision.description, revision.amount_coefficient AS amount
         FROM current_transactions current_row
         JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id`,
    )).rows;
    for (const row of cardRows) {
      const category = intendedCard.get(`${row.effective_on}|${row.description}|${row.amount}`);
      if (!category) throw new Error(`Seeded card row has no intended category: ${row.effective_on} ${row.description} ${row.amount}`);
      await setPGliteSpendingPurchaseCategory(store, {
        purchaseId: `transaction:${uuidText(row.transaction_id)}`,
        knowledgeAt: await latestKnowledge(store),
        categoryCode: category,
      });
    }
    const intendedInvoice = new Map(invoices.map((entry) => [entry.number, entry]));
    const invoiceRows = (await store.query<{ invoice_id: Uint8Array; stable_invoice_key: string }>(
      "SELECT invoice_id, stable_invoice_key FROM einvoice_invoices",
    )).rows;
    const query = createPGliteSpendingQuery(store);
    const unclassified = new Set<string>();
    for (const month of MONTHS) {
      const page = await query.recordPage({ knowledgeAt: await latestKnowledge(store), month, limit: 100, categoryCodes: [SPENDING_UNCLASSIFIED_CATEGORY_SELECTOR] });
      for (const record of page.records) unclassified.add(record.purchaseId);
    }
    for (const row of invoiceRows) {
      const purchaseId = `invoice:${uuidText(row.invoice_id)}`;
      const intended = intendedInvoice.get(row.stable_invoice_key.split(":")[2] ?? "");
      if (!intended) throw new Error(`Seeded invoice has no intended category: ${row.stable_invoice_key}`);
      if (KEEP_DERIVED_CATEGORY_SELLERS.has(intended.seller) && !unclassified.has(purchaseId)) continue;
      await setPGliteSpendingPurchaseCategory(store, {
        purchaseId,
        knowledgeAt: await latestKnowledge(store),
        categoryCode: intended.category,
      });
    }

    // Merge the September pair through the page action, as a user would.
    let knowledgeAt = await latestKnowledge(store);
    const pending = await query.candidatePage({ knowledgeAt, month: null, limit: 100 });
    const septemberPair = pending.items.find((item) =>
      item.invoiceRecord?.invoice?.revision.invoiceNumber === SEPTEMBER_MERGED_INVOICE.number);
    if (!septemberPair) throw new Error("The September demo pair was not offered as a candidate.");
    await applyPGliteSpendingPageAction(store, {
      action: "confirm",
      kind: "candidate",
      candidateId: septemberPair.candidate.candidateId,
      invoiceIdentityId: septemberPair.candidate.invoiceId,
      transactionIdentityId: septemberPair.candidate.transactionId,
      dataVersion: knowledgeAt,
    });

    knowledgeAt = await latestKnowledge(store);
    const overview = await query.pendingOverview({ knowledgeAt });
    const remaining = await query.candidatePage({ knowledgeAt, month: null, limit: 100 });
    const pairs = remaining.items.map((item) =>
      `${item.invoiceRecord?.invoice?.revision.invoiceNumber ?? "?"} ↔ ${item.paymentRecord?.transaction?.description ?? "?"} (${item.candidate.strength})`);
    const expected = new Set(OCTOBER_INVOICES.slice(0, 3).map((entry) => entry.number));
    if (remaining.items.length !== 3 || remaining.items.some((item) => !expected.has(item.invoiceRecord?.invoice?.revision.invoiceNumber ?? "")))
      throw new Error(`Unexpected pending pairs: ${pairs.join("; ")}`);
    const cardBills = settledPeriods
      .filter((period) => Number(period.balance) > 0)
      .map((period) => ({ dueDate: period.dueDate, amount: Number(period.balance) }));
    return { dataDir, knowledgeAt, pendingCount: overview.pendingCount, strongCount: overview.strongCount, pairs, cardBills };
  } finally {
    await store.close();
  }
}

/** Remove only the named disposable demo root. */
export function removeSpendingDemo(userData: string) {
  rmSync(assertDisposableRoot(userData), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function main() {
  const userData = process.argv[2];
  if (!userData) throw new Error("Usage: seed-spending-demo <user-data-root under /tmp>");
  removeSpendingDemo(userData);
  const result = await seedSpendingDemo(userData);
  console.log(`Spending demo written to ${result.dataDir}`);
  console.log(`Pending pairs: ${result.pendingCount} (strong ${result.strongCount})`);
  for (const pair of result.pairs) console.log(`  ${pair}`);
}

const isCliEntry = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCliEntry) await main();
