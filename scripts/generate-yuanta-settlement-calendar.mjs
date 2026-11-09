#!/usr/bin/env node
/**
 * Rewrite one year of the Yuanta settlement calendar from the DGPA
 * 政府行政機關辦公日曆表 .xlsx. See docs/runbooks/yuanta-settlement-calendar.md.
 *
 *   npm run generate:yuanta-settlement-calendar -- <year> <xlsx path or https URL>
 *
 * The sheet is read by layout, and anything the reader does not recognise is
 * refused: a wrong calendar silently pairs trades with the wrong bank debit.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";

export const CALENDAR_MODULE = new URL(
  "../src/ledger/canonical/yuanta-foreign-settlement-calendar.ts",
  import.meta.url,
);

export class GovernmentCalendarLayoutError extends Error {
  name = "GovernmentCalendarLayoutError";
}

const refuse = (message) => {
  throw new GovernmentCalendarLayoutError(message);
};

/* ---------------------------------------------------------------- zip --- */

function unzip(buffer) {
  const minimum = Math.max(0, buffer.length - 0xffff - 22);
  let end = -1;
  for (let index = buffer.length - 22; index >= minimum; index -= 1)
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  if (end < 0) refuse("The calendar file is not an .xlsx (zip) package.");
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) refuse("The .xlsx central directory is malformed.");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const packedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) refuse(`The .xlsx entry ${name} is encrypted.`);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) refuse(`The .xlsx entry ${name} has no local header.`);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const packed = buffer.subarray(dataStart, dataStart + packedSize);
    let data;
    if (method === 0) data = packed;
    else if (method === 8) data = inflateRawSync(packed);
    else refuse(`The .xlsx entry ${name} uses unsupported compression ${method}.`);
    if (crc32(data) !== checksum) refuse(`The .xlsx entry ${name} fails its checksum.`);
    entries.set(name, data.toString("utf8"));
  }
  return entries;
}

/* ---------------------------------------------------------------- xml --- */

function decode(text) {
  return text
    .replaceAll(/&#x([0-9a-f]+);/giu, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replaceAll(/&#(\d+);/gu, (_match, digits) => String.fromCodePoint(Number(digits)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

const attribute = (attributes, name) =>
  new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "u").exec(attributes)?.[1];

const runText = (xml) =>
  decode([...xml.replaceAll(/<rPh\b[\s\S]*?<\/rPh>/gu, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)]
    .map((match) => match[1]).join(""));

function cellFills(styles) {
  const fillsXml = /<fills\b[^>]*>([\s\S]*?)<\/fills>/u.exec(styles)?.[1];
  const xfsXml = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/u.exec(styles)?.[1];
  if (fillsXml === undefined || xfsXml === undefined) refuse("The .xlsx styles have no fills or cell formats.");
  const fills = [...fillsXml.matchAll(/<fill\b[^>]*?(?:\/>|>([\s\S]*?)<\/fill>)/gu)].map((match) => {
    const body = match[1] ?? "";
    const pattern = attribute(/<patternFill\b([^>]*)/u.exec(body)?.[1] ?? "", "patternType") ?? "none";
    const color = /<fgColor\b([^>]*)/u.exec(body)?.[1] ?? "";
    return pattern === "none"
      ? "none"
      : `${pattern}:${["rgb", "theme", "indexed", "tint"].map((name) => attribute(color, name) ?? "").join("/")}`;
  });
  return [...xfsXml.matchAll(/<xf\b([^>]*)/gu)].map((match) => fills[Number(attribute(match[1], "fillId") ?? 0)] ?? "none");
}

function columnNumber(letters) {
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return value;
}

function readWorksheet(buffer) {
  const entries = unzip(buffer);
  const sheets = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name));
  if (sheets.length !== 1) refuse(`Expected one worksheet, found ${sheets.length}.`);
  const styles = entries.get("xl/styles.xml") ?? refuse("The .xlsx has no styles.");
  const strings = [...(entries.get("xl/sharedStrings.xml") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu)]
    .map((match) => runText(match[1]));
  const fills = cellFills(styles);
  const cells = [];
  for (const match of entries.get(sheets[0]).matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
    const reference = /^([A-Z]+)(\d+)$/u.exec(attribute(match[1], "r") ?? "") ?? refuse("A worksheet cell has no reference.");
    const type = attribute(match[1], "t");
    const body = match[2] ?? "";
    const raw = /<v>([\s\S]*?)<\/v>/u.exec(body)?.[1];
    const value = type === "s"
      ? strings[Number(raw)] ?? refuse(`Cell ${reference[0]} names a missing shared string.`)
      : type === "inlineStr" ? runText(body) : decode(raw ?? "");
    cells.push({
      row: Number(reference[2]),
      col: columnNumber(reference[1]),
      // DGPA sheets mix compatibility ideographs in (2027's January 六 is U+F9D1).
      value: value.normalize("NFKC").trim(),
      fill: fills[Number(attribute(match[1], "s") ?? 0)] ?? refuse(`Cell ${reference[0]} names a missing style.`),
    });
  }
  return cells;
}

