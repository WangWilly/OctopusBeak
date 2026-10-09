export type FieldValueType = "string" | "number" | "boolean" | "null" | "object" | "array";

export type FieldInventoryEntry = Readonly<{
  types: readonly FieldValueType[];
  present: number;
  total: number;
  /** Shape of the first primitive seen: digits become 9, letters A/a, CJK 中, length kept. */
  example: string | null;
  /** Only for short enum-like fields whose key and values cannot hold personal or financial data. */
  values?: readonly string[];
}>;

export type FieldInventory = Readonly<Record<string, FieldInventoryEntry>>;

const MAX_ENUM_VALUES = 12;
const MAX_ENUM_VALUE_LENGTH = 16;
const LONG_DIGIT_RUN = /\d{4,}/u;
const DENIED_KEY_WORDS = new Set([
  "id", "no", "num", "number", "acct", "acc", "account", "accounts", "ser", "serno", "stan",
  "name", "nm", "owner", "cust", "customer", "holder", "payee", "payer", "counterparty", "remitter", "beneficiary",
  "amt", "amount", "bal", "balance", "qty", "quantity", "shr", "price", "val", "value", "cost", "fee", "rate",
  "date", "time", "dt", "day", "birthday", "birth",
  "token", "url", "sign", "signature", "sequence", "otp", "password", "login", "user", "cert",
  "memo", "summary", "remark", "desc", "description", "note",
  "email", "mail", "phone", "mobile", "tel", "addr", "address",
]);

type FieldAccumulator = {
  types: Set<FieldValueType>;
  present: number;
  example: string | null;
  values: Set<string> | null;
};

export function maskShape(text: string) {
  return Array.from(text, (character) => {
    if (/\p{Script=Han}/u.test(character)) return "中";
    if (/\p{N}/u.test(character)) return "9";
    if (/\p{Lu}/u.test(character)) return "A";
    if (/\p{L}/u.test(character)) return "a";
    return character;
  }).join("");
}

function keyWords(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

/** The named key a path's values belong to, or null for positional tuple slots. */
function namingKey(path: string) {
  const match = /\.([^.[\]]+)(?:\[\])*$/u.exec(path);
  return match ? match[1] : null;
}

function enumEligibleKey(path: string) {
  const key = namingKey(path);
  return key !== null && !keyWords(key).some((word) => DENIED_KEY_WORDS.has(word));
}

function typeOf(value: unknown): FieldValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  return type === "string" || type === "number" || type === "boolean" ? type : "object";
}

/**
 * Builds a redacted inventory of every JSON path in `root`. Array elements
 * collapse to `[]`; an array nested directly in an array is a positional
 * tuple (TR001/TR002 rows), so its slots keep their index.
 */
export function inventoryFields(root: unknown): FieldInventory {
  const fields = new Map<string, FieldAccumulator>();
  const containerCounts = new Map<string, number>();
  const parents = new Map<string, string | null>();

  const record = (path: string, parent: string | null, value: unknown) => {
    parents.set(path, parent);
    let field = fields.get(path);
    if (!field) {
      field = { types: new Set(), present: 0, example: null, values: enumEligibleKey(path) ? new Set() : null };
      fields.set(path, field);
    }
    field.present += 1;
    const type = typeOf(value);
    field.types.add(type);
    if (type === "string" || type === "number" || type === "boolean") {
      const text = String(value);
      field.example ??= maskShape(text);
      if (field.values) {
        field.values.add(text);
        if (field.values.size > MAX_ENUM_VALUES || text.length > MAX_ENUM_VALUE_LENGTH || LONG_DIGIT_RUN.test(text)) {
          field.values = null;
        }
      }
    }
  };

  const visit = (value: unknown, path: string, elementOfArray: boolean) => {
    if (Array.isArray(value)) {
      if (elementOfArray) {
        containerCounts.set(path, (containerCounts.get(path) ?? 0) + 1);
        value.forEach((slot, index) => {
          record(`${path}[${index}]`, path, slot);
          visit(slot, `${path}[${index}]`, false);
        });
        return;
      }
      for (const element of value) {
        record(`${path}[]`, null, element);
        visit(element, `${path}[]`, true);
      }
      return;
    }
    if (typeof value === "object" && value !== null) {
      containerCounts.set(path, (containerCounts.get(path) ?? 0) + 1);
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined) continue;
        record(`${path}.${key}`, path, child);
        visit(child, `${path}.${key}`, false);
      }
    }
  };

  record("$", null, root);
  visit(root, "$", false);

  const inventory: Record<string, FieldInventoryEntry> = {};
  for (const [path, field] of [...fields].sort(([left], [right]) => left.localeCompare(right))) {
    const parent = parents.get(path);
    inventory[path] = {
      types: [...field.types].sort(),
      present: field.present,
      total: parent ? containerCounts.get(parent) ?? field.present : field.present,
      example: field.example,
      ...(field.values && field.values.size > 0 ? { values: [...field.values].sort() } : {}),
    };
  }
  return inventory;
}
