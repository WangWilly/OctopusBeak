import type { AutomationExternalPrerequisite } from "./types.ts";

const EXTERNAL_PREREQUISITE_SIGNAL = "automation-prerequisite:";
const EXTERNAL_PREREQUISITE_ID_PATTERN = "[a-z0-9][a-z0-9._-]*";
const EXTERNAL_PREREQUISITE_ID = new RegExp(`^${EXTERNAL_PREREQUISITE_ID_PATTERN}$`);

export function externalPrerequisiteSignal(prerequisiteId: string): string {
  if (!EXTERNAL_PREREQUISITE_ID.test(prerequisiteId)) {
    throw new Error(`Invalid external prerequisite ID: ${prerequisiteId}`);
  }
  return `${EXTERNAL_PREREQUISITE_SIGNAL} ${prerequisiteId}`;
}

export function parseExternalPrerequisiteSignals(output: string): string[] {
  const ids = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^${EXTERNAL_PREREQUISITE_SIGNAL}\\s*(${EXTERNAL_PREREQUISITE_ID_PATTERN})\\s*$`, "i"));
    if (match) ids.add(match[1].toLowerCase());
  }
  return [...ids];
}

export function isValidExternalPrerequisiteMetadata(
  prerequisite: AutomationExternalPrerequisite,
): boolean {
  try {
    const url = new URL(prerequisite.downloadUrl);
    return url.protocol === "https:"
      && prerequisite.allowedHosts.some((host) => host.toLowerCase() === url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