/* ----------------------------------------------------------- calendar --- */

const MONTH_NAMES = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
const WEEKDAY_HEADER = "日一二三四五六";
const iso = (year, month, day) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/**
 * Read one year: four quarter blocks under a weekday header row, three months
 * side by side, filled cells for days off. Every day must sit in its weekday's
 * column, every month must be complete, and all Sundays must share one fill.
 */
export function parseGovernmentCalendar(buffer, year) {
  const cells = readWorksheet(buffer);
  const titles = cells.filter((cell) => /\(西元\d{4}年\).*辦公日曆表/u.test(cell.value));
  if (titles.length !== 1) refuse("The sheet has no single 「（西元YYYY年）…辦公日曆表」 title.");
  const titleYear = Number(/\(西元(\d{4})年\)/u.exec(titles[0].value)[1]);
  if (titleYear !== year) refuse(`The sheet is the ${titleYear} calendar, not ${year}.`);

  const byRow = new Map();
  for (const cell of cells) {
    if (!byRow.has(cell.row)) byRow.set(cell.row, new Map());
    byRow.get(cell.row).set(cell.col, cell);
  }
  const headers = [...byRow.keys()].sort((left, right) => left - right).flatMap((row) => {
    const columns = byRow.get(row);
    const starts = [...columns.keys()].filter((col) =>
      [...WEEKDAY_HEADER].every((name, offset) => columns.get(col + offset)?.value === name));
    return starts.length > 0 ? [{ row, starts }] : [];
  });
  if (headers.length !== 4) refuse(`Expected four quarter blocks, found ${headers.length} weekday header rows.`);
  const starts = headers[0].starts;
  if (starts.length !== 3 || headers.some((header) => header.starts.join() !== starts.join()))
    refuse("Each quarter block must hold three months in the same columns.");

  const lastRow = Math.max(...byRow.keys());
  const days = [];
  for (const [block, header] of headers.entries()) {
    const endRow = block < 3 ? headers[block + 1].row - 2 : lastRow;
    for (const [slot, start] of starts.entries()) {
      const month = block * 3 + slot + 1;
      const label = [...(byRow.get(header.row - 1)?.values() ?? [])]
        .filter((cell) => cell.col >= start && cell.col < start + 7)
        .sort((left, right) => left.col - right.col)
        .map((cell) => cell.value).join("");
      if (label !== `${MONTH_NAMES[month - 1]}月`)
        refuse(`Block ${block + 1} column ${start} is labelled 「${label}」, not ${MONTH_NAMES[month - 1]}月.`);
      const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const seen = new Set();
      for (let row = header.row + 1; row <= endRow; row += 1)
        for (let col = start; col < start + 7; col += 1) {
          const cell = byRow.get(row)?.get(col);
          if (!cell || !/^\d{1,2}$/u.test(cell.value)) continue;
          const day = Number(cell.value);
          const date = iso(year, month, day);
          if (day < 1 || day > length) refuse(`${iso(year, month, 1).slice(0, 7)} has no day ${day}.`);
          if (seen.has(day)) refuse(`${date} appears twice.`);
          const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
          if (col - start !== weekday)
            refuse(`${date} sits in the ${WEEKDAY_HEADER[col - start]} column, but its weekday is ${WEEKDAY_HEADER[weekday]}.`);
          seen.add(day);
          days.push({ date, weekday, fill: cell.fill });
        }
      if (seen.size !== length) {
        const missing = Array.from({ length }, (_value, index) => index + 1).filter((day) => !seen.has(day));
        refuse(`${iso(year, month, 1).slice(0, 7)} is missing day ${missing.join(", ")}.`);
      }
    }
  }

  const sundayFills = new Set(days.filter((day) => day.weekday === 0).map((day) => day.fill));
  if (sundayFills.size !== 1) refuse("Sundays do not share one day-off fill.");
  const offFill = [...sundayFills][0];
  if (offFill === "none") refuse("Sundays are not filled, so the sheet's day-off marking is unknown.");
  const weekdays = days.filter((day) => day.weekday >= 1 && day.weekday <= 5);
  const closures = weekdays.filter((day) => day.fill === offFill).map((day) => day.date).sort();
  if (weekdays.length - closures.length < 200)
    refuse(`Only ${weekdays.length - closures.length} weekdays are open; the day-off fill is not recognised.`);
  const workdays = days.filter((day) => day.weekday === 6 && day.fill !== offFill).map((day) => day.date).sort();
  return {
    year,
    sourceSha256: createHash("sha256").update(buffer).digest("hex"),
    closures,
    workdays,
  };
}

