import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stderr, stdout } from "node:process";
import { tesseractTextRecognitionEngine } from "../src/lib/automation/server/text-captcha-solver.ts";
import { parseArguments, USAGE } from "./captcha-calibration/arguments.ts";
import { CALIBRATION_BANK_SPECS } from "./captcha-calibration/banks.ts";
import { collectCorpus, DeniedRequestError } from "./captcha-calibration/collect.ts";
import { CorpusLocationError, readCaptures, readLabels, resolveCorpusDirectory } from "./captcha-calibration/corpus.ts";
import { evaluateCorpus, formatEvaluation } from "./captcha-calibration/evaluate.ts";
import { startLabelServer } from "./captcha-calibration/label-server.ts";
import { prelabelCorpus } from "./captcha-calibration/prelabel.ts";
import { createDevelopmentBrowserPort } from "./workflow-dev.ts";

const log = (line: string) => { stderr.write(`${line}\n`); };
const print = (text: string) => new Promise<void>((resolve) => { stdout.write(text, () => resolve()); });

function interruptSignal(): AbortSignal {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  return controller.signal;
}

async function main(args: readonly string[]): Promise<number> {
  const command = parseArguments(args);
  if (command.kind === "help") {
    await print(`${USAGE}\n`);
    return 0;
  }
  if (command.kind === "usage-error") {
    stderr.write(`${command.message}\n\n${USAGE}\n`);
    return 2;
  }
  const bank = CALIBRATION_BANK_SPECS[command.bank];
  let corpusDirectory: string;
  try {
    corpusDirectory = await resolveCorpusDirectory(bank.id, command.corpus);
  } catch (error) {
    if (!(error instanceof CorpusLocationError)) throw error;
    stderr.write(`${error.message}\n`);
    return 2;
  }

  if (command.kind === "collect") {
    const signal = interruptSignal();
    log(`Collecting ${command.count} ${bank.displayName} CAPTCHA images into ${corpusDirectory}, ${command.delayMs} ms apart.`);
    try {
      const result = await collectCorpus({
        bank,
        count: command.count,
        delayMs: command.delayMs,
        corpusDirectory,
        signal,
        log,
        browser: createDevelopmentBrowserPort(signal, undefined, undefined, {
          headless: command.headless,
          ...(bank.contextOptions ? { contextOptions: bank.contextOptions } : {}),
        }),
      });
      log(`Captured ${result.captured}, failed ${result.failed}.`);
      return result.captured === command.count ? 0 : 1;
    } catch (error) {
      if (error instanceof DeniedRequestError) {
        log(error.message);
        return 1;
      }
      if (signal.aborted) {
        log("Interrupted; captures so far are kept.");
        return 130;
      }
      throw error;
    }
  }

  if (command.kind === "prelabel") {
    const result = await prelabelCorpus({ corpusDirectory, bank, engine: tesseractTextRecognitionEngine, log });
    await print(`Prelabelled ${result.labelled} captures. Suggestions stay unconfirmed until you label them.\n`);
    process.exit(0);
  }

  if (command.kind === "label") {
    const server = await startLabelServer({ corpusDirectory, bank });
    await print(`Label ${bank.displayName} CAPTCHA images at ${server.url}\nPress Ctrl-C to stop.\n`);
    const signal = interruptSignal();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    await server.close();
    return 0;
  }

  const captures = await readCaptures(corpusDirectory);
  if (captures.length === 0) {
    log(`No captures in ${corpusDirectory}. Run collect first.`);
    return 1;
  }
  const evaluation = await evaluateCorpus(bank, captures, await readLabels(corpusDirectory, bank.id));
  const json = `${JSON.stringify(evaluation, null, 2)}\n`;
  await writeFile(join(corpusDirectory, "evaluation.json"), json);
  await print(command.json ? json : formatEvaluation(evaluation));
  log(`Wrote ${join(corpusDirectory, "evaluation.json")}.`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
