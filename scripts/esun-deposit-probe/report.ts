export type FieldValueType = "string" | "number" | "boolean" | "null" | "object" | "array";

/** Fixed labels that describe a primitive's form without carrying any of its characters. */
export type ValueForm =
  | "empty" | "code" | "digits" | "decimal" | "decimal-grouped" | "masked"
  | "date-slash" | "date-dash" | "date-time" | "clock" | "han-text" | "text"
  | "integer" | "integer-negative" | "fraction" | "fraction-negative" | "boolean";

export type FieldShape = Readonly<{
  types: readonly FieldValueType[];
  present: number;
  of: number;
  forms?: readonly ValueForm[];
  length?: readonly [number, number];
  items?: readonly [number, number];
  values?: readonly string[];
}>;

export type FieldInventory = Readonly<Record<string, FieldShape>>;

const MAX_DISTINCT_VALUES = 12;
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const LONG_DIGIT_RUN = /\d{4,}/u;
export const MASKED_KEY = "{key}";

/** Short upper-case codes such as TWD, S001, or 01. Nothing lower-case, spaced, or non-ASCII. */
const CODE_VALUE = /^[A-Z0-9][A-Z0-9_-]{0,11}$/u;
const RESULT_CODE = /^(?:[A-Z]{0,2}\d{1,4}|[A-Z]{1,4})$/u;
export const WITHHELD = "withheld";

const DENIED_KEY_WORDS = new Set([
  "id", "no", "num", "number", "acct", "acc", "account", "accounts", "alias", "ser", "serno",
  "name", "nm", "owner", "cust", "customer", "holder", "payee", "payer", "counterparty",
  "amt", "amount", "bal", "balance", "price", "val", "value", "fee", "rate", "total",
  "date", "time", "dt", "day", "birthday",
  "token", "key", "uuid", "url", "sign", "otp", "password", "user", "cert",
  "memo", "summary", "remark", "desc", "description", "note", "title", "hashtag", "message", "msg",
  "email", "mail", "phone", "mobile", "tel", "addr", "address",
]);
const CODE_KEY_WORDS = new Set(["type", "code", "kind", "status", "flag", "currency", "cur", "ccy", "category", "credit", "debit"]);

function keyWords(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

/** `accountType` may list codes although `account` alone may not. */
function enumerableKey(key: string) {
  if (key === MASKED_KEY) return false;
  const words = keyWords(key);
  if (words.length === 0) return false;
  return CODE_KEY_WORDS.has(words.at(-1) ?? "") || !words.some((word) => DENIED_KEY_WORDS.has(word));
}

export function safeKey(key: string) {
  return SAFE_KEY.test(key) && !LONG_DIGIT_RUN.test(key) ? key : MASKED_KEY;
}

export function safeResultCode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && RESULT_CODE.test(value) ? value : WITHHELD;
}

/** Portal module codes such as `ctw01002` keep their five digits; account numbers and dates do not survive. */
function safePathSegment(segment: string) {
  if (segment === "") return true;
  return /^[A-Za-z0-9._-]{1,64}$/u.test(segment) && !/\d{6,}/u.test(segment) && !/^\d{4,}$/u.test(segment);
}

export function safeRequestPath(pathname: string) {
  return pathname.split("/").map((segment) => (safePathSegment(segment) ? segment : "{segment}")).join("/");
}

function typeOf(value: unknown): FieldValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  return type === "string" || type === "number" || type === "boolean" ? type : "object";
}

