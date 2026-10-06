import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../site/${path}`, import.meta.url), "utf8");
const html = read("index.html");
const css = read("assets/site.css").replace(/\/\*[\s\S]*?\*\//g, "");
const js = read("assets/site.js");

const all = (text, pattern) => new Set([...text.matchAll(pattern)].map((match) => match[1]));
const minus = (left, ...rights) => [...left].filter((item) => !rights.some((right) => right.has(item))).sort();

const htmlClasses = new Set([...html.matchAll(/\sclass="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/)));
const jsStrings = [...js.matchAll(/(["'`])((?:(?!\1).)*)\1/g)].map((match) => match[2]).join("\n");
const jsClasses = new Set([
  ...all(jsStrings, /\.([a-zA-Z][\w-]*)/g),
  ...all(js, /classList\.(?:add|remove|toggle)\("([\w-]+)"/g),
]);
const cssSelectors = [...css.matchAll(/([^{}]+)\{/g)].map((match) => match[1].trim()).filter((prelude) => !prelude.startsWith("@"));
const cssClasses = new Set(cssSelectors.flatMap((selector) => [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1])));

test("every CSS class selector matches markup or a class the script sets", () => {
  assert.deepEqual(minus(cssClasses, htmlClasses, jsClasses), []);
});

test("every class in the markup is styled or read by the script", () => {
  assert.deepEqual(minus(htmlClasses, cssClasses, jsClasses), []);
});

test("every custom property is both defined and used", () => {
  const declared = all(css, /(--[\w-]+)\s*:/g);
  const setByScript = all(js, /setProperty\("(--[\w-]+)"/g);
  const used = all(css + html, /var\((--[\w-]+)/g);
  assert.deepEqual(minus(declared, used), [], "declared but never read");
  assert.deepEqual(minus(used, declared, setByScript), [], "read but never defined");
});

test("i18n keys in the markup and the English dictionary match one to one", () => {
  const markup = all(html, /data-i18n="([^"]+)"/g);
  const dictionary = all(js.slice(0, js.indexOf("};")), /^\s*"([^"]+)":/gm);
  const readDirectly = all(js, /EN\["([^"]+)"\]/g);
  assert.deepEqual(minus(markup, dictionary), [], "markup keys missing from EN");
  assert.deepEqual(minus(dictionary, markup, readDirectly), [], "EN keys nothing reads");
});

test("every SVG symbol, pattern, and filter is referenced", () => {
  const defined = all(html, /<(?:symbol|pattern|filter) id="([\w-]+)"/g);
  const referenced = all(html + css, /(?:href="#|url\(#)([\w-]+)/g);
  assert.deepEqual(minus(defined, referenced), []);
});

test("no copy describes the import stopping for the user", () => {
  // Imports run start to finish in one click; the page must not promise a hand-off that no longer exists.
  // The video player's pause control is about playback, not imports, so its label is left out.
  const copy = [html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ""), js.slice(0, js.indexOf("};"))]
    .join("\n")
    .replace(/data-i18n="player\.pause">[^<]*</g, "")
    .replace(/"player\.pause": "[^"]*",/g, "");
  const handOff = /接手|OTP|驗證碼|暫停|停下來|判斷|step in|verification|\bpause|\bhand(?:s|off|-off|ed)?\b/gi;
  assert.deepEqual([...copy.matchAll(handOff)].map((match) => match[0]), []);
});
