import type { NotificationTarget } from "../src/lib/desktop/api.ts";
import { broadcast } from "./broadcast.ts";

let pendingTarget: NotificationTarget | null = null;

export function requestNotificationTarget(target: NotificationTarget) {
  pendingTarget = target;
  broadcast("automation:notification-target-requested");
}

export function takeNotificationTarget() {
  const target = pendingTarget;
  pendingTarget = null;
  return target;
}
