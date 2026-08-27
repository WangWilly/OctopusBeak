import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const tesseractModel = /(?:^|\/)[^/]+\.traineddata(?:\.gz)?$/i;
const trackedModels = trackedFiles.filter((file) => tesseractModel.test(file));

assert.deepEqual(
  trackedModels,
  [],
  `Tesseract OCR model files must not be tracked: ${trackedModels.join(", ")}`,
);

const gitignore = readFileSync(".gitignore", "utf8");
assert.match(gitignore, /^\*\.traineddata$/m);
assert.match(gitignore, /^\*\.traineddata\.gz$/m);
