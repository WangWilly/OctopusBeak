import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../docs/prototypes/settings-v2.html", import.meta.url), "utf8");

assert.match(source, /<html lang="zh-Hant">/);
assert.match(source, />時區與排程設定</);
assert.match(source, />語言與顯示設定</);
assert.match(source, /所有變更已儲存/);
assert.doesNotMatch(source, /type="submit"|>儲存<|class="field-save"/);
assert.match(source, /<select id="timezone"/);
assert.match(source, /<details class="time-picker">/);
assert.match(source, /id="update-time-input" type="time"/);
assert.match(source, /class="time-popover"/);
assert.match(source, /aria-pressed="true">繁體中文/);
assert.match(source, /id="scale-minus"/);
assert.match(source, /id="scale-plus"/);
assert.match(source, /id="scale-reset"/);
assert.match(source, /⌘− 縮小 · ⌘＋ 放大 · ⌘0 重設/);
assert.match(source, /const MIN_SCALE = 75/);
assert.match(source, /const MAX_SCALE = 150/);
assert.match(source, /const SCALE_STEP = 5/);
assert.match(source, /localStorage\.setItem\(STORAGE_KEY/);
assert.match(source, /@media \(max-width: 760px\)/);
