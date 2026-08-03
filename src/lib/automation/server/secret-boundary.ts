import { readAutomationCredentialsFile } from "./config-files.ts";

export type SecretBoundarySurface =
  | "stdout"
  | "stderr"
  | "log-tail"
  | "final-failure"
  | "cleanup-error"
  | "filesystem-log"
  | "sqlite-persistence"
  | "diagnostic-export"
  | "patch-stdout"
  | "patch-stderr";

export type SecretBoundaryFailure = {
  surface: SecretBoundarySurface;
  reason: "authentication-secret-detected";
};

export function secretBoundaryFailureMessage(failure: SecretBoundaryFailure) {
  return `SECRET_BOUNDARY_VIOLATION surface=${failure.surface} reason=${failure.reason}`;
}

export type ProtectedSecretText = {
  value: string;
  failure: SecretBoundaryFailure | null;
};

export type SecretRedactionPolicy = {
  redact(value: string, secrets: readonly string[], replacement: string): string;
};

export type SecretAssertionGate = {
  assert(value: string, secrets: readonly string[]): void;
};

export type SecretSchemaAllowlist = Readonly<
  Record<string, readonly string[]>
>;

export type SecretBoundaryDependencies = {
  redactionPolicy: SecretRedactionPolicy | null;
  assertionGate: SecretAssertionGate | null;
  schemaAllowlist: SecretSchemaAllowlist | null;
};

const REDACTION_MARKERS = ["[REDACTED]", "<secret>", "***", ""];
const DEFAULT_REDACTION_POLICY: SecretRedactionPolicy = {
  redact: (value, secrets, replacement) => secrets.reduce(
    (text, secret) => text.split(secret).join(replacement),
    value,
  ),
};
const DEFAULT_ASSERTION_GATE: SecretAssertionGate = {
  assert(value, secrets) {
    if (secrets.some((secret) => value.includes(secret))) {
      throw new Error("SECRET_BOUNDARY_ASSERTION_FAILED");
    }
  },
};
const DEFAULT_SCHEMA_ALLOWLIST: SecretSchemaAllowlist = {};
export const AUTOMATION_SECRET_SCHEMA_ALLOWLIST: SecretSchemaAllowlist = {
  "automation-task-run": [
    "taskRunId",
    "taskId",
    "script",
    "kind",
    "status",
    "attempt",
    "maxAttempts",
    "startedAt",
    "finishedAt",
    "exitCode",
    "signal",
    "errorMessage",
    "logPath",
    "logTail",
  ],
  "automation-history": [
    "taskRunId",
    "taskId",
    "script",
    "kind",
    "status",
    "startedAt",
    "finishedAt",
    "exitCode",
    "signal",
    "errorMessage",
    "logPath",
  ],
};

function redactionMarker(secretValues: readonly string[]) {
  return REDACTION_MARKERS.find(
    (candidate) => secretValues.every((secret) => !candidate.includes(secret)),
  ) ?? "";
}

