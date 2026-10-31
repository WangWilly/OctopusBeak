import { BrowserWindow } from "electron";
import type { NotificationTarget } from "../src/lib/desktop/api.ts";

let pendingTarget: NotificationTarget | null = null;

export function requestNotificationTarget(target: NotificationTarget) {
  pendingTarget = target;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("automation:notification-target-requested");
  }
}

export function takeNotificationTarget() {
  const target = pendingTarget;
  pendingTarget = null;
  return target;
}
