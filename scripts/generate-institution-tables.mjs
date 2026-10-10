// Regenerates src/lib/institutions/institution-tables.generated.ts from the
// authoritative registries:
// - FISC member list (財金資訊 金融機構代號): every institution that receives
//   interbank remittances into accounts (業務別 通匯業務-入戶電匯).
// - TWSE securities firm head offices and branches (證券商總公司/分公司基本資料).
// Run with `node scripts/generate-institution-tables.mjs`, then review the diff.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FISC_MEMBERS = "https://www.fisc.com.tw/TC/OPENDATA/Comm1_MEMBER.csv";
const TWSE_FIRMS = "https://openapi.twse.com.tw/v1/brokerService/brokerList";
const TWSE_BRANCHES = "https://openapi.twse.com.tw/v1/opendata/OpenData_BRK02";
const OUTPUT = fileURLToPath(new URL("../src/lib/institutions/institution-tables.generated.ts", import.meta.url));

// FISC remittance members that hold no customer deposit accounts: the central
// bank treasury, bills finance companies, information centres, and the treasury.
const FISC_NON_DEPOSITORY = new Set(["000", "060", "061", "062", "066", "372", "600", "952", "995", "996", "997"]);

// Institutions with their own supported source keep the key their logo and
// i18n names already use. Every other code gets a key derived from its code.
const BANK_OVERLAY = {
  "004": { en: "Bank of Taiwan" },
  "005": { en: "Land Bank of Taiwan" },
  "006": { en: "Taiwan Cooperative Bank" },
  "007": { en: "First Commercial Bank" },
  "008": { key: "hncb", zhTW: "華南銀行", en: "Hua Nan Bank" },
  "009": { en: "Chang Hwa Bank" },
  "011": { en: "Shanghai Commercial and Savings Bank" },
  "012": { key: "fubon", zhTW: "台北富邦銀行", en: "Taipei Fubon Bank" },
  "013": { key: "cathay", zhTW: "國泰世華銀行", en: "Cathay United Bank" },
  "016": { en: "Bank of Kaohsiung" },
  "017": { en: "Mega International Commercial Bank" },
  "018": { en: "Agricultural Bank of Taiwan" },
  "020": { en: "Mizuho Bank Taipei Branch" },
  "021": { en: "Citibank Taiwan" },
  "022": { en: "Bank of America Taipei Branch" },
  "023": { en: "Bangkok Bank Taipei Branch" },
  "025": { en: "Metropolitan Bank and Trust Taipei Branch" },
  "029": { en: "United Overseas Bank Taipei Branch" },
  "030": { en: "State Street Bank and Trust Taipei Branch" },
  "037": { en: "Societe Generale Taipei Branch" },
  "039": { en: "ANZ Bank Taipei Branch" },
  "048": { en: "O-Bank" },
  "050": { en: "Taiwan Business Bank" },
  "052": { en: "Standard Chartered Bank (Taiwan)" },
  "053": { en: "Taichung Commercial Bank" },
  "054": { en: "King's Town Bank" },
  "072": { en: "Deutsche Bank Taipei Branch" },
  "075": { en: "Bank of East Asia Taipei Branch" },
  "076": { en: "JPMorgan Chase Bank Taipei Branch" },
  "081": { en: "HSBC Bank (Taiwan)" },
  "082": { en: "BNP Paribas Taipei Branch" },
  "085": { en: "OCBC Bank Taipei Branch" },
  "086": { en: "Credit Agricole CIB Taipei Branch" },
  "092": { en: "UBS Taipei Branch" },
  "093": { en: "ING Bank Taipei Branch" },
  "098": { en: "MUFG Bank Taipei Branch" },
  "101": { en: "Taipei Star Bank" },
  "102": { en: "Hwatai Bank" },
  "103": { en: "Shin Kong Bank" },
  "108": { en: "Sunny Bank" },
  "114": { en: "Keelung First Credit Cooperative" },
  "115": { en: "Keelung Second Credit Cooperative" },
  "118": { en: "Bank of Panhsin" },
  "119": { en: "Tamsui First Credit Cooperative" },
  "130": { en: "Hsinchu First Credit Cooperative" },
  "132": { en: "Hsinchu Third Credit Cooperative" },
  "146": { en: "Taichung Second Credit Cooperative" },
  "147": { en: "Cota Commercial Bank" },
  "162": { en: "Changhua Sixth Credit Cooperative" },
  "204": { en: "Kaohsiung Third Credit Cooperative" },
  "215": { en: "Hualien First Credit Cooperative" },
  "216": { en: "Hualien Second Credit Cooperative" },
  "321": { en: "SMBC Taipei Branch" },
  "326": { en: "BBVA Taipei Branch" },
  "329": { en: "Bank Rakyat Indonesia Taipei Branch" },
  "330": { en: "KEB Hana Bank Taipei Branch" },
  "380": { en: "Bank of China Taipei Branch" },
  "381": { en: "Bank of Communications Taipei Branch" },
  "382": { en: "China Construction Bank Taipei Branch" },
  "700": { key: "post", zhTW: "中華郵政", en: "Chunghwa Post" },
  "803": { en: "Union Bank of Taiwan" },
  "805": { en: "Far Eastern International Bank" },
  "806": { key: "yuanta-bank", zhTW: "元大銀行", en: "Yuanta Bank" },
  "807": { key: "sinopac", zhTW: "永豐銀行", en: "Bank SinoPac" },
  "808": { key: "esun", zhTW: "玉山銀行", en: "E.SUN Bank" },
  "809": { en: "KGI Bank" },
  "810": { en: "DBS Bank (Taiwan)" },
  "812": { en: "Taishin International Bank" },
  "816": { en: "EnTie Commercial Bank" },
  "822": { key: "ctbc", zhTW: "中國信託銀行", en: "CTBC Bank" },
  "823": { en: "Next Bank" },
  "824": { key: "linebank", zhTW: "LINE Bank", en: "LINE Bank" },
  "826": { en: "Rakuten International Commercial Bank" },
};

