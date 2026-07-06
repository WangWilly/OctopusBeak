import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const html = readFileSync('site/index.html', 'utf8');
const latestReleaseUrl = 'https://github.com/WangWilly/OctopusBeak/releases/latest';
const downloadCtas = [...html.matchAll(/<([a-z]+)([^>]*data-i18n="cta\.download"[^>]*)>/g)];

assert.equal(downloadCtas.length, 3, 'expected three download CTAs');

for (const [tag, name, attrs] of downloadCtas) {
  assert.equal(name, 'a', `download CTA must be a link: ${tag}`);
  assert.ok(attrs.includes(`href="${latestReleaseUrl}"`), `download CTA missing latest release href: ${tag}`);
  assert.ok(attrs.includes('rel="noopener"'), `download CTA missing rel=noopener: ${tag}`);
}

console.log('site download link checks passed');
