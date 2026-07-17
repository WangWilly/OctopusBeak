const BANK_FULL_NAMES: Record<string, string> = {
  cathay: "國泰世華商業銀行",
  ctbc: "中國信託商業銀行",
  esun: "玉山商業銀行",
  fubon: "台北富邦商業銀行",
  hncb: "華南商業銀行",
  linebank: "連線商業銀行",
  post: "中華郵政",
  sinopac: "永豐商業銀行",
  yuanta: "元大商業銀行",
};

export function bankFullName(bank: string): string {
  const key = bank.trim().toLowerCase().replace(/[-_\s]/gu, "");
  return BANK_FULL_NAMES[key] ?? bank;
}
