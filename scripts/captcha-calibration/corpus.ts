import { appendFile, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CalibrationBank, CaptureMethod } from "./banks.ts";

export const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export type CaptureRecord = Readonly<{
  id: string;
  file: string;
  capturedAt: string;
  width: number;
  height: number;
  sourceMediaType: string;
  method: CaptureMethod;
  declaredLength?: number;
}>;

export type StrategyCandidate = Readonly<{ strategy: string; answer: string; confidence: number }>;

export type Suggestion = Readonly<{
  at: string;
  answer: string;
  candidates: readonly StrategyCandidate[];
  agreementCount: number;
}>;

export type Confirmation =
  | Readonly<{ answer: string; at: string }>
  | Readonly<{ unreadable: true; at: string }>;

export type LabelEntry = Readonly<{ suggested?: Suggestion; confirmed?: Confirmation }>;

export type LabelsFile = Readonly<{
  version: 1;
  bank: CalibrationBank;
  entries: Readonly<Record<string, LabelEntry>>;
}>;

export class CorpusLocationError extends Error {
  constructor(directory: string) {
    super(`Refusing corpus directory inside the repository: ${directory}. CAPTCHA images must stay outside the repo.`);
    this.name = "CorpusLocationError";
  }
}

export function defaultCorpusDirectory(bank: CalibrationBank, home = homedir()): string {
  return join(home, "OctopusBeakCalibration", bank);
}

/** realpath of the nearest existing ancestor, so a directory that does not exist yet still resolves symlinks. */
async function realLocation(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await realLocation(parent), basename(absolute));
  }
}

function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function resolveCorpusDirectory(
  bank: CalibrationBank,
  override: string | undefined,
  options: Readonly<{ home?: string; repositoryRoot?: string }> = {},
): Promise<string> {
  const directory = await realLocation(override ?? defaultCorpusDirectory(bank, options.home));
  const repository = await realLocation(options.repositoryRoot ?? REPOSITORY_ROOT);
  if (isInside(directory, repository)) throw new CorpusLocationError(directory);
  return directory;
}

const CAPTURES = "captures.jsonl";
const LABELS = "labels.json";

export function imagePath(corpusDirectory: string, capture: Pick<CaptureRecord, "file">): string {
  return join(corpusDirectory, capture.file);
}

export async function appendCapture(
  corpusDirectory: string,
  capture: Omit<CaptureRecord, "file">,
  png: Buffer,
): Promise<CaptureRecord> {
  const record: CaptureRecord = { ...capture, file: `images/${capture.id}.png` };
  await mkdir(join(corpusDirectory, "images"), { recursive: true });
  await writeFile(imagePath(corpusDirectory, record), png, { flag: "wx" });
  await appendFile(join(corpusDirectory, CAPTURES), `${JSON.stringify(record)}\n`);
  return record;
}

export async function readCaptures(corpusDirectory: string): Promise<readonly CaptureRecord[]> {
  let text: string;
  try {
    text = await readFile(join(corpusDirectory, CAPTURES), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as CaptureRecord);
}

export async function readLabels(corpusDirectory: string, bank: CalibrationBank): Promise<LabelsFile> {
  let text: string;
  try {
    text = await readFile(join(corpusDirectory, LABELS), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, bank, entries: {} };
    throw error;
  }
  const labels = JSON.parse(text) as LabelsFile;
  if (labels.version !== 1) throw new Error(`Unsupported labels.json version ${String(labels.version)}.`);
  if (labels.bank !== bank) throw new Error(`labels.json belongs to ${labels.bank}, not ${bank}.`);
  return labels;
}

export async function writeLabels(corpusDirectory: string, labels: LabelsFile): Promise<void> {
  await mkdir(corpusDirectory, { recursive: true });
  const target = join(corpusDirectory, LABELS);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(labels, null, 2)}\n`);
  await rename(temporary, target);
}

let labelWrites = Promise.resolve();

/** Read-modify-write under one in-process queue, so the label server and prelabel never interleave writes. */
export function updateLabels(
  corpusDirectory: string,
  bank: CalibrationBank,
  change: (entries: Readonly<Record<string, LabelEntry>>) => Readonly<Record<string, LabelEntry>>,
): Promise<LabelsFile> {
  const next = labelWrites.then(async () => {
    const current = await readLabels(corpusDirectory, bank);
    const updated: LabelsFile = { version: 1, bank, entries: change(current.entries) };
    await writeLabels(corpusDirectory, updated);
    return updated;
  });
  labelWrites = next.then(() => undefined, () => undefined);
  return next;
}

export function withSuggestion(entries: Readonly<Record<string, LabelEntry>>, id: string, suggested: Suggestion) {
  return { ...entries, [id]: { ...entries[id], suggested } };
}

export function withConfirmation(entries: Readonly<Record<string, LabelEntry>>, id: string, confirmed: Confirmation) {
  return { ...entries, [id]: { ...entries[id], confirmed } };
}
