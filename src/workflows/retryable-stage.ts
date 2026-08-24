import { pause } from "libretto";

type RetryableStageInput<T> = {
  name: string;
  session: string;
  run: () => Promise<T>;
  reset?: () => Promise<void>;
  /** Only errors matching this provider-owned predicate may pause for repair. */
  isHumanRepairable?: (error: unknown) => boolean;
  /** Publish the current repair contract before the centralized pause. */
  beforeHumanPause?: (error: unknown) => Promise<void>;
  /** Test seam for the Libretto pause; production uses pause(session). */
  pause?: (session: string) => Promise<void>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function retryableStage<T>(
  input: RetryableStageInput<T>,
): Promise<T> {
  async function pauseForHuman(error: unknown) {
    console.error("workflow-stage-human-required", {
      stage: input.name,
      message: errorMessage(error),
    });
    console.log(
      `manual-repair-required: fix ${input.name}, then run \`npx libretto resume --session ${input.session}\`.`,
    );
    await input.beforeHumanPause?.(error);
    if (input.pause) await input.pause(input.session);
    else await pause(input.session);
  }

  let firstAttempt = true;
  while (true) {
    try {
      return await input.run();
    } catch (error) {
      if (firstAttempt) {
        firstAttempt = false;
        console.warn("workflow-stage-retry", {
          stage: input.name,
          message: errorMessage(error),
        });
        try {
          await input.reset?.();
        } catch (resetError) {
          if (!input.isHumanRepairable?.(resetError)) throw resetError;
          await pauseForHuman(resetError);
        }
        continue;
      }
      if (!input.isHumanRepairable?.(error)) throw error;
      await pauseForHuman(error);
    }
  }
}
