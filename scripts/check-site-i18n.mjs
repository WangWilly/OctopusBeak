import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

assert.match(html, /data-lang="en"/, "English language control is missing");
assert.match(html, /data-lang="zh-Hant"/, "Traditional Chinese language control is missing");
assert.match(html, /const translations = \{/, "translation dictionary is missing");
assert.match(html, /"zh-Hant": \{/, "Traditional Chinese translations are missing");
assert.match(html, /銀行自動化與值得信任的儀表板/, "Traditional Chinese hero headline is missing");
assert.match(html, /document\.documentElement\.lang = nextLang/, "html lang update is missing");
assert.doesNotMatch(html, /OctoputBeak/, "legacy OctoputBeak typo is present");

console.log("site i18n checks passed");
