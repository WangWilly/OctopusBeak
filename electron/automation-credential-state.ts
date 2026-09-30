import type {
  AutomationCredentialStateDto,
  CertificateFileValidationReason,
} from "../src/lib/desktop/api.ts";
import type { CathayGmailOtpStatus } from "../src/lib/automation/types.ts";

export type AutomationCredentialStateSource = {
  status: Readonly<Record<string, boolean>>;
  fileNames: Readonly<Record<string, string>>;
  invalidFileKeys: readonly string[];
  invalidFileReasons: Readonly<Record<string, CertificateFileValidationReason>>;
  cathayGmailOtp?: CathayGmailOtpStatus;
};

/**
 * Explicitly copy only the fields that are allowed to cross the main/worker
 * boundary.  Keep this mapper intentionally verbose: spreading a future
 * domain credential object here would make secret leakage easy to introduce.
 */
export function toAutomationCredentialStateDto(
  source: AutomationCredentialStateSource,
  revision: number,
): AutomationCredentialStateDto {
  const status: Record<string, boolean> = {};
  for (const key of Object.keys(source.status)) {
    status[key] = source.status[key]!;
  }

  const fileNames: Record<string, string> = {};
  for (const key of Object.keys(source.fileNames)) {
    fileNames[key] = source.fileNames[key]!;
  }

  const invalidFileKeys = source.invalidFileKeys.slice();
  const invalidFileReasons: Record<string, CertificateFileValidationReason> = {};
  for (const key of invalidFileKeys) {
    invalidFileReasons[key] = source.invalidFileReasons[key]!;
  }

  const dto: AutomationCredentialStateDto = {
    revision,
    status,
    fileNames,
    invalidFileKeys,
    invalidFileReasons,
  };
  if (source.cathayGmailOtp) {
    const cathayGmailOtp: CathayGmailOtpStatus = {
      enabled: source.cathayGmailOtp.enabled === true,
      connectedEmail: source.cathayGmailOtp.connectedEmail,
      needsAuthorization: source.cathayGmailOtp.needsAuthorization === true,
    };
    if (source.cathayGmailOtp.connectionError) {
      cathayGmailOtp.connectionError = source.cathayGmailOtp.connectionError;
    }
    dto.cathayGmailOtp = cathayGmailOtp;
  }
  return dto;
}

export class AutomationCredentialStateError extends Error {
  readonly code = "credential-state-unavailable" as const;
  readonly stage = "snapshot" as const;

  constructor() {
    super("Unable to read automation credentials.");
    this.name = "AutomationCredentialStateError";
  }
}

export type AutomationCredentialStateCache = Readonly<{
  prewarm(): Promise<AutomationCredentialStateDto>;
  read(): Promise<AutomationCredentialStateDto>;
  refresh(): Promise<AutomationCredentialStateDto>;
}>;

/**
 * Cache sanitized state by an automation-specific revision.  Calls for one
 * revision share one promise; a save/refresh creates a new revision and an
 * older read may finish without being allowed to publish.
 */
export function createAutomationCredentialStateCache(
  readSource: () => AutomationCredentialStateSource | Promise<AutomationCredentialStateSource>,
  log: (event: Record<string, string>) => void = (event) =>
    console.warn("automation-credential-state-read-failed", event),
): AutomationCredentialStateCache {
  let revision = 0;
  let current: AutomationCredentialStateDto | null = null;
  const inFlight = new Map<number, Promise<AutomationCredentialStateDto>>();

  const readRevision = (targetRevision: number) => {
    const existing = inFlight.get(targetRevision);
    if (existing) return existing;
    const request = Promise.resolve()
      .then(() => readSource())
      .then((source) => toAutomationCredentialStateDto(source, targetRevision))
      .catch(() => {
        log({
          code: "credential-state-unavailable",
          stage: "snapshot",
          message: "credential state read failed",
        });
        throw new AutomationCredentialStateError();
      });
    inFlight.set(targetRevision, request);
    request.then(
      (state) => {
        if (targetRevision === revision) current = state;
        if (inFlight.get(targetRevision) === request) inFlight.delete(targetRevision);
      },
      () => {
        if (inFlight.get(targetRevision) === request) inFlight.delete(targetRevision);
      },
    );
    return request;
  };

  const read = () => {
    if (current?.revision === revision) return Promise.resolve(current);
    return readRevision(revision);
  };

  return {
    prewarm: read,
    read,
    refresh() {
      revision += 1;
      current = null;
      return readRevision(revision);
    },
  };
}
