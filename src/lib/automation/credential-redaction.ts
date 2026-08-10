import type { AutomationCredentialRedaction } from "./types.ts";

const BULLET = "\u2022";

export function maskTaiwanId(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= 4) return BULLET.repeat(characters.length);
  return `${characters[0]}${BULLET.repeat(characters.length - 4)}${characters.slice(-3).join("")}`;
}

export function credentialInputValue(
  rawValue: string,
  redaction: AutomationCredentialRedaction,
  focused: boolean,
): string {
  if (focused || redaction !== "partial") return rawValue;
  return maskTaiwanId(rawValue);
}
