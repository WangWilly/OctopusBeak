import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const forceTextSource = await readFile(new URL("./ForceText.svelte", import.meta.url), "utf8");
const welcomeSource = await readFile(new URL("./FirstRunWelcome.svelte", import.meta.url), "utf8");
const arrowSource = await readFile(new URL("./assets/curved-arrow-animation.svg", import.meta.url), "utf8");

test("ForceText keeps particles legible and strongly separated", () => {
  assert.match(forceTextSource, /forceCollide<[^>]+>\(2\)\.strength\(1\)/);
  assert.match(forceTextSource, /<circle[^>]+r=\"2\"/);
});

test("slide 2 uses the supplied static curved arrow", () => {
  assert.match(welcomeSource, /curved-arrow-animation\.svg/);
  assert.match(welcomeSource, /translateY\(-\d+px\)\s+rotate\(-15deg\)/);
  assert.doesNotMatch(welcomeSource, /rotate\(45deg\)/);
  assert.doesNotMatch(welcomeSource, /↟/);
  assert.doesNotMatch(welcomeSource, /arrow-float/);
});

test("intro slides cover the full viewport and the arrow reveal finishes near 1.2s", () => {
  assert.match(
    welcomeSource,
    /\.intro-slide\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s,
  );
  assert.match(
    welcomeSource,
    /:global\(html:has\(\.welcome\)\)[\s\S]*?scrollbar-gutter:\s*auto;/,
  );
  const timings = [...arrowSource.matchAll(/(?:begin|dur)=\"([\d.]+)s\"/g)]
    .map((match) => Number(match[1]));
  assert.ok(timings.length > 0);
  assert.ok(Math.max(...timings) <= 1.21);
});

test("slides 1 and 2 do not use opacity entry or exit animations", () => {
  assert.doesNotMatch(
    welcomeSource,
    /\.intro-slide\s*,\s*\.product-slide\s*\{[^}]*animation:/s,
  );
  assert.doesNotMatch(welcomeSource, /animation:\s*(?:icon-arrive|copy-rise|arrow-float)/);
});
