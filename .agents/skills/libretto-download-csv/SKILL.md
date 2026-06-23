---
name: libretto-download-csv
description: Add automatic CSV conversion to Libretto browser automation workflows after downloads. Use when creating or editing a workflow that downloads XLS, XLSX, Excel-labeled HTML tables, TXT/CSV-like statement files, bank statements, loan statements, reports, or other tabular exports and the user wants future runs to save CSV output automatically.
---

# Libretto Download CSV

## Workflow

Use this skill together with the repo's `libretto` skill when editing production workflow files. Keep the browser automation behavior unchanged unless conversion requires a different download format.

1. Identify the download function and output schema.
2. Preserve the original downloaded file path and byte count unless the user explicitly asks to replace it.
3. Add CSV output next to the downloaded file, using the same base path with a `.csv` extension.
4. Return CSV metadata from the workflow result, usually `csvPath` and `csvBytes`.
5. Run `npm run typecheck`.
6. If possible, validate the converter with a local sample file without replaying authenticated browser steps.

## Excel Downloads

Prefer an existing spreadsheet parser dependency if one is already installed. In this repo, use `xlsx` for `.xls`, `.xlsx`, and `.xls` files that are actually HTML tables.

Use default import in this ESM/NodeNext project:

```ts
import XLSX from "xlsx";
```

Avoid `import * as XLSX from "xlsx"` here because runtime access to `readFile` fails under this project's ESM execution.

Use this helper shape:

```ts
function csvPathFor(path: string): string {
  const csvPath = path.replace(/\.[^/.]+$/, ".csv");
  return csvPath === path ? `${path}.csv` : csvPath;
}

async function convertXlsToCsv(path: string) {
  const workbook = XLSX.readFile(path);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error(`Downloaded Excel file has no worksheets: ${path}`);
  }

  const worksheet = workbook.Sheets[sheetName];
  const csv = XLSX.utils.sheet_to_csv(worksheet);
  const csvPath = csvPathFor(path);
  await writeFile(csvPath, csv.endsWith("\n") ? csv : `${csv}\n`, "utf8");

  const csvStat = await stat(csvPath);
  return { csvPath, csvBytes: csvStat.size };
}
```

Call it only for Excel download formats unless the user asks for CSV conversion of every format:

```ts
const fileStat = await stat(path);
const converted =
  downloadFormat === "EXCEL" ? await convertXlsToCsv(path) : undefined;
return { filename, path, bytes: fileStat.size, ...converted };
```

Update the Zod output schema with optional CSV fields so non-Excel formats remain valid:

```ts
csvPath: z.string().optional(),
csvBytes: z.number().int().nonnegative().optional(),
```

## Plain Text Or CSV-Like Downloads

When the site downloads TXT or CSV-like data instead of Excel, do not add `xlsx` just to rewrite text. Read the file as text, normalize line endings if useful, and write a `.csv` sibling file with explicit UTF-8 encoding. Preserve the original file metadata and add `csvPath/csvBytes`.

## Dependency Notes

If `xlsx` is not installed and Excel parsing is required, add it to `dependencies` and update the lockfile with the repo's package manager. Mention any audit findings in the final response, especially when the parser has no patched npm release.
