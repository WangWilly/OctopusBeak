import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import {
  CALENDAR_MODULE,
  GovernmentCalendarLayoutError,
  parseGovernmentCalendar,
  renderCalendarYear,
} from "./generate-yuanta-settlement-calendar.mjs";

const OFF_FILL = "FFFF99FF";
const SECOND_FILL = "FFCCFFCC";
const MONTH_NAMES = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

/** A stored-and-deflated zip, enough to carry an .xlsx package. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const packed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const column = (index) => {
  let name = "";
  for (let value = index; value > 0; value = Math.floor((value - 1) / 26))
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
};

/**
 * Lays a year out the way the DGPA sheet does: four quarter blocks, each a
 * month-name row, a weekday row, then six weeks of a day row over a lunar row,
 * three months side by side from columns B, I and P.
 */
function calendarSheet(year, { offDays = new Set(), workdays = new Set(), title, edit = (cells) => cells } = {}) {
  const cells = new Map();
  const put = (row, col, value, off = false, date = undefined) => cells.set(`${row},${col}`, { value, off, date });
  put(2, 2, title ?? `中華民國${year - 1911}年（西元${year}年）政府行政機關辦公日曆表`);
  for (let block = 0; block < 4; block += 1) {
    const header = 3 + block * 14;
    for (let slot = 0; slot < 3; slot += 1) {
      const start = 2 + slot * 7;
      const month = block * 3 + slot + 1;
      put(header, start + 2, MONTH_NAMES[month - 1]);
      put(header, start + 4, "月");
      WEEKDAY_NAMES.forEach((name, offset) => put(header + 1, start + offset, name));
      const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      for (let day = 1; day <= days; day += 1) {
        const position = first + day - 1;
        const row = header + 2 + Math.floor(position / 7) * 2;
        const weekday = position % 7;
        const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const weekend = weekday === 0 || weekday === 6;
        const off = workdays.has(iso) ? false : weekend || offDays.has(iso);
        put(row, start + weekday, String(day), off, iso);
        put(row + 1, start + weekday, "初一", off);
      }
    }
  }
  edit(cells);
  const strings = [];
  const index = (value) => {
    const found = strings.indexOf(value);
    if (found >= 0) return found;
    strings.push(value);
    return strings.length - 1;
  };
  const rows = new Map();
  for (const [key, cell] of cells) {
    const [row, col] = key.split(",").map(Number);
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push([col, cell]);
  }
  const sheetRows = [...rows.keys()].sort((left, right) => left - right).map((row) =>
    `<row r="${row}">${rows.get(row).sort(([left], [right]) => left - right).map(([col, cell]) =>
      /^\d+$/u.test(cell.value)
        ? `<c r="${column(col)}${row}" s="${cell.style ?? (cell.off ? 1 : 0)}"><v>${cell.value}</v></c>`
        : `<c r="${column(col)}${row}" s="${cell.style ?? (cell.off ? 1 : 0)}" t="s"><v>${index(cell.value)}</v></c>`).join("")}</row>`);
  return zip({
    "xl/workbook.xml": `<workbook><sheets><sheet name="calendar" sheetId="1"/></sheets></workbook>`,
    "xl/sharedStrings.xml": `<sst>${strings.map((value) => `<si><t>${value}</t><rPh sb="0" eb="1"><t>ㄅ</t></rPh></si>`).join("")}</sst>`,
    "xl/styles.xml": `<styleSheet><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="${OFF_FILL}"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="${SECOND_FILL}"/><bgColor indexed="64"/></patternFill></fill></fills><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="0" fontId="0" fillId="2" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="3" applyFill="1"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${sheetRows.join("")}</sheetData></worksheet>`,
  });
}

const findDay = (cells, date) => [...cells.entries()].find(([, cell]) => cell.date === date);

test("the generator reads weekday closures and Saturday make-up workdays from the sheet", () => {
  const sheet = calendarSheet(2030, {
    offDays: new Set(["2030-01-01", "2030-02-04", "2030-10-10"]),
    workdays: new Set(["2030-02-16"]),
    edit: (cells) => {
      // The 116年 sheet spells one weekday header with the compatibility ideograph U+F9D1.
      cells.get("4,8").value = "\uF9D1";
    },
  });
  const year = parseGovernmentCalendar(sheet, 2030);
  assert.equal(year.year, 2030);
  assert.deepEqual(year.closures, ["2030-01-01", "2030-02-04", "2030-10-10"]);
  assert.deepEqual(year.workdays, ["2030-02-16"]);
  assert.match(year.sourceSha256, /^[0-9a-f]{64}$/u);
});

