import { writeSync } from "node:fs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const progressFd = Number(process.env.LIBRETTO_AUTOMATION_PROGRESS_FD);
const partialResult = process.env.OCTOPUSBEAK_AUTOMATION_FAKE_RESULT === "partial";
const emitProgress = (event) => {
  if (!Number.isSafeInteger(progressFd) || progressFd < 0) return;
  writeSync(progressFd, JSON.stringify({ type: "progress", ...event }) + "\n");
};

console.log("fixture-run-start");
emitProgress({ phaseCode: "fixture-start", completed: 0, total: 3, percent: 0 });
await wait(700);
console.log("fixture-log-entry");
emitProgress({ phaseCode: "fixture-work", completed: 1, total: 3, percent: 33 });
await wait(700);
emitProgress({ phaseCode: "fixture-complete", completed: 3, total: 3, percent: 100 });
if (partialResult) {
  console.log(
    `automation-statement-summary: ${JSON.stringify({
      status: "partial",
      results: [
        { typeId: "deposit", status: "success" },
        { typeId: "loan", status: "failed", error: "fixture partial failure" },
      ],
    })}`,
  );
}
console.log("fixture-run-complete");
