import type { Translation } from "../i18n/i18n.ts";
import {
  assertNotFuture,
  ManualAssetRejected,
  parseManualAssetCommand,
  type ManualAssetCommand,
  type ManualAssetRejectionCode,
} from "./manual-assets.ts";

export function rejectionMessage(code: ManualAssetRejectionCode, dictionary: Translation): string {
  return dictionary.manualAssets.rejections[code];
}

/**
 * Runs the boundary rules in the renderer so a form can say what is wrong
 * before anything is sent. The worker applies them again.
 */
export function checkedCommand(input: unknown, today: string, dictionary: Translation):
  | Readonly<{ ok: true; command: ManualAssetCommand }>
  | Readonly<{ ok: false; message: string }> {
  try {
    const command = parseManualAssetCommand(input);
    assertNotFuture(command, today);
    return { ok: true, command };
  } catch (error) {
    if (!(error instanceof ManualAssetRejected)) throw error;
    return { ok: false, message: rejectionMessage(error.code, dictionary) };
  }
}

/** Sends one command; resolves to an error message, or null once it is saved. */
export async function sendCommand(command: ManualAssetCommand, dictionary: Translation): Promise<string | null> {
  try {
    const result = await window.octopusBeak.manualAssets.apply(command);
    return result.ok ? null : rejectionMessage(result.code, dictionary);
  } catch {
    return dictionary.manualAssets.failed;
  }
}
