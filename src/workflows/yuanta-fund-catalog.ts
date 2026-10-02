export type YuantaFundCatalogEntry = Readonly<{
  fundCode: string;
  name: string;
  pricingCurrency: string;
}>;

function decodeCatalogLiteral(literal: string): string {
  if (literal.startsWith('"')) return JSON.parse(literal) as string;
  const body = literal.slice(1, -1);
  let value = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") { value += char; continue; }
    const escape = body[++index];
    const simple: Record<string, string> = {
      "'": "'", '"': '"', "\\": "\\", "/": "/",
      b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
    };
    if (escape in simple) { value += simple[escape]; continue; }
    const size = escape === "u" ? 4 : escape === "x" ? 2 : 0;
    const digits = body.slice(index + 1, index + 1 + size);
    if (!size || !new RegExp(`^[0-9a-f]{${size}}$`, "i").test(digits)) {
      throw new Error("YuanTa fund catalog has an unsupported string escape.");
    }
    value += String.fromCharCode(Number.parseInt(digits, 16));
    index += size;
  }
  return value;
}

export function yuantaFundCatalogName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/** Read the bank's own selection data without executing source JavaScript. */
export function parseYuantaFundCatalog(script: string): YuantaFundCatalogEntry[] {
  const records = new Map<string, YuantaFundCatalogEntry>();
  const assignments = /(?:^|\n)[ \t]*(?:tempChoiceSingleFund|single(?:Tw|Fx)Fund\[[^\n;]+)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*;/gu;
  for (const match of script.matchAll(assignments)) {
    const literal = decodeCatalogLiteral(match[1]);
    if (!literal) continue;
    const fields = literal.split("_");
    if (fields.length !== 39 || !/^[A-Za-z0-9]{4}$/u.test(fields[2]) ||
      !fields[3].trim() || !/^[A-Z]{3}$/u.test(fields[4])) {
      throw new Error("YuanTa fund catalog has an unsupported source record.");
    }
    const entry = { fundCode: fields[2], name: fields[3], pricingCurrency: fields[4] };
    const previous = records.get(entry.fundCode);
    if (previous && (yuantaFundCatalogName(previous.name) !== yuantaFundCatalogName(entry.name) ||
      previous.pricingCurrency !== entry.pricingCurrency)) {
      throw new Error("YuanTa fund catalog has contradictory native identity evidence.");
    }
    records.set(entry.fundCode, entry);
  }
  if (!records.size) throw new Error("YuanTa fund catalog has no source fund records.");
  return [...records.values()].sort((a, b) => a.fundCode.localeCompare(b.fundCode));
}

export function resolveYuantaFundCatalogName(
  catalog: readonly YuantaFundCatalogEntry[], name: string,
): YuantaFundCatalogEntry {
  const normalized = yuantaFundCatalogName(name);
  const matches = catalog.filter(entry => yuantaFundCatalogName(entry.name) === normalized);
  if (!normalized || matches.length === 0 || new Set(matches.map(entry => entry.fundCode)).size !== 1 ||
    new Set(matches.map(entry => entry.pricingCurrency)).size !== 1) {
    throw new Error("YuanTa historical fund name has no unique source catalog identity.");
  }
  return matches[0];
}

/** Source history identifies funds by their reported name, independently of later metadata. */
export function resolveYuantaFundIdentity(name: string) {
  const normalized = yuantaFundCatalogName(name);
  if (!normalized) throw new Error("YuanTa fund requires a source name.");
  return { fundCode: `name:${normalized}`, name: normalized, pricingCurrency: null,
    identityKind: "source-fund-name" as const };
}
