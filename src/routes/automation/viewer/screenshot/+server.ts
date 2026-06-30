import type { RequestHandler } from "./$types";
import { captureSessionScreenshot } from "$lib/automation/server/automation-viewer.ts";
import { humanSessionForTask } from "$lib/automation/server/human-session.ts";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const GET: RequestHandler = async ({ url }) => {
  const taskId = url.searchParams.get("taskId")?.trim();
  if (!taskId) return new Response("Missing taskId.", { status: 400 });

  try {
    const session = humanSessionForTask(taskId);
    const screenshot = await captureSessionScreenshot(session);
    return new Response(new Uint8Array(screenshot), {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return new Response(message(error), { status: 409 });
  }
};
