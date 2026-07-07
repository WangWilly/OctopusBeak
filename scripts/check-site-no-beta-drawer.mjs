import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const html = readFileSync('site/index.html', 'utf8');

assert.doesNotMatch(html, /beta-drawer/, 'beta drawer must be removed');
assert.doesNotMatch(html, /data-open-drawer|data-close-drawer/, 'drawer triggers must be removed');
assert.doesNotMatch(html, /Beta details|Beta 資訊|drawer\./, 'drawer copy must be removed');

console.log('site beta drawer removal checks passed');