export function createSecretBoundaryGate({
  secretValues,
  report = () => {},
  dependencies = {},
}: {
  secretValues: readonly string[];
  report?: (failure: SecretBoundaryFailure) => void;
  dependencies?: Partial<SecretBoundaryDependencies>;
}) {
  const secrets = [...new Set(secretValues.filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  const replacement = redactionMarker(secrets);
  const redactionPolicy = dependencies.redactionPolicy === undefined
    ? DEFAULT_REDACTION_POLICY
    : dependencies.redactionPolicy;
  const assertionGate = dependencies.assertionGate === undefined
    ? DEFAULT_ASSERTION_GATE
    : dependencies.assertionGate;
  const schemaAllowlist = dependencies.schemaAllowlist === undefined
    ? DEFAULT_SCHEMA_ALLOWLIST
    : dependencies.schemaAllowlist;
  const streamPending = new Map<"stdout" | "stderr", string>();

  function requireTextDependencies(surface: SecretBoundarySurface) {
    if (!redactionPolicy) {
      throw new Error(
        `SECRET_BOUNDARY_GATE_UNAVAILABLE surface=${surface} reason=redaction-policy-unavailable`,
      );
    }
    if (!assertionGate) {
      throw new Error(
        `SECRET_BOUNDARY_GATE_UNAVAILABLE surface=${surface} reason=assertion-gate-unavailable`,
      );
    }
    return { redactionPolicy, assertionGate };
  }

  function redactText(surface: SecretBoundarySurface, value: string) {
    const available = requireTextDependencies(surface);
    try {
      return available.redactionPolicy.redact(value, secrets, replacement);
    } catch {
      throw new Error(
        `SECRET_BOUNDARY_REDACTION_FAILED surface=${surface} reason=redaction-policy-failed`,
      );
    }
  }

  function assertProtectedText(
    surface: SecretBoundarySurface,
    value: string,
  ) {
    const available = requireTextDependencies(surface);
    try {
      available.assertionGate.assert(value, secrets);
    } catch {
      throw new Error(
        `SECRET_BOUNDARY_ASSERTION_FAILED surface=${surface} reason=authentication-secret-remained`,
      );
    }
  }

  function protectText(
    surface: SecretBoundarySurface,
    value: string,
  ): ProtectedSecretText {
    const matched = secrets.some((secret) => value.includes(secret));
    const protectedValue = redactText(surface, value);
    assertProtectedText(surface, protectedValue);
    const failure: SecretBoundaryFailure | null = matched
      ? { surface, reason: "authentication-secret-detected" }
      : null;
    if (failure) report(failure);
    return { value: protectedValue, failure };
  }

  function protectRecord<T extends Record<string, unknown>>(
    surface: Extract<SecretBoundarySurface, "sqlite-persistence" | "diagnostic-export">,
    schema: string,
    value: T,
  ): { value: T; failure: SecretBoundaryFailure | null } {
    const allowedFields = assertRecordSchema(surface, schema);
    if (Object.keys(value).some((field) => !allowedFields.has(field))) {
      throw new Error(
        `SECRET_BOUNDARY_SCHEMA_REJECTED surface=${surface} reason=field-not-allowlisted`,
      );
    }
    const protectedValue = protectRecordValue(surface, value);
    return {
      value: protectedValue.value as T,
      failure: protectedValue.failure,
    };
  }

  function protectRecordValue(
    surface: Extract<SecretBoundarySurface, "sqlite-persistence" | "diagnostic-export">,
    value: unknown,
  ): { value: unknown; failure: SecretBoundaryFailure | null } {
    if (typeof value === "string") return protectText(surface, value);
    if (Array.isArray(value)) {
      let failure: SecretBoundaryFailure | null = null;
      return {
        value: value.map((item) => {
          const protectedItem = protectRecordValue(surface, item);
          failure ??= protectedItem.failure;
          return protectedItem.value;
        }),
        failure,
      };
    }
    if (value && typeof value === "object") {
      let failure: SecretBoundaryFailure | null = null;
      const entries = Object.entries(value).map(([key, item]) => {
        const protectedItem = protectRecordValue(surface, item);
        failure ??= protectedItem.failure;
        return [key, protectedItem.value];
      });
      return { value: Object.fromEntries(entries), failure };
    }
    return { value, failure: null };
  }

  function protectStreamText(
    surface: "stdout" | "stderr",
    value: string,
    flush = false,
  ): ProtectedSecretText {
    requireTextDependencies(surface);
    let pending = streamPending.get(surface) ?? "";
    let protectedValue = "";
    let failure: SecretBoundaryFailure | null = null;
    for (const character of value) {
      pending += character;
      while (pending) {
        if (secrets.includes(pending)) {
          protectedValue += redactText(surface, pending);
          failure ??= {
            surface,
            reason: "authentication-secret-detected",
          };
          pending = "";
          break;
        }
        if (secrets.some((secret) => secret.startsWith(pending))) break;
        protectedValue += pending[0];
        pending = pending.slice(1);
      }
    }
    if (flush) {
      protectedValue += pending;
      pending = "";
    }
    streamPending.set(surface, pending);
    assertProtectedText(surface, protectedValue);
    if (failure) report(failure);
    return { value: protectedValue, failure };
  }

  function assertRecordSchema(
    surface: Extract<SecretBoundarySurface, "sqlite-persistence" | "diagnostic-export">,
    schema: string,
  ) {
    requireTextDependencies(surface);
    if (!schemaAllowlist) {
      throw new Error(
        `SECRET_BOUNDARY_GATE_UNAVAILABLE surface=${surface} reason=schema-allowlist-unavailable`,
      );
    }
    const fields = schemaAllowlist[schema];
    if (!fields) {
      throw new Error(
        `SECRET_BOUNDARY_SCHEMA_REJECTED surface=${surface} reason=schema-not-allowlisted`,
      );
    }
    return new Set(fields);
  }

  return {
    protectText,
    protectStreamText,
    protectRecord,
    assertRecordSchema,
  };
}

export type SecretBoundaryGate = ReturnType<typeof createSecretBoundaryGate>;

export function createAutomationSecretBoundaryGate({
  secretValues,
  additionalSecretValues = [],
  report,
  dependencies = {},
}: {
  secretValues?: readonly string[];
  additionalSecretValues?: readonly string[];
  report?: (failure: SecretBoundaryFailure) => void;
  dependencies?: Partial<SecretBoundaryDependencies>;
} = {}) {
  return createSecretBoundaryGate({
    secretValues: [
      ...(secretValues ?? Object.values(readAutomationCredentialsFile())),
      ...additionalSecretValues,
    ],
    report,
    dependencies: {
      ...dependencies,
      schemaAllowlist: dependencies.schemaAllowlist === undefined
        ? AUTOMATION_SECRET_SCHEMA_ALLOWLIST
        : dependencies.schemaAllowlist,
    },
  });
}
