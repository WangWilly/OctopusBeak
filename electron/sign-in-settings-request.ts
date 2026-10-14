import { BrowserWindow } from "electron";

let pendingCredentialGroupId: string | null = null;

export function requestSignInSettings(credentialGroupId: string) {
  pendingCredentialGroupId = credentialGroupId;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("automation:sign-in-settings-requested");
  }
}

export function takeSignInSettingsRequest() {
  const credentialGroupId = pendingCredentialGroupId;
  pendingCredentialGroupId = null;
  return credentialGroupId;
}