test("the generator refuses a day whose grid column is not its weekday", () => {
  const sheet = calendarSheet(2030, {
    edit: (cells) => {
      // 2030-03-05 is a Tuesday; move it into the Wednesday column.
      const [key, cell] = findDay(cells, "2030-03-05");
      const [row, col] = key.split(",").map(Number);
      cells.delete(key);
      cells.set(`${row},${col + 1}`, cell);
    },
  });
  assert.throws(() => parseGovernmentCalendar(sheet, 2030), (error) =>
    error instanceof GovernmentCalendarLayoutError && /weekday/u.test(error.message));
});

test("the generator refuses a sheet for another year or with a missing day", () => {
  assert.throws(() => parseGovernmentCalendar(calendarSheet(2030), 2031), GovernmentCalendarLayoutError);
  const missing = calendarSheet(2030, { edit: (cells) => cells.delete(findDay(cells, "2030-12-31")[0]) });
  assert.throws(() => parseGovernmentCalendar(missing, 2030), (error) =>
    error instanceof GovernmentCalendarLayoutError && /2030-12/u.test(error.message));
});

test("the generator refuses a sheet whose day-off marking it cannot identify", () => {
  const unmarked = calendarSheet(2030, {
    edit: (cells) => {
      for (const cell of cells.values()) cell.off = false;
    },
  });
  assert.throws(() => parseGovernmentCalendar(unmarked, 2030), GovernmentCalendarLayoutError);
  const sundayWorkday = calendarSheet(2030, { workdays: new Set(["2030-02-17"]) });
  assert.throws(() => parseGovernmentCalendar(sundayWorkday, 2030), GovernmentCalendarLayoutError);
  assert.throws(() => parseGovernmentCalendar(Buffer.from("not a zip"), 2030), GovernmentCalendarLayoutError);
});

test("the generator refuses a day marked with a second fill", () => {
  const sheet = calendarSheet(2030, {
    edit: (cells) => {
      findDay(cells, "2030-04-04")[1].style = 2;
    },
  });
  assert.throws(() => parseGovernmentCalendar(sheet, 2030), (error) =>
    error instanceof GovernmentCalendarLayoutError && /2030-04-04 has fill solid:FFCCFFCC/u.test(error.message));
});

test("the generator refuses a sheet without four aligned quarter blocks or with a wrong month label", () => {
  const threeBlocks = calendarSheet(2030, {
    edit: (cells) => {
      for (const key of [...cells.keys()]) if (key.startsWith("18,")) cells.delete(key);
    },
  });
  assert.throws(() => parseGovernmentCalendar(threeBlocks, 2030), (error) =>
    error instanceof GovernmentCalendarLayoutError && /four quarter blocks, found 3/u.test(error.message));
  const misaligned = calendarSheet(2030, { edit: (cells) => cells.delete("18,2") });
  assert.throws(() => parseGovernmentCalendar(misaligned, 2030), (error) =>
    error instanceof GovernmentCalendarLayoutError && /three months in the same columns/u.test(error.message));
  const relabelled = calendarSheet(2030, {
    edit: (cells) => {
      cells.get("3,4").value = "二";
    },
  });
  assert.throws(() => parseGovernmentCalendar(relabelled, 2030), (error) =>
    error instanceof GovernmentCalendarLayoutError && /labelled 「二月」, not 一月/u.test(error.message));
});

test("the generator reproduces the committed 2026 and 2027 calendar from the DGPA files", () => {
  const source = readFileSync(CALENDAR_MODULE, "utf8");
  let regenerated = source;
  for (const [file, year] of [["dgpa-115.xlsx", 2026], ["dgpa-116.xlsx", 2027]])
    regenerated = renderCalendarYear(regenerated, parseGovernmentCalendar(
      readFileSync(new URL(`./fixtures/dgpa/${file}`, import.meta.url)),
      year,
    ));
  assert.equal(regenerated, source);
});

test("rendering appends the next year deterministically and refuses a gap", () => {
  const source = readFileSync(CALENDAR_MODULE, "utf8");
  const next = parseGovernmentCalendar(calendarSheet(2028, {
    offDays: new Set(["2028-01-03"]),
    workdays: new Set(["2028-01-22"]),
  }), 2028);
  const appended = renderCalendarYear(source, next);
  assert.equal(renderCalendarYear(appended, next), appended, "rendering is idempotent");
  assert.match(appended, /"2028": \{\n {4}"sourceSha256": "[0-9a-f]{64}",\n {4}"closures": \[\n {6}"2028-01-03"\n {4}\],\n {4}"workdays": \[\n {6}"2028-01-22"\n {4}\]\n {2}\}\n\};/u);
  assert.ok(appended.indexOf('"2027"') < appended.indexOf('"2028"'));
  const gap = parseGovernmentCalendar(calendarSheet(2030), 2030);
  assert.throws(() => renderCalendarYear(source, gap), /contiguous|2028/u);
});
