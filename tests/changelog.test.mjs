import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHANGELOG } from '../js/changelog.js';
import { VERSION } from '../js/version.js';

const md = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const heads = [...md.matchAll(/^## (\S+?)（(\d{4}-\d{2}-\d{2})）(.+)$/gm)].map((m) => ({ version: m[1], date: m[2], summary: m[3] }));
const num = (v) => v.split('.').map(Number);
const cmp = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

test('最新の変更履歴は、いまのバージョン', () => {
  assert.equal(CHANGELOG[0].version, VERSION);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, VERSION);
});

test('画面の変更履歴と CHANGELOG.md の見出し（バージョン・日付・概要）が一致する', () => {
  assert.deepEqual(CHANGELOG.map(({ version, date, summary }) => ({ version, date, summary })), heads);
});

test('新しい順に並び、日付は古くならない', () => {
  for (let i = 1; i < CHANGELOG.length; i++) {
    assert.ok(cmp(CHANGELOG[i - 1].version, CHANGELOG[i].version) > 0, CHANGELOG[i].version);
    assert.ok(CHANGELOG[i - 1].date >= CHANGELOG[i].date, CHANGELOG[i].version);
  }
  for (const e of CHANGELOG) assert.ok(e.items.length > 0 && e.summary.length > 0, e.version);
});
