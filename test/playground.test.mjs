import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../docs/event-strategy-playground.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

function boot() {
  let now = 10000;
  const elements = new Map();
  const listeners = {};
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', style: {}, disabled: false });
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { listeners[type] = fn; },
  };
  const context = vm.createContext({ document, Date: { now: () => now }, setInterval: () => 1, clearInterval() {}, window: { addEventListener() {} } });
  assert.ok(script, 'HTML must contain one executable inline script');
  vm.runInContext(script, context);
  return {
    evaluate: source => vm.runInContext(source, context),
    tick(ms) { now += ms; vm.runInContext('clock()', context); },
    click(dataset) { listeners.click({ target: { closest: () => ({ dataset, disabled: false }) } }); },
    change(dataset, value, checked = false, type = 'select-one', id = '') {
      listeners.change({ target: { dataset, value, checked, type, id } });
    },
    elements,
  };
}

test('standalone prototype boots and switches three configuration tabs', () => {
  const p = boot();
  assert.equal(p.evaluate('run.context'), 'base');
  for (const tab of ['base', 'presets', 'rules']) {
    p.click({ tab });
    assert.ok(p.elements.get('settings').innerHTML.length > 100);
  }
});

test('parallel tools keep the same rule until the last matching call ends', () => {
  const p = boot();
  p.tick(600);
  p.click({ act: 'parallel' });
  assert.equal(p.evaluate('run.calls.length'), 2);
  assert.equal(p.evaluate('run.context'), 'search');
  const line = p.evaluate('run.line');
  const deadline = p.evaluate('run.next.text');
  p.click({ act: 'finish', id: '1' });
  assert.equal(p.evaluate('run.context'), 'search');
  assert.equal(p.evaluate('run.line'), line);
  assert.equal(p.evaluate('run.next.text'), deadline);
  p.tick(600);
  p.click({ act: 'finish', id: '2' });
  assert.equal(p.evaluate('run.context'), 'base');
});

test('errors temporarily override activity and then restore surviving activity', () => {
  const p = boot();
  p.tick(600);
  p.click({ act: 'parallel' });
  p.click({ act: 'fail', id: '1' });
  assert.equal(p.evaluate('run.context'), 'error');
  assert.equal(p.evaluate('run.look.id'), 'red');
  p.tick(2100);
  assert.equal(p.evaluate('run.context'), 'search');
  assert.equal(p.evaluate('run.calls.length'), 1);
});

test('rule order and global enable switch control the winning selection', () => {
  const p = boot();
  p.tick(600);
  p.click({ act: 'tool', kind: 'search' });
  p.change({ rule: 'tools', key: 'enabled' }, '', true, 'checkbox');
  p.click({ act: 'up', id: 'tools' });
  assert.equal(p.evaluate('run.context'), 'tools');
  p.change({}, '', false, 'checkbox', 'rules-enabled');
  assert.equal(p.evaluate('run.context'), 'base');
  p.change({}, '', true, 'checkbox', 'rules-enabled');
  assert.equal(p.evaluate('run.context'), 'tools');
});

test('time and step triggers rotate inside the current rule', () => {
  const p = boot();
  p.tick(600);
  p.click({ act: 'tool', kind: 'search' });
  const first = p.evaluate('run.line');
  p.tick(4100);
  assert.equal(p.evaluate('run.context'), 'search');
  assert.notEqual(p.evaluate('run.line'), first);
  p.change({ trigger: 'text', key: 'time' }, '', false, 'checkbox');
  p.change({ trigger: 'text', key: 'step' }, '', true, 'checkbox');
  const before = p.evaluate('run.line');
  p.click({ act: 'step' });
  assert.equal(p.evaluate('run.line'), before);
  p.click({ act: 'step' });
  assert.notEqual(p.evaluate('run.line'), before);
});

test('ending a turn stops updates; a tool can start a clean new turn', () => {
  const p = boot();
  p.click({ act: 'error' });
  p.click({ act: 'end' });
  const logs = p.evaluate('run.logs.length');
  p.tick(20000);
  assert.equal(p.evaluate('run.logs.length'), logs);
  assert.equal(p.evaluate('run.next.text'), null);
  p.click({ act: 'tool', kind: 'write' });
  p.tick(600);
  assert.equal(p.evaluate('run.context'), 'write');
  assert.equal(p.evaluate('run.pulses.length'), 0);
});

test('rule add/delete, selection editing, and reset use actual controls', () => {
  const p = boot();
  p.click({ act: 'add' });
  assert.equal(p.evaluate('config.rules.length'), 5);
  p.change({ owner: 'custom-1', sel: 'fixedLook' }, 'red');
  assert.equal(p.evaluate("config.rules.at(-1).selection.fixedLook"), 'red');
  p.click({ act: 'delete', id: 'custom-1' });
  assert.equal(p.evaluate('config.rules.length'), 4);
  p.click({ act: 'reset' });
  assert.equal(p.evaluate('run.context'), 'base');
  assert.equal(p.evaluate('run.calls.length'), 0);
});

test('rapid activity changes coalesce and do not sample intermediate contexts', () => {
  const p = boot();
  p.click({ act: 'tool', kind: 'search' });
  assert.equal(p.evaluate('run.pending'), true);
  assert.equal(p.evaluate('run.context'), 'base');
  p.click({ act: 'tool', kind: 'write' });
  p.tick(600);
  assert.equal(p.evaluate('run.context'), 'write');
  assert.equal(p.evaluate("run.cursor['search:searching']"), undefined);
});

test('candidate checkbox cannot remove the last candidate', () => {
  const p = boot();
  p.change({ owner: 'search', sel: 'lookIds', value: 'purple' }, '', false, 'checkbox');
  p.change({ owner: 'search', sel: 'lookIds', value: 'blue' }, '', false, 'checkbox');
  assert.equal(p.evaluate('config.rules[2].selection.lookIds.length'), 1);
  assert.equal(p.evaluate('config.rules[2].selection.lookIds[0]'), 'blue');
});

test('disabled per-turn switches retain the default draw, not an event draw', () => {
  const p = boot();
  p.change({ trigger: 'text', key: 'turn' }, '', false, 'checkbox');
  const previous = p.evaluate('run.line');
  p.click({ act: 'new-turn' });
  assert.equal(p.evaluate('run.line'), previous);
  p.tick(600);
  p.click({ act: 'tool', kind: 'search' });
  assert.equal(p.evaluate('run.context'), 'search');
  p.click({ act: 'new-turn' });
  assert.equal(p.evaluate('run.context'), 'base');
  assert.equal(p.evaluate('run.group.id'), 'general');
});

test('changing stopped default settings still takes effect on the next turn', () => {
  const p = boot();
  p.change({ trigger: 'look', key: 'turn' }, '', false, 'checkbox');
  p.click({ act: 'end' });
  p.change({ owner: 'base', sel: 'fixedLook' }, 'green');
  p.click({ act: 'new-turn' });
  assert.equal(p.evaluate('run.look.id'), 'green');
});

test('text preset textarea separates actual lines and escapes markup', () => {
  const p = boot();
  p.click({ tab: 'presets' });
  assert.ok(p.elements.get('settings').innerHTML.includes('正在认真思考…\n正在组织思路…'));
  p.change({ group: 'general' }, '<img src=x onerror=alert(1)>\n第二句');
  assert.equal(p.evaluate('config.groups[0].lines.length'), 2);
  assert.ok(p.elements.get('settings').innerHTML.includes('&lt;img'));
  assert.ok(!p.elements.get('settings').innerHTML.includes('<img src=x'));
});
