import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const html = readFileSync('site/index.html', 'utf8');

assert.ok(html.includes('data-tab="transactions">42 TX</button>'), '42 TX must open the transaction panel');
assert.ok(html.includes('data-panel="transactions"'), 'transaction detail panel is missing');
assert.ok(html.includes('data-open-hero-modal data-i18n="action.assist"'), 'assist button must open the hero modal');
assert.ok(html.includes('data-hero-modal="assist"'), 'assist modal is missing');
assert.equal((html.match(/data-automation-task=/g) || []).length, 3, 'automation panel must show three account tasks');
assert.ok(html.includes('data-automation-task="everyday"'), 'everyday account automation task is missing');
assert.ok(html.includes('data-automation-task="credit-card"'), 'credit card automation task is missing');
assert.ok(html.includes('data-automation-task="brokerage"'), 'brokerage automation task is missing');
assert.ok(html.includes('data-task-state="queued"'), 'automation tasks must start queued');
assert.equal((html.match(/data-task-result="done"/g) || []).length, 2, 'two queued tasks should transition to done');
assert.equal((html.match(/data-task-result="assist"/g) || []).length, 1, 'one queued task should transition to assist');
assert.ok(html.includes('.automation-task[data-task-state="queued"]'), 'queued state styling is missing');
assert.ok(html.includes('.automation-task[data-task-state="done"]'), 'done state styling is missing');
assert.ok(html.includes('.automation-task[data-task-state="assist"]'), 'assist state styling is missing');
assert.ok(html.includes('setTaskState(task, task.dataset.taskResult)'), 'run sync must transition each task to its result');
assert.ok(html.includes('[data-open-hero-modal]'), 'assist modal open handler is missing');
assert.ok(html.includes('[data-close-hero-modal]'), 'assist modal close handler is missing');
assert.doesNotMatch(html, /<button class="tab-btn" data-open-drawer>42 TX<\/button>/, '42 TX still opens the global drawer');
assert.doesNotMatch(html, /<button class="tab-btn" data-run-sync data-i18n="action\.assist">/, 'assist still runs sync directly');

console.log('site hero action checks passed');
