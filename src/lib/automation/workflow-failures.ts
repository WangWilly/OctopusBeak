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
  "collection-scope-changed",
  "workflow-failed",
] as const;

export type TypedWorkflowErrorCode = typeof TYPED_WORKFLOW_ERROR_CODES[number];

export type UserAction =
  | "register-device"
  | "check-sign-in-details"
  | "check-verification-settings"
  | "update-app";

export const WORKFLOW_FAILURE_USER_ACTIONS = {
  "captcha-provider-rejected": null,
  cancelled: null,
  "source-integrity-failed": null,
  "source-validation-failed": null,
  "source-access-challenged": null,
  "source-unavailable": null,
  "browser-runtime-config-failed": null,
  "verification-configuration-failed": "check-verification-settings",
  "authentication-timeout": null,
  "authentication-dialog-interrupted": null,
  "authentication-failed": "check-sign-in-details",
  "verification-failed": null,
  "device-registration-required": "register-device",
  "provider-protocol-outdated": "update-app",
  "source-collection-failed": null,
  "canonical-commit-failed": null,
  "commit-outcome-unknown": null,
  "collection-scope-changed": null,
  "workflow-failed": null,
} as const satisfies Record<TypedWorkflowErrorCode, UserAction | null>;

export function userActionForFailure(code: string | null | undefined): UserAction | null {
  if (code == null || !Object.hasOwn(WORKFLOW_FAILURE_USER_ACTIONS, code)) return null;
  return WORKFLOW_FAILURE_USER_ACTIONS[code as TypedWorkflowErrorCode];
}

const userActionMessages: Record<UserAction, Readonly<{ zh: string; en: string }>> = {
  "register-device": {
    zh: "這個來源不再信任這台裝置。請到登入設定重新註冊裝置。",
    en: "This source no longer trusts this device. Register the device again in sign-in settings.",
  },
  "check-sign-in-details": {
    zh: "登入沒有成功。請到登入設定確認帳號密碼，並確認帳戶沒有被鎖定。",
    en: "Sign-in did not succeed. Check the sign-in details in sign-in settings and make sure the account is not locked.",
  },
  "check-verification-settings": {
    zh: "驗證設定尚未完成或需要重新授權。請到登入設定檢查驗證設定。",
    en: "Verification is not set up or needs authorization again. Check the verification settings in sign-in settings.",
  },
  "update-app": {
    zh: "來源服務的介面已變更。請更新 OctopusBeak 後再同步。",
    en: "The source service changed its interface. Update OctopusBeak, then sync again.",
  },
};

export function userActionMessage(action: UserAction, locale: string): string {
  const message = userActionMessages[action];
  return locale === "zh-TW" ? message.zh : message.en;
}

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
    zh: "這個來源尚未信任或不再信任這台裝置，因此需要驗證碼。請到登入設定註冊這台裝置，再執行同步。",
    en: "This source does not trust this device, or no longer does, so it asked for a code. Register this device in sign-in settings, then run the sync.",
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
  "collection-scope-changed": {
    zh: "同步進行中，這個來源的勾選項目、啟用狀態或登入身分已變更，之後的資料沒有寫入。變更前已完成的部分仍保留。請重新執行同步。",
    en: "This source's selected statements, enabled state, or sign-in identity changed during the sync, so later data was not saved. Parts saved before the change are kept. Run the sync again.",
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
