/**
 * What a deposit source's financial admission decided for one capture (ADR
 * 0130): commit the deposit capture, or commit only its source evidence. A
 * capture the source may not commit either way throws `DepositAdmissionRefused`.
 */
import type {
  CanonicalFinancialDepositCapture,
  CanonicalFinancialDepositValidatedCapture,
} from "./canonical-financial-deposit-admission.ts";
import type { CanonicalSourceEvidence } from "./canonical-source-evidence.ts";

export type DepositVerdict<Capture extends CanonicalFinancialDepositCapture = CanonicalFinancialDepositValidatedCapture> =
  | Readonly<{ capture: Capture; sourceOnly?: never }>
  | Readonly<{ sourceOnly: CanonicalSourceEvidence; capture?: never }>;

export class DepositAdmissionRefused extends Error {
  readonly diagnostics: readonly string[];

  constructor(subject: string, diagnostics: readonly string[], options?: ErrorOptions) {
    super(`${subject} financial admission failed: ${diagnostics.join(", ")}`, options);
    this.name = "DepositAdmissionRefused";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}
