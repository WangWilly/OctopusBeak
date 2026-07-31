import {
  parseFragment,
  type DefaultTreeAdapterTypes,
} from "parse5";

const MAX_TABULAR_TEXT_LENGTH = 16 * 1024 * 1024;

type HtmlElement = DefaultTreeAdapterTypes.Element;
type HtmlNode = DefaultTreeAdapterTypes.Node;

function assertSafeInputLength(content: string): void {
  if (content.length > MAX_TABULAR_TEXT_LENGTH) {
    throw new Error("Tabular text exceeds the 16 MiB safety limit.");
  }
}

function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function descendantsByTag(node: HtmlNode, tagName: string): HtmlElement[] {
  const elements: HtmlElement[] = [];
  if (!("childNodes" in node)) return elements;
  for (const child of node.childNodes) {
    if (isElement(child) && child.tagName === tagName) elements.push(child);
    elements.push(...descendantsByTag(child, tagName));
  }
  return elements;
}

function tableRows(table: HtmlElement): HtmlElement[] {
  const rows: HtmlElement[] = [];

  function visit(node: HtmlNode): void {
    if (!("childNodes" in node)) return;
    for (const child of node.childNodes) {
      if (!isElement(child)) continue;
      if (child.tagName === "table") continue;
      if (child.tagName === "tr") {
        rows.push(child);
        continue;
      }
      visit(child);
    }
  }

  visit(table);
  return rows;
}

function htmlNodeText(node: HtmlNode): string {
  if ("value" in node) return node.value;
  if (!("childNodes" in node)) return "";
  if (isElement(node) && node.tagName === "br") return "\n";
  const text = node.childNodes.map(htmlNodeText).join("");
  return isElement(node) && /^(?:div|li|p)$/.test(node.tagName)
    ? `${text} `
    : text;
}

function spanValue(
  element: HtmlElement,
  name: "colspan" | "rowspan",
): number {
  const value = Number(
    element.attrs.find((attribute) => attribute.name === name)?.value ?? "1",
  );
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function parseHtmlTableMatrices(content: string): string[][][] {
  assertSafeInputLength(content);
  const tables: string[][][] = [];
  const document = parseFragment(content);

  for (const table of descendantsByTag(document, "table")) {
    const rows: string[][] = [];
    const rowSpans: number[] = [];

    for (const tableRow of tableRows(table)) {
      const row: string[] = [];
      for (let column = 0; column < rowSpans.length; column += 1) {
        if ((rowSpans[column] ?? 0) <= 0) continue;
        row[column] = "";
        rowSpans[column] -= 1;
      }

      let column = 0;
      const cells = tableRow.childNodes.filter(
        (node): node is HtmlElement =>
          isElement(node) && (node.tagName === "td" || node.tagName === "th"),
      );
      for (const cell of cells) {
        while (row[column] !== undefined) column += 1;

        const colspan = spanValue(cell, "colspan");
        const rowspan = spanValue(cell, "rowspan");
        row[column] = htmlNodeText(cell);
        for (let offset = 1; offset < colspan; offset += 1) {
          row[column + offset] = "";
        }
        if (rowspan > 1) {
          for (let offset = 0; offset < colspan; offset += 1) {
            rowSpans[column + offset] = rowspan - 1;
          }
        }
        column += colspan;
      }

      if (row.some((cell) => cell !== "")) rows.push(row);
    }

    if (rows.length > 0) tables.push(rows);
  }

  return tables;
}

export function parseCsvMatrix(content: string): string[][] {
  assertSafeInputLength(content);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const nextChar = content[index + 1];

    if (quoted) {
      if (char === '"' && nextChar === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}
