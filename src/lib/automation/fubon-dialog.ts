/**
 * How Fubon's dialog text is read: the 0212 duplicate-login confirm the
 * Source sign-in step confirms, and the sanitized code an alert leaves behind.
 * Plain string functions, so the main process loads the Verified source
 * definition without Playwright.
 */

function normalizeDialogText(message: string): string {
  return message
    .normalize("NFKC")
    .toLocaleLowerCase("zh-TW")
    .replace(/\s+/g, "");
}

function normalizeErrorCode(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value).padStart(4, "0");
  }
  if (typeof value !== "string") return undefined;
  const code = value.trim();
  return /^\d{3,8}$/.test(code) ? code : undefined;
}

export function errorCodeFromDialog(message: string): string | undefined {
  const labeled = message.match(
    /(?:errorCode|error code|錯誤代碼|錯誤碼)\s*[:=]?\s*(\d{3,8})/i,
  );
  return normalizeErrorCode(labeled?.[1]);
}

/**
 * Fubon 0212 is the only confirm we are allowed to accept automatically. The
 * classifier intentionally requires duplicate-login semantics; a generic
 * confirmation must never be accepted on behalf of the account holder.
 */
export function isFubonDuplicateLoginConfirm(message: string): boolean {
  const normalized = normalizeDialogText(message);
  const exact0212 =
    /(?:^|[^0-9a-z])0*212(?:$|[^0-9a-z])/.test(normalized) ||
    /(?:errorcode|錯誤代碼|錯誤碼)[:=]?0*212(?:$|[^0-9a-z])/.test(normalized);
  if (exact0212) return true;

  const hasExplicitAction =
    /是否|確定|確認|繼續|仍要|(?:^|[^a-z])(?:continue|proceed|confirm|yes)(?:$|[^a-z])/.test(
      normalized,
    );
  if (!hasExplicitAction) return false;

  const historicalOrEnded =
    /曾|曾經|歷史|過去|之前|先前|已登出|登出|previous|formerly|history|loggedout|signedout/.test(
      normalized,
    );
  if (historicalOrEnded) return false;

  const duplicateLoginSemantics = /重複登入|重覆登入|重複登錄|重覆登錄/.test(
    normalized,
  );
  if (duplicateLoginSemantics) return true;

  const otherDeviceLoginSemantics =
    /(?:其他|另一|別的)(?:裝置|設備|瀏覽器|地方|處).*(?:登入|登錄)/.test(
      normalized,
    ) ||
    /(?:登入|登錄).*(?:其他|另一|別的)(?:裝置|設備|瀏覽器|地方|處)/.test(
      normalized,
    ) ||
    /(?:another|other)(?:device|browser|session).*(?:login|loggedin)/.test(
      normalized,
    ) ||
    /(?:login|loggedin).*(?:another|other)(?:device|browser|session)/.test(
      normalized,
    ) ||
    /alreadyloggedin/.test(normalized);
  return otherDeviceLoginSemantics;
}

/** An alert is kept only as its category or code; raw bank text never leaves the dialog handler. */
export function sanitizedDialogAlert(message: string): string {
  const errorCode = errorCodeFromDialog(message);
  if (/操作逾時|頁面閒置過久/.test(normalizeDialogText(message))) {
    return "errorCode0240";
  }
  return errorCode ? `errorCode${errorCode}` : "dialog-alert";
}
