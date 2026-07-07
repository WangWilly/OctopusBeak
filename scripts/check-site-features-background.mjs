import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const html = readFileSync('site/index.html', 'utf8');

assert.ok(html.includes('.feature-landscape::before'), 'feature landscape background layer is missing');
assert.ok(html.includes('url("assets/ob-feature-icon-reference.png")'), 'feature icon image must be used as feature landscape background');
assert.ok(html.includes('center / contain no-repeat'), 'feature landscape background must not be cropped');
assert.ok(html.includes('opacity: 0.28;'), 'feature landscape background should be very subtle');
assert.ok(html.includes('<div class="grid-3 feature-landscape">'), 'feature cards must use the feature landscape wrapper');
assert.doesNotMatch(html, /data-od-id="feature-icon-asset"/, 'feature icon image should not render as an inline figure');
assert.doesNotMatch(html, /feature-mark/, 'feature card icons should be removed');

console.log('site features background checks passed');
