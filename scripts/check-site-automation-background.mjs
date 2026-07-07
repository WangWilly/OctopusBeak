import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const html = readFileSync('site/index.html', 'utf8');

assert.ok(html.includes('#sync-card::before'), 'sync card background layer is missing');
assert.ok(html.includes('url("assets/ob-automation-flow.png")'), 'automation image must be used as sync card background');
assert.doesNotMatch(html, /data-od-id="automation-flow-asset"/, 'automation image should not render as an inline figure');
assert.doesNotMatch(html, /data-i18n="automation\.sideLead"/, 'automation side lead should be removed with the inline image block');

console.log('site automation background checks passed');
