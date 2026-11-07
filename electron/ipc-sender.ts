import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";

/**
 * The renderer's own document, whatever route it shows: the App routes by
 * hash, so the origin and path never change while it navigates.
 */
export function isRendererDocument(url: string, rendererUrl: string): boolean {
  try {
    const target = new URL(url);
    const renderer = new URL(rendererUrl);
    return target.origin === renderer.origin && target.pathname === renderer.pathname;
  } catch {
    return false;
  }
}

type SenderFrame = Readonly<{ url: string; parent: unknown }>;
type SenderEvent = Readonly<{ senderFrame: SenderFrame | null }>;

/** Only the top frame of the App's renderer document may call main. */
export function isTrustedSender(event: SenderEvent, rendererUrl: string): boolean {
  const frame = event.senderFrame;
  return frame !== null && frame.parent === null && isRendererDocument(frame.url, rendererUrl);
}

export class UntrustedIpcSenderError extends Error {
  constructor(channel: string) {
    super(`IPC sender is not the App renderer: ${channel}`);
    this.name = "UntrustedIpcSenderError";
  }
}

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;
type SendListener = (event: IpcMainEvent, ...args: any[]) => void;

export type TrustedIpcMain = Readonly<{
  handle(channel: string, handler: InvokeHandler): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: SendListener): void;
}>;

/**
 * `ipcMain` whose handlers and listeners run only for the App renderer.
 * An invoke from any other frame rejects; a send from one is dropped.
 */
export function trustedIpcMain(
  ipc: Pick<IpcMain, "handle" | "removeHandler" | "on">,
  rendererUrl: string,
): TrustedIpcMain {
  return Object.freeze({
    handle(channel, handler) {
      ipc.handle(channel, (event, ...args) => {
        if (!isTrustedSender(event, rendererUrl)) throw new UntrustedIpcSenderError(channel);
        return handler(event, ...args);
      });
    },
    removeHandler: (channel) => ipc.removeHandler(channel),
    on(channel, listener) {
      ipc.on(channel, (event, ...args) => {
        if (isTrustedSender(event, rendererUrl)) listener(event, ...args);
      });
    },
  });
}
