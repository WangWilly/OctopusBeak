import type { Translation } from "../i18n/i18n.ts";
import {
  ManualAssetRejected,
  parseManualAssetCommand,
  type ManualAssetCommand,
} from "./manual-assets.ts";

/**
 * Runs the boundary parser in the renderer so a form can name the field
 * that is wrong before anything is sent. The worker parses again.
 */
export function checkedCommand(input: unknown, dictionary: Translation):
  | Readonly<{ ok: true; command: ManualAssetCommand }>
  | Readonly<{ ok: false; message: string }> {
  try {
    return { ok: true, command: parseManualAssetCommand(input) };
  } catch (error) {
    if (!(error instanceof ManualAssetRejected)) throw error;
    return { ok: false, message: fieldMessage(error.message, dictionary) };
  }
}

function fieldMessage(reason: string, dictionary: Translation): string {
  const copy = dictionary.manualAssets.invalid;
  if (reason.startsWith("name")) return copy.name;
  if (reason.startsWith("currency")) return copy.currency;
  if (reason.includes("not positive")) return copy.positive;
  if (reason.includes("amount")) return copy.amount;
  if (reason.includes("date")) return copy.date;
  return dictionary.manualAssets.failed;
}

/** Sends one command; resolves to an error message, or null once it is saved. */
export async function sendCommand(command: ManualAssetCommand, dictionary: Translation): Promise<string | null> {
  try {
    await window.octopusBeak.manualAssets.apply(command);
    return null;
  } catch {
    return dictionary.manualAssets.failed;
  }
}
