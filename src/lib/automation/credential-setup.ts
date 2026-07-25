import type { AutomationCredentialGroup } from "./types.ts";

export type CredentialSetupGroup = Pick<
  AutomationCredentialGroup,
  "id" | "label" | "enabledKey" | "statementSelectionKey" | "statementTypes"
>;

export type CredentialSetupDraft = {
  groups: readonly CredentialSetupGroup[];
  enabled: Readonly<Record<string, boolean>>;
  statementSelections: Readonly<Record<string, readonly string[]>>;
  credentialDrafts: Readonly<Record<string, string>>;
  selectedCredentialGroupId: string;
  onboardingSingleSource: boolean;
  collectionGroupIds: ReadonlySet<string>;
};

export function firstInvalidCredentialGroup(
  groups: readonly CredentialSetupGroup[],
  enabled: Readonly<Record<string, boolean>>,
  statementSelections: Readonly<Record<string, readonly string[]>>,
) {
  return groups.find((group) =>
    group.statementTypes?.length
    && enabled[group.id] !== false
    && !(statementSelections[group.id]?.length)
  ) ?? null;
}

export function singleSourceUpdates(
  groups: readonly CredentialSetupGroup[],
  selectedGroupId: string,
  collectionGroupIds: ReadonlySet<string>,
) {
  return Object.fromEntries(
    groups
      .filter((group) => collectionGroupIds.has(group.id))
      .map((group) => [
        group.enabledKey,
        group.id === selectedGroupId ? "true" : "false",
      ]),
  );
}

export function buildCredentialSetupPlan(draft: CredentialSetupDraft) {
  const updates: Record<string, string> = {};
  for (const group of draft.groups) {
    updates[group.enabledKey] = draft.enabled[group.id] !== false ? "true" : "false";
    const selectedIds = draft.statementSelections[group.id] ?? [];
    if (group.statementSelectionKey && selectedIds.length) {
      updates[group.statementSelectionKey] = selectedIds.join(",");
    }
  }
  for (const [key, value] of Object.entries(draft.credentialDrafts)) {
    if (value.trim()) updates[key] = value.trim();
  }
  if (draft.onboardingSingleSource && draft.selectedCredentialGroupId) {
    Object.assign(
      updates,
      singleSourceUpdates(
        draft.groups,
        draft.selectedCredentialGroupId,
        draft.collectionGroupIds,
      ),
    );
  }
  return {
    updates,
    selectedCredentialGroupId: draft.selectedCredentialGroupId,
  };
}
