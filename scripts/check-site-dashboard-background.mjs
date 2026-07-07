import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const html = readFileSync('site/index.html', 'utf8');

assert.ok(html.includes('#dashboard-card::before'), 'dashboard card background layer is missing');
assert.ok(html.includes('#dashboard-card { position: relative; overflow: hidden; height: 360px; }'), 'dashboard card must keep a fixed height');
assert.ok(html.includes('url("assets/ob-dashboard-drilldown-soft.png")'), 'dashboard image must be used as card background');
assert.doesNotMatch(html, /<figure class="media-card softened"[^>]*data-od-id="dashboard-generated-asset"/, 'dashboard image should not render as an inline figure');

console.log('site dashboard background checks passed');