/* ------------------------------------------------------------- render --- */

const BEGIN = "// BEGIN GENERATED by `npm run generate:yuanta-settlement-calendar`; do not edit by hand.\n";
const END = "// END GENERATED\n";
const DECLARATION = "const TAIWAN_GOVERNMENT_CALENDAR: Readonly<Record<string, CalendarYear>> = ";

function dateList(dates) {
  if (dates.length === 0) return "[]";
  const lines = [];
  for (let index = 0; index < dates.length; index += 5)
    lines.push(`      ${dates.slice(index, index + 5).map((date) => JSON.stringify(date)).join(", ")}`);
  return `[\n${lines.join(",\n")}\n    ]`;
}

/** Replace or append `entry`'s year in the calendar module's generated block. */
export function renderCalendarYear(source, entry) {
  const begin = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (begin < 0 || end < begin) throw new Error("The calendar module has no generated block.");
  const block = source.slice(begin + BEGIN.length, end);
  if (!block.startsWith(DECLARATION) || !block.trimEnd().endsWith(";"))
    throw new Error("The calendar module's generated block is not the expected declaration.");
  const years = JSON.parse(block.slice(DECLARATION.length, block.trimEnd().length - 1));
  years[String(entry.year)] = { sourceSha256: entry.sourceSha256, closures: entry.closures, workdays: entry.workdays };
  const ordered = Object.keys(years).map(Number).sort((left, right) => left - right);
  for (const [index, year] of ordered.entries())
    if (index > 0 && year !== ordered[index - 1] + 1)
      throw new Error(`Calendar years must be contiguous; ${entry.year} leaves a gap after ${ordered[index - 1]}.`);
  const body = ordered.map((year) => {
    const value = years[String(year)];
    return [
      `  "${year}": {`,
      `    "sourceSha256": ${JSON.stringify(value.sourceSha256)},`,
      `    "closures": ${dateList(value.closures)},`,
      `    "workdays": ${dateList(value.workdays)}`,
      "  }",
    ].join("\n");
  }).join(",\n");
  return `${source.slice(0, begin)}${BEGIN}${DECLARATION}{\n${body}\n};\n${source.slice(end)}`;
}

/* ---------------------------------------------------------------- cli --- */

async function readSource(location) {
  if (/^https:\/\//u.test(location)) {
    const response = await fetch(location);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${location}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return readFileSync(location);
}

async function main([yearArgument, location]) {
  const year = Number(yearArgument);
  if (!Number.isInteger(year) || year < 2000 || !location)
    throw new Error("Usage: npm run generate:yuanta-settlement-calendar -- <year> <xlsx path or https URL>");
  const entry = parseGovernmentCalendar(await readSource(location), year);
  const source = readFileSync(CALENDAR_MODULE, "utf8");
  const next = renderCalendarYear(source, entry);
  writeFileSync(CALENDAR_MODULE, next);
  console.log(`${year}: ${entry.closures.length} weekday closures, ${entry.workdays.length} make-up workdays, sha256 ${entry.sourceSha256}`);
  console.log(next === source ? "Calendar unchanged." : `Updated ${fileURLToPath(CALENDAR_MODULE)}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2)).catch((error) => {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
