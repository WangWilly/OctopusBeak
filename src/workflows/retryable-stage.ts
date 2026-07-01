import { pause } from "libretto";

type RetryableStageInput<T> = {
  name: string;
  session: string;
  run: () => Promise<T>;
  reset?: () => Promise<void>;
  pauseForHuman?: () => Promise<void>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function retryableStage<T>(input: RetryableStageInput<T>): Promise<T> {
  try {
    return await input.run();
  } catch (error) {
    console.warn("workflow-stage-retry", {
      stage: input.name,
      message: errorMessage(error),
    });
    await input.reset?.();
  }

  try {
    return await input.run();
  } catch (error) {
    console.error("workflow-stage-human-required", {
      stage: input.name,
      message: errorMessage(error),
    });
    console.log(
      `manual-repair-required: fix ${input.name}, then run \`npx libretto resume --session ${input.session}\`.`,
    );
    await (input.pauseForHuman ?? (() => pause(input.session)))();
  }

  return await input.run();
}
