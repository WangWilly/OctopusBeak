import { shell } from "electron";
import {
  configureCathayGmailOtpService,
} from "../src/lib/automation/server/gmail-otp-service.ts";

/** Bind the host Gmail service to Electron's system-browser opener. */
export function registerCathayGmailOtpElectronRuntime(appRoot?: string) {
  return configureCathayGmailOtpService({
    ...(appRoot ? { appRoot } : {}),
    openExternal: (url) => shell.openExternal(url),
  });
}
