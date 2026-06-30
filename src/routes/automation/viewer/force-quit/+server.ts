import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { forceQuitHumanSessionForTask } from "$lib/automation/server/human-session.ts";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const POST: RequestHandler = async ({ request }) => {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return new Response("Malformed JSON.", { status: 400 });
  }

  const body = rawBody && typeof rawBody === "object"
    ? rawBody as { taskId?: unknown }
    : {};
  const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
  if (!taskId) return new Response("Missing taskId.", { status: 400 });

  try {
    const result = await forceQuitHumanSessionForTask(taskId);
    return json({ ok: true, ...result });
  } catch (error) {
    return new Response(message(error), { status: 409 });
  }
};
