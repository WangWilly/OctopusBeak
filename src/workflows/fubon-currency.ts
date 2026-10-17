const FUBON_SOURCE_CURRENCY_ALIASES: Readonly<Record<string, string>> = {
  臺幣: "TWD", 台幣: "TWD", 新臺幣: "TWD", 新台幣: "TWD",
  美金: "USD", 美元: "USD", 日圓: "JPY", 日幣: "JPY", 歐元: "EUR", 人民幣: "CNY",
  港幣: "HKD", 英鎊: "GBP", 澳幣: "AUD", 加幣: "CAD", 新加坡幣: "SGD", 瑞士法郎: "CHF",
  紐幣: "NZD", 南非幣: "ZAR", 泰銖: "THB", 瑞典幣: "SEK",
};

/** The ISO code for a Fubon currency cell, or null when the label is unknown. */
export function fubonIsoCurrency(sourceLexeme: string): string | null {
  const normalized = sourceLexeme.replace(/\s+/gu, "").toUpperCase();
  const currency = FUBON_SOURCE_CURRENCY_ALIASES[normalized] ?? normalized;
  return /^[A-Z]{3}$/u.test(currency) ? currency : null;
}
