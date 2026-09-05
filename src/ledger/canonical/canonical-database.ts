import { DatabaseSync } from "node:sqlite";
import {
  createCanonicalSchemaLifecyclePlan,
  type CanonicalDatabaseOptions,
} from "./canonical-schema-implementation.ts";
import { CanonicalSchemaLifecycle } from "./canonical-schema-lifecycle.ts";
import { canonicalSqlitePath } from "./canonical-schema-implementation.ts";
import {
  applyCanonicalContractDataTransitions,
  validateRequiredCanonicalContractPurges,
} from "./canonical-contract-purge.ts";

/**
 * Compose the validated physical lifecycle with the post-open Contract Purge
 * data transition. The lifecycle owns schema authority; this module owns the
 * order in which a caller receives a usable canonical database handle.
 */
export function openCanonicalDatabasePath(
  path: string,
  options: CanonicalDatabaseOptions = {},
): DatabaseSync {
  const validated = CanonicalSchemaLifecycle.open(
    path,
    createCanonicalSchemaLifecyclePlan(options),
    {
      readOnly: options.readOnly,
      busyTimeoutMs: options.runtime?.busyTimeoutMs ?? 30_000,
      maxAttempts: options.runtime?.maxAttempts,
      initialBackoffMs: options.runtime?.initialBackoffMs,
      maxBackoffMs: options.runtime?.maxBackoffMs,
    },
  );
  try {
    if (options.readOnly) {
      validateRequiredCanonicalContractPurges(validated.db);
    } else {
      validated.runDataTransition((db) =>
        applyCanonicalContractDataTransitions(
          db,
          validated.openedFromVersion,
        ),
      );
    }
    return validated.db;
  } catch (error) {
    validated.close();
    throw error;
  }
}

export function openCanonicalDatabase(
  ledgerDir: string,
  options: CanonicalDatabaseOptions = {},
): DatabaseSync {
  return openCanonicalDatabasePath(canonicalSqlitePath(ledgerDir), options);
}

export { canonicalSqlitePath } from "./canonical-schema-implementation.ts";
export type { CanonicalDatabaseOptions } from "./canonical-schema-implementation.ts";
