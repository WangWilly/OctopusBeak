import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collapseSourceWhitespace,
  SourceTextIntegrityError,
  strictSourceText,
  trimSourceLexeme,
} from "./source-text.ts";

test("strict source text preserves a UTF-8 character split across chunks", () => {
  const bytes = Buffer.from("安心食品", "utf8");
  const stream = strictSourceText.stream("utf-8");
  const pieces = [
    stream.push(bytes.subarray(0, 1)),
    stream.push(bytes.subarray(1, 4)),
    stream.push(bytes.subarray(4)),
    stream.finish(),
  ];
  assert.equal(pieces.join(""), "安心食品");
});

test("strict source text rejects an incomplete or malformed character", () => {
  const stream = strictSourceText.stream("utf-8");
  stream.push(Uint8Array.from([0xe5, 0xae]));
  assert.throws(() => stream.finish(), SourceTextIntegrityError);
  assert.throws(
    () => strictSourceText.decode(Uint8Array.from([0xff]), "utf-8"),
    SourceTextIntegrityError,
  );
});

test("strict source text decodes Big5 and rejects replacement characters", () => {
  assert.equal(strictSourceText.decode(Uint8Array.from([0xa4, 0xa4]), "big5"), "中");
  assert.throws(
    () => strictSourceText.decode(Buffer.from("\uFFFD", "utf8"), "utf-8"),
    SourceTextIntegrityError,
  );
});

const removedCollapseVariants: ReadonlyArray<readonly [string, (value: string) => string]> = [
  ["nbsp then \\s", (value) => value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim()],
  ["nbsp then unicode \\s", (value) => value.replace(/\u00a0/g, " ").replace(/\s+/gu, " ").trim()],
  [
    "nbsp and ideographic space then \\s",
    (value) => value.replace(/[\u00a0\u3000]/g, " ").replace(/\s+/g, " ").trim(),
  ],
  ["\\s only", (value) => value.replace(/\s+/g, " ").trim()],
];

test("collapseSourceWhitespace matches every removed collapse variant over the BMP", () => {
  for (const [name, reference] of removedCollapseVariants) {
    for (let code = 0; code <= 0xffff; code += 1) {
      const c = String.fromCharCode(code);
      for (const input of [`a${c}${c}b`, `${c}x${c}`, c]) {
        const expected = reference(input);
        const actual = collapseSourceWhitespace(input);
        if (actual !== expected) {
          assert.fail(`${name} differs for U+${code.toString(16).padStart(4, "0")} in ${JSON.stringify(input)}`);
        }
      }
    }
  }
});

test("collapseSourceWhitespace treats null, undefined and numbers as text", () => {
  assert.equal(collapseSourceWhitespace(null), "");
  assert.equal(collapseSourceWhitespace(undefined), "");
  assert.equal(collapseSourceWhitespace(1200), "1200");
  assert.equal(collapseSourceWhitespace(" \u3000a \t\u00a0b\n"), "a b");
});

test("trimSourceLexeme keeps interior whitespace and trims both ends", () => {
  assert.equal(trimSourceLexeme("  a  b\tc  "), "a  b\tc");
  assert.equal(trimSourceLexeme("1\u00a02\u30003"), "1 2 3");
  assert.equal(trimSourceLexeme("\u3000\u00a0 12,345 \u00a0\u3000"), "12,345");
  assert.equal(trimSourceLexeme(null), "");
  assert.equal(trimSourceLexeme(undefined), "");
});
