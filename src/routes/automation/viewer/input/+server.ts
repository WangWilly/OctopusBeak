import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { sendViewerInput } from "$lib/automation/server/automation-viewer.ts";
import { humanSessionForTask } from "$lib/automation/server/human-session.ts";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const POST: RequestHandler = async ({ request }) => {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch (error) {
    return new Response(message(error), { status: 409 });
  }

  const body = rawBody && typeof rawBody === "object"
    ? rawBody as { taskId?: unknown; input?: unknown }
    : {};
  const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
  if (!taskId) return new Response("Missing taskId.", { status: 400 });

  try {
    const session = humanSessionForTask(taskId);
    await sendViewerInput(session, body.input);
    return json({ ok: true });
  } catch (error) {
    return new Response(message(error), { status: 409 });
  }
};
