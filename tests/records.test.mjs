import test from 'node:test';
import assert from 'node:assert/strict';
import { Records, planeId, RANK_SIZE, HISTORY_SIZE } from '../js/records.js';
import { createPaper } from '../js/paper.js';
import { PRESETS, applyOp } from '../js/presets.js';

function mem() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('記録は飛距離の長い順にランキングされ、保存されて読み直せる', () => {
  const st = mem();
  const r = new Records(st);
  assert.equal(r.add({ distance: 5 }).rank, 1);
  assert.equal(r.add({ distance: 9.5 }).rank, 1);
  assert.equal(r.add({ distance: 7 }).rank, 2);
  assert.deepEqual(r.ranking.map((x) => x.distance), [9.5, 7, 5]);
  const again = new Records(st);
  assert.deepEqual(again.ranking.map((x) => x.distance), [9.5, 7, 5]);
  assert.equal(again.throws, 3);
  assert.equal(again.history[0].distance, 7); // 新しい順
});

test('ランキングは上位 10 件まで。入らなかったら rank は null、自己ベストの判定', () => {
  const r = new Records(mem());
  for (let i = 1; i <= RANK_SIZE; i++) r.add({ distance: i });
  assert.equal(r.ranking.length, RANK_SIZE);
  const low = r.add({ distance: 0.5 });
  assert.equal(low.rank, null);
  assert.equal(low.isBest, false);
  const top = r.add({ distance: 20 });
  assert.equal(top.rank, 1);
  assert.equal(top.isBest, true);
  assert.equal(top.prevBest.distance, RANK_SIZE);
  assert.equal(r.ranking.length, RANK_SIZE);
  assert.equal(r.ranking.at(-1).distance, 2);
});

test('同じ距離なら先に出した記録が上', () => {
  const r = new Records(mem());
  r.add({ distance: 8, name: 'A' });
  r.add({ distance: 8, name: 'B' });
  assert.deepEqual(r.ranking.map((x) => x.name), ['A', 'B']);
});

test('折り方はランキングにだけ保存し、履歴には入れない', () => {
  const r = new Records(mem());
  r.add({ distance: 3, state: { steps: [1] }, paper: { shape: 'square' } });
  assert.deepEqual(r.ranking[0].state, { steps: [1] });
  assert.equal(r.history[0].state, undefined);
});

test('履歴は 100 件まで', () => {
  const r = new Records(mem());
  for (let i = 0; i < HISTORY_SIZE + 20; i++) r.add({ distance: i % 7 });
  assert.equal(r.history.length, HISTORY_SIZE);
  assert.equal(r.throws, HISTORY_SIZE + 20);
});

test('紙飛行機ごとのベスト', () => {
  const r = new Records(mem());
  r.add({ distance: 4, plane: 'a' });
  r.add({ distance: 6, plane: 'b' });
  assert.equal(r.add({ distance: 5, plane: 'a' }).isPlaneBest, true);
  assert.equal(r.add({ distance: 4.5, plane: 'a' }).isPlaneBest, false);
  assert.equal(r.bestFor('a').distance, 5);
  assert.equal(r.bestFor('c'), null);
});

test('名前は保存され、記録を消しても残る', () => {
  const st = mem();
  const r = new Records(st);
  r.name = 'たろう';
  r.add({ distance: 3 });
  assert.equal(r.history[0].name, 'たろう');
  r.clear();
  assert.equal(r.ranking.length, 0);
  assert.equal(new Records(st).name, 'たろう');
});

test('壊れたデータや保存できない環境でも動く', () => {
  const st = mem();
  st.setItem('k', '{broken');
  const r = new Records(st, 'k');
  assert.equal(r.ranking.length, 0);
  const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  const r2 = new Records(full);
  assert.equal(r2.add({ distance: 2 }).rank, 1);
});

test('planeId：同じ折り方なら同じ、開き具合や折り方が違えば別', () => {
  const p = PRESETS.find((q) => q.id === 'airplane');
  const build = () => { let s = createPaper(); for (const op of p.steps) s = applyOp(s, op).state; return s; };
  const a = build();
  const b = build();
  assert.equal(planeId(a), planeId(b));
  b.steps[5].angle = 90;
  assert.notEqual(planeId(a), planeId(b));
  assert.notEqual(planeId(a), planeId(createPaper()));
});

test('あとから名前を付けられる', () => {
  const r = new Records(mem());
  const { record } = r.add({ distance: 7 });
  r.rename(record.id, 'はなこ');
  assert.equal(r.ranking[0].name, 'はなこ');
  assert.equal(r.history[0].name, 'はなこ');
});
