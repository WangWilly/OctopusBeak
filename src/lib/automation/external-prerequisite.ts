import type { AutomationExternalPrerequisite } from "./types.ts";

const EXTERNAL_PREREQUISITE_ID = /^[a-z0-9][a-z0-9._-]*$/u;

/** A workflow stopped because a component the person installs is unavailable (ADR 0002). */
export class ExternalPrerequisiteUnavailableError extends Error {
  readonly prerequisiteId: string;
  constructor(prerequisiteId: string) {
    if (!EXTERNAL_PREREQUISITE_ID.test(prerequisiteId)) {
      throw new Error(`Invalid external prerequisite ID: ${prerequisiteId}`);
    }
    super(`External prerequisite is unavailable: ${prerequisiteId}`);
    this.name = "ExternalPrerequisiteUnavailableError";
    this.prerequisiteId = prerequisiteId;
  }
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
