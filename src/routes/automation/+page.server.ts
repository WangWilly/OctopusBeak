import { fail } from "@sveltejs/kit";
import type { Actions } from "./$types";
import {
  automationResume,
  automationRun,
  automationSaveCredentials,
  loadAutomationDesktopModel,
} from "$lib/automation/server/desktop-api.ts";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function load() {
  return loadAutomationDesktopModel();
}

export const actions: Actions = {
  saveCredentials: async ({ request }) => {
    const formData = await request.formData();
    const updates: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string" && value.trim()) updates[key] = value.trim();
    }
    try {
      return automationSaveCredentials(updates);
    } catch (error) {
      return fail(409, { message: message(error) });
    }
  },
  run: async ({ request }) => {
    const taskId = String((await request.formData()).get("taskId") ?? "");
    try {
      return automationRun(taskId);
    } catch (error) {
      return fail(409, { message: message(error) });
    }
  },
  resume: async ({ request }) => {
    const taskId = String((await request.formData()).get("taskId") ?? "");
    try {
      return automationResume(taskId);
    } catch (error) {
      return fail(409, { message: message(error) });
    }
  },
};
