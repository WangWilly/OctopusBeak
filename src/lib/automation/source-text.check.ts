import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceTextIntegrityError, strictSourceText } from "./source-text.ts";

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
