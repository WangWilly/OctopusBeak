export type CredentialChangeGroup = Readonly<{
  id: string;
  enabled: boolean;
  selectedStatementTypeIds: readonly string[];
  statementTypes?: readonly { id: string }[];
  credentialKeys: readonly string[];
}>;

export type StagedCredential =
  | Readonly<{ kind: "value"; value: string }>
  | Readonly<{ kind: "file"; path: string; filename: string }>;

export type CredentialFieldEditor = Readonly<{ groupId: string; key: string; draft: string }>;

/**
 * Unsaved edits to the sign-in details modal, kept as differences from the
 * saved groups. An entry exists only while it differs from what is saved, so
 * the pending-change list is a projection of this value and nothing else.
 */
export type CredentialChanges = Readonly<{
  credentials: Readonly<Record<string, StagedCredential>>;
  enabled: Readonly<Record<string, boolean>>;
  statementSelections: Readonly<Record<string, readonly string[]>>;
  editor: CredentialFieldEditor | null;
}>;

export type PendingCredentialChange =
  | Readonly<{ kind: "credential"; groupId: string; key: string }>
  | Readonly<{ kind: "enabled"; groupId: string; enabled: boolean }>
  | Readonly<{ kind: "statements"; groupId: string }>;

export const NO_CREDENTIAL_CHANGES: CredentialChanges = {
  credentials: {},
  enabled: {},
  statementSelections: {},
  editor: null,
};

function savedGroup(groups: readonly CredentialChangeGroup[], groupId: string) {
  return groups.find((group) => group.id === groupId);
}

function without<Value>(record: Readonly<Record<string, Value>>, key: string) {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

export function effectiveGroupEnabled(
  groups: readonly CredentialChangeGroup[],
  changes: CredentialChanges,
  groupId: string,
) {
  return changes.enabled[groupId] ?? savedGroup(groups, groupId)?.enabled ?? false;
}

export function effectiveStatementSelection(
  groups: readonly CredentialChangeGroup[],
  changes: CredentialChanges,
  groupId: string,
): readonly string[] {
  return changes.statementSelections[groupId]
    ?? savedGroup(groups, groupId)?.selectedStatementTypeIds
    ?? [];
}

export function setGroupEnabled(
  groups: readonly CredentialChangeGroup[],
  changes: CredentialChanges,
  groupId: string,
  enabled: boolean,
): CredentialChanges {
  const saved = savedGroup(groups, groupId);
  if (!saved) return changes;
  return {
    ...changes,
    enabled: saved.enabled === enabled
      ? without(changes.enabled, groupId)
      : { ...changes.enabled, [groupId]: enabled },
  };
}

function setStatementSelection(
  groups: readonly CredentialChangeGroup[],
  changes: CredentialChanges,
  groupId: string,
  selected: ReadonlySet<string>,
): CredentialChanges {
  const saved = savedGroup(groups, groupId);
  if (!saved) return changes;
  const ordered = (saved.statementTypes ?? []).map((type) => type.id).filter((id) => selected.has(id));
  const unchanged = ordered.join(",") === saved.selectedStatementTypeIds.join(",");
  return {
    ...changes,
    statementSelections: unchanged
      ? without(changes.statementSelections, groupId)
      : { ...changes.statementSelections, [groupId]: ordered },
  };
}

export function toggleStatementType(
  groups: readonly CredentialChangeGroup[],
  changes: CredentialChanges,
  groupId: string,
  typeId: string,
): CredentialChanges {
  const selected = new Set(effectiveStatementSelection(groups, changes, groupId));
  if (selected.has(typeId)) selected.delete(typeId);
  else selected.add(typeId);
  return setStatementSelection(groups, changes, groupId, selected);
}

export function selectAllStatementTypes(
  groups: readonly CredentialChangeGroup[],
  changes: CredentialChanges,
  groupId: string,
): CredentialChanges {
  const all = (savedGroup(groups, groupId)?.statementTypes ?? []).map((type) => type.id);
  return setStatementSelection(groups, changes, groupId, new Set(all));
}

export function stageCredentialValue(
  changes: CredentialChanges,
  key: string,
  value: string,
): CredentialChanges {
  return {
    ...changes,
    credentials: value.trim()
      ? { ...changes.credentials, [key]: { kind: "value", value } }
      : without(changes.credentials, key),
  };
}

export function stageCredentialFile(
  changes: CredentialChanges,
  key: string,
  path: string,
  filename: string,
): CredentialChanges {
  return {
    ...changes,
    credentials: { ...changes.credentials, [key]: { kind: "file", path, filename } },
  };
}

export function revertCredential(changes: CredentialChanges, key: string): CredentialChanges {
  return { ...changes, credentials: without(changes.credentials, key) };
}

export function openCredentialEditor(
  changes: CredentialChanges,
  groupId: string,
  key: string,
): CredentialChanges {
  return { ...changes, editor: { groupId, key, draft: "" } };
}

export function updateCredentialEditor(changes: CredentialChanges, draft: string): CredentialChanges {
  return changes.editor ? { ...changes, editor: { ...changes.editor, draft } } : changes;
}

export function closeCredentialEditor(changes: CredentialChanges): CredentialChanges {
  return { ...changes, editor: null };
}

export function confirmCredentialEditor(changes: CredentialChanges): CredentialChanges {
  const editor = changes.editor;
  if (!editor?.draft.trim()) return changes;
  return { ...stageCredentialValue(changes, editor.key, editor.draft), editor: null };
}

export function pendingCredentialChanges(
  groups: readonly CredentialChangeGroup[],
  changes: CredentialChanges,
): PendingCredentialChange[] {
  return groups.flatMap((group): PendingCredentialChange[] => [
    ...(group.id in changes.enabled
      ? [{ kind: "enabled", groupId: group.id, enabled: changes.enabled[group.id] } as const]
      : []),
    ...group.credentialKeys
      .filter((key) => key in changes.credentials)
      .map((key) => ({ kind: "credential", groupId: group.id, key }) as const),
    ...(group.id in changes.statementSelections
      ? [{ kind: "statements", groupId: group.id } as const]
      : []),
  ]);
}

/** The full maps the saved-settings plan and validation expect. */
export function credentialSetupInput(
  groups: readonly CredentialChangeGroup[],
  changes: CredentialChanges,
) {
  return {
    enabled: Object.fromEntries(
      groups.map((group) => [group.id, effectiveGroupEnabled(groups, changes, group.id)]),
    ),
    statementSelections: Object.fromEntries(
      groups.map((group) => [group.id, [...effectiveStatementSelection(groups, changes, group.id)]]),
    ),
    credentialDrafts: Object.fromEntries(
      Object.entries(changes.credentials).map(([key, staged]) => [
        key,
        staged.kind === "value" ? staged.value : staged.path,
      ]),
    ),
  };
}
