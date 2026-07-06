import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

assert.equal(pkg.scripts['site:dev'], 'vite site --host 127.0.0.1 --port 4173');

console.log('site dev command checks passed');
