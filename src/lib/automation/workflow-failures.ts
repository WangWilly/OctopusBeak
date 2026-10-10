/** The same finite vocabulary is used by workers, persisted outcomes, and UI. */
export const TYPED_WORKFLOW_ERROR_CODES = [
  "captcha-provider-rejected",
  "cancelled",
  "source-integrity-failed",
  "source-validation-failed",
  "source-access-challenged",
  "source-unavailable",
  "browser-runtime-config-failed",
  "verification-configuration-failed",
  "authentication-timeout",
  "authentication-dialog-interrupted",
  "authentication-failed",
  "verification-failed",
  "device-registration-required",
  "provider-protocol-outdated",
  "source-collection-failed",
  "canonical-commit-failed",
  "commit-outcome-unknown",
  "workflow-failed",
] as const;

export type TypedWorkflowErrorCode = typeof TYPED_WORKFLOW_ERROR_CODES[number];

const explanations: Partial<Record<TypedWorkflowErrorCode, Readonly<{ zh: string; en: string }>>> = {
  "authentication-timeout": {
    zh: "登入步驟等待逾時，尚未確認登入成功。",
    en: "A sign-in step timed out before successful authentication was confirmed.",
  },
  "authentication-dialog-interrupted": {
    zh: "登入途中出現銀行對話框，流程已停止；尚未確認它是可重試的驗證碼拒絕。",
    en: "A bank dialog interrupted sign-in. It was not confirmed as a retryable CAPTCHA rejection.",
  },
  "authentication-failed": {
    zh: "登入階段的執行失敗，詳細原因尚未確認。",
    en: "Execution failed during sign-in. The specific cause has not been established.",
  },
  "verification-failed": {
    zh: "驗證步驟未成功完成，這次同步已停止。",
    en: "The verification step did not complete successfully, so this run stopped.",
  },
  "browser-runtime-config-failed": {
    zh: "內建瀏覽器無法完成這次同步所需的設定，同步已停止。這不是登入資料或來源服務的問題。",
    en: "The built-in browser could not be set up the way this sync requires, so the run stopped. This is not a problem with your sign-in details or the source service.",
  },
  "device-registration-required": {
    zh: "集保e手掌握不再信任這台裝置。請到登入設定重新註冊裝置，再執行同步。",
    en: "TDCC e-Passbook no longer trusts this device. Register the device again in sign-in settings, then run the sync.",
  },
  "provider-protocol-outdated": {
    zh: "來源服務的 App 介面已變更，需要更新 OctopusBeak 才能繼續同步。",
    en: "The source service's App interface changed. Update OctopusBeak to sync again.",
  },
  "source-collection-failed": {
    zh: "來源資料收集失敗，未完成這次來源的資料驗證。",
    en: "Source collection failed before validation of this collection completed.",
  },
  "source-validation-failed": {
    zh: "來源回傳的資料格式與預期不符，這部分沒有匯入。需要更新 OctopusBeak 才能讀取。",
    en: "The source returned data in a shape OctopusBeak does not expect, so this part was not imported. OctopusBeak needs an update to read it.",
  },
  "workflow-failed": {
    zh: "執行失敗，現有紀錄不足以判定詳細原因。",
    en: "Execution failed; the available record does not establish the specific cause.",
  },
};

export function workflowFailureExplanation(code: string, locale: string): string | null {
  if (!Object.hasOwn(explanations, code)) return null;
  const explanation = explanations[code as TypedWorkflowErrorCode];
  return explanation ? locale === "zh-TW" ? explanation.zh : explanation.en : null;
}
