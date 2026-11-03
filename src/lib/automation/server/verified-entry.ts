import type { PreviewProduct } from "../../preview-sources/source-id.ts";
import type { AutomationCredentialField } from "../types.ts";
import { FailureCodeError } from "../workflow-failures.ts";
import type { WorkflowContextCapability, WorkflowContextWith, WorkflowCapability, WorkflowOutput } from "../workflow-executor.ts";
import type { VerifiedSource } from "./sources/verified-source.ts";

/** A sign-in field's setting key becomes its input key: `LIBRETTO_CLOUD_HNCB_USER_ID` is `hncb_user_id`. */
export type CredentialInputKey<SettingKey extends string> =
  SettingKey extends `LIBRETTO_CLOUD_${infer Name}` ? Lowercase<Name> : Lowercase<SettingKey>;

export const credentialInputKey = <SettingKey extends string>(settingKey: SettingKey): CredentialInputKey<SettingKey> =>
  settingKey.replace(/^LIBRETTO_CLOUD_/u, "").toLowerCase() as CredentialInputKey<SettingKey>;

type FieldList = readonly Pick<AutomationCredentialField, "key">[];
type ProductList = readonly Readonly<{ id: string }>[];

/**
 * ADR 0097: what every product-collecting Verified source's run receives
 * after the shared checks. Each credential is present and non-empty, and
 * the Statement Selection names at least one product.
 */
export type VerifiedRunInput<Fields extends FieldList = FieldList, Products extends ProductList = ProductList> = Readonly<{
  credentials: Readonly<Record<CredentialInputKey<Fields[number]["key"]>, string>>;
  statementTypes: readonly Products[number]["id"][];
  attachedPreviewProducts: readonly PreviewProduct[];
}>;

/**
 * A product-collecting Verified source's workflow: the source's own input
 * parsing, and its run. The host checks the credentials and the Statement
 * Selection, then calls `parseInput`, then reports `input-validated`, and only
 * then calls `run`.
 */
export type VerifiedWorkflowEntry<
  C extends WorkflowContextCapability,
  Input,
  Output extends WorkflowOutput = WorkflowOutput,
  O extends WorkflowCapability = never,
  Verified extends VerifiedRunInput = VerifiedRunInput,
> = Readonly<{
  /** The source's remaining input and checks. A throw rejects the run before `input-validated`. */
  parseInput(verified: Verified, raw: Readonly<Record<string, unknown>>): Input | Promise<Input>;
  run(context: WorkflowContextWith<C, O>, input: Input): Promise<Output>;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The shared checks: every sign-in field filled, and a non-empty Statement Selection. */
export function verifiedRunInput(source: VerifiedSource, rawInput: unknown): VerifiedRunInput {
  const raw = record(rawInput);
  const credentials: Record<string, string> = {};
  if (source.workflow.input.credentials) {
    const supplied = record(raw.credentials);
    for (const field of source.credentialFields) {
      const value = supplied[credentialInputKey(field.key)];
      const kept = typeof value !== "string" ? "" : field.trim === false ? value : value.trim();
      if (kept === "") throw new Error(`${source.label} sign-in detail is missing: ${field.label.en}.`);
      credentials[credentialInputKey(field.key)] = kept;
    }
  }
  const statementTypes = strings(raw.statementTypes);
  const attachedPreviewProducts = strings(raw.attachedPreviewProducts);
  const products = source.statementSelection?.products.map(({ id }) => id) ?? [];
  if (statementTypes.some((id) => !products.includes(id)))
    throw new Error(`${source.label} selects a product it does not offer.`);
  const offered: readonly string[] = source.workflow.attachedPreviewProducts?.products ?? [];
  if (attachedPreviewProducts.some((id) => !offered.includes(id)))
    throw new Error(`${source.label} selects an attached preview product it does not offer.`);
  // The settings page cannot start a run with nothing selected, so an empty
  // selection here was cleared after the run was queued.
  if (statementTypes.length === 0 && attachedPreviewProducts.length === 0)
    throw new FailureCodeError("collection-scope-changed");
  return { credentials, statementTypes, attachedPreviewProducts: attachedPreviewProducts as readonly PreviewProduct[] };
}

/** Run a product-collecting Verified source's workflow behind the shared input checks. */
export async function runVerifiedEntry<
  C extends WorkflowContextCapability,
  Input,
  Output extends WorkflowOutput,
  O extends WorkflowCapability,
  Verified extends VerifiedRunInput,
>(
  source: VerifiedSource,
  entry: VerifiedWorkflowEntry<C, Input, Output, O, Verified>,
  context: WorkflowContextWith<C, O>,
  rawInput: unknown,
): Promise<Output> {
  // The entry's Verified type names the same field and product lists the source declares.
  const verified = verifiedRunInput(source, rawInput) as Verified;
  const input = await entry.parseInput(verified, record(rawInput));
  context.signal.throwIfAborted();
  await context.event("preparation", "completed", "input-validated");
  return await entry.run(context, input);
}