const BROKER_OVERLAY = {
  "9800": { key: "yuanta-securities", zhTW: "元大證券", en: "Yuanta Securities" },
};

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

const decodeEntities = (text) =>
  text.replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code))).trim();

function bankRows(csv) {
  const members = new Map();
  for (const line of csv.replace(/^﻿/u, "").split(/\r?\n/u).slice(1)) {
    const match = /^"([^"]*)",([^,]*),(.*)$/u.exec(line.trim());
    if (!match || match[1] !== "通匯業務-入戶電匯" || !/^\d{3}$/u.test(match[2])) continue;
    if (!FISC_NON_DEPOSITORY.has(match[2])) members.set(match[2], match[3].trim());
  }
  const codes = [...members.keys()].sort();
  const missing = codes.filter((code) => !(code in BANK_OVERLAY));
  const stale = Object.keys(BANK_OVERLAY).filter((code) => !members.has(code));
  if (missing.length || stale.length)
    throw new Error(`Bank overlay is out of date. Missing: ${missing.join(" ")}. Not in FISC: ${stale.join(" ")}.`);
  return codes.map((code) => ({
    code,
    key: BANK_OVERLAY[code].key ?? `bank-${code}`,
    zhTW: BANK_OVERLAY[code].zhTW ?? members.get(code),
    en: BANK_OVERLAY[code].en,
  }));
}

/** A firm's branches share its head-office code up to the head office's trailing zeros (9800 -> 98xx, 1020 -> 102x). */
/**
 * Branch codes TDCC reports on broker accounts that TWSE OpenData_BRK02 does
 * not list, each to its firm's head-office code.
 */
const UNLISTED_BROKER_BRANCHES = {
  "8889": "8880", // 國泰證券敦南分公司, seen in TDCC TR001.
};

const firmPrefix = (code) => code.replace(/0+$/u, "");

function brokerTables(firms, branches) {
  const firmRows = firms
    .map((firm) => ({ code: firm.Code.trim(), name: decodeEntities(firm.Name) }))
    .sort((left, right) => (left.code < right.code ? -1 : 1));
  const firmFor = (code) => {
    const candidates = firmRows.filter((firm) => code.startsWith(firmPrefix(firm.code)));
    const longest = Math.max(...candidates.map((firm) => firmPrefix(firm.code).length));
    const matches = candidates.filter((firm) => firmPrefix(firm.code).length === longest);
    if (matches.length !== 1) throw new Error(`Broker branch ${code} matches ${matches.length} firms.`);
    return matches[0].code;
  };
  const branchFirms = new Map(firmRows.map((firm) => [firm.code, firm.code]));
  for (const branch of branches) {
    const code = branch["證券商代號"].trim();
    if (branchFirms.has(code)) throw new Error(`Broker branch ${code} is listed twice.`);
    branchFirms.set(code, firmFor(code));
  }
  for (const [code, firm] of Object.entries(UNLISTED_BROKER_BRANCHES)) {
    if (branchFirms.has(code)) throw new Error(`Unlisted broker branch ${code} is now listed by TWSE; remove it from the overlay.`);
    if (!firmRows.some((row) => row.code === firm)) throw new Error(`Unlisted broker branch ${code} names firm ${firm}, which TWSE does not list.`);
    branchFirms.set(code, firm);
  }
  const stale = Object.keys(BROKER_OVERLAY).filter((code) => !branchFirms.has(code));
  if (stale.length) throw new Error(`Broker overlay names firms TWSE does not list: ${stale.join(" ")}.`);
  return {
    firms: firmRows.map((firm) => ({
      code: firm.code,
      key: BROKER_OVERLAY[firm.code]?.key ?? `broker-${firm.code}`,
      zhTW: BROKER_OVERLAY[firm.code]?.zhTW ?? firm.name,
      en: BROKER_OVERLAY[firm.code]?.en ?? null,
    })),
    branchFirms: [...branchFirms].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  };
}

const [csv, firms, branches] = await Promise.all([
  fetchText(FISC_MEMBERS),
  fetchText(TWSE_FIRMS).then(JSON.parse),
  fetchText(TWSE_BRANCHES).then(JSON.parse),
]);
const banks = bankRows(csv);
const brokers = brokerTables(firms, branches);
const row = (value) => `  ${JSON.stringify(value)},`;
writeFileSync(OUTPUT, [
  "// Generated by scripts/generate-institution-tables.mjs. Do not edit by hand.",
  `// Sources: ${FISC_MEMBERS}`,
  `//          ${TWSE_FIRMS}`,
  `//          ${TWSE_BRANCHES}`,
  "",
  "export const BANK_ROWS = [",
  ...banks.map(row),
  "] as const;",
  "",
  "export const BROKER_FIRM_ROWS = [",
  ...brokers.firms.map(row),
  "] as const;",
  "",
  "/** Every TWSE broker branch code, head offices included, to its firm's head-office code. */",
  "export const BROKER_BRANCH_FIRMS: Readonly<Record<string, string>> = {",
  ...brokers.branchFirms.map(([branch, firm]) => `  ${JSON.stringify(branch)}: ${JSON.stringify(firm)},`),
  "};",
  "",
].join("\n"));
console.log(`${banks.length} banks, ${brokers.firms.length} broker firms, ${brokers.branchFirms.length} broker branch codes`);
