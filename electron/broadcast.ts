import { BrowserWindow } from "electron";
import type { OctopusBeakPushEvents } from "./preload.ts";

export type PushWindow = Readonly<{
  isDestroyed(): boolean;
  webContents: Readonly<{ send(channel: string, ...args: unknown[]): void }>;
}>;

type PushChannel = keyof OctopusBeakPushEvents;

type BroadcastArgs<Channel extends PushChannel> = OctopusBeakPushEvents[Channel] extends undefined
  ? [payload?: undefined, windows?: readonly PushWindow[]]
  : [payload: OctopusBeakPushEvents[Channel], windows?: readonly PushWindow[]];

/** Sends a push event to every live window; the preload declares each channel's payload. */
export function broadcast<Channel extends PushChannel>(channel: Channel, ...args: BroadcastArgs<Channel>) {
  const [payload, windows = BrowserWindow.getAllWindows()] = args;
  for (const window of windows) {
    if (window.isDestroyed()) continue;
    if (payload === undefined) window.webContents.send(channel);
    else window.webContents.send(channel, payload);
  }
}