function stringForm(text: string): ValueForm {
  if (text === "") return "empty";
  if (/^\d{4}\/\d{2}\/\d{2}$/u.test(text)) return "date-slash";
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return "date-dash";
  if (/^\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}/u.test(text)) return "date-time";
  if (/^\d{2}:\d{2}(?::\d{2})?$/u.test(text)) return "clock";
  if (/^\d+$/u.test(text)) return CODE_VALUE.test(text) && !LONG_DIGIT_RUN.test(text) ? "code" : "digits";
  if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(text)) return "decimal-grouped";
  if (/^[+-]?\d+(?:\.\d+)?$/u.test(text)) return "decimal";
  if (/[*＊]/u.test(text)) return "masked";
  if (CODE_VALUE.test(text) && !LONG_DIGIT_RUN.test(text)) return "code";
  if (/\p{Script=Han}/u.test(text)) return "han-text";
  return "text";
}

function numberForm(value: number): ValueForm {
  const integral = Number.isInteger(value);
  if (value < 0) return integral ? "integer-negative" : "fraction-negative";
  return integral ? "integer" : "fraction";
}

type Accumulator = {
  types: Set<FieldValueType>;
  present: number;
  forms: Set<ValueForm>;
  length: [number, number] | null;
  items: [number, number] | null;
  values: Set<string> | null;
};

function widen(range: [number, number] | null, size: number): [number, number] {
  return range ? [Math.min(range[0], size), Math.max(range[1], size)] : [size, size];
}

/**
 * Describes every JSON path in `root` by type, form, length, and array size.
 * Keys that are not plain identifiers collapse to `{key}`, array elements
 * collapse to `[]`, and distinct values appear only for code-named keys whose
 * every value is a short upper-case code without a four-digit run.
 */
export function inventoryFields(root: unknown): FieldInventory {
  const fields = new Map<string, Accumulator>();
  const containers = new Map<string, number>();
  const parents = new Map<string, string | null>();

  const record = (path: string, parent: string | null, key: string | null, value: unknown) => {
    parents.set(path, parent);
    let field = fields.get(path);
    if (!field) {
      field = {
        types: new Set(),
        present: 0,
        forms: new Set(),
        length: null,
        items: null,
        values: key !== null && enumerableKey(key) ? new Set() : null,
      };
      fields.set(path, field);
    }
    field.present += 1;
    const type = typeOf(value);
    field.types.add(type);
    if (type === "array") field.items = widen(field.items, (value as unknown[]).length);
    if (type === "boolean") {
      field.forms.add("boolean");
      field.values?.add(String(value));
    }
    if (type === "number") {
      field.forms.add(numberForm(value as number));
      field.values = null;
    }
    if (type === "string") {
      const text = value as string;
      field.forms.add(stringForm(text));
      field.length = widen(field.length, Array.from(text).length);
      if (field.values) {
        if (CODE_VALUE.test(text) && !LONG_DIGIT_RUN.test(text)) field.values.add(text);
        else field.values = null;
      }
    }
    if (field.values && field.values.size > MAX_DISTINCT_VALUES) field.values = null;
  };

  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      for (const element of value) {
        record(`${path}[]`, null, null, element);
        visit(element, `${path}[]`);
      }
      return;
    }
    if (typeof value === "object" && value !== null) {
      containers.set(path, (containers.get(path) ?? 0) + 1);
      for (const [rawKey, child] of Object.entries(value)) {
        if (child === undefined) continue;
        const key = safeKey(rawKey);
        record(`${path}.${key}`, path, key, child);
        visit(child, `${path}.${key}`);
      }
    }
  };

  record("$", null, null, root);
  visit(root, "$");

  const inventory: Record<string, FieldShape> = {};
  for (const [path, field] of [...fields].sort(([left], [right]) => left.localeCompare(right))) {
    const parent = parents.get(path);
    inventory[path] = {
      types: [...field.types].sort(),
      present: field.present,
      of: parent ? containers.get(parent) ?? field.present : field.present,
      ...(field.forms.size > 0 ? { forms: [...field.forms].sort() } : {}),
      ...(field.length ? { length: field.length } : {}),
      ...(field.items ? { items: field.items } : {}),
      ...(field.values && field.values.size > 0 ? { values: [...field.values].sort() } : {}),
    };
  }
  return inventory;
}
