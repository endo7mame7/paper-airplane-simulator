import test from 'node:test';
import assert from 'node:assert/strict';
import { TIPS, TIP_CATEGORIES, shuffledTips } from '../js/tips.js';

test('ヒントは 4 つの分類すべてにあり、題名と本文がある', () => {
  for (const cat of Object.keys(TIP_CATEGORIES)) {
    assert.ok(TIPS.filter((t) => t.cat === cat).length >= 4, cat);
  }
  for (const t of TIPS) {
    assert.ok(TIP_CATEGORIES[t.cat], t.title);
    assert.ok(t.title.length > 0 && t.text.length > 10);
  }
});

test('並べかえても同じヒントが全部ある', () => {
  let x = 0.3;
  const rnd = () => { x = (x * 9301 + 49297) % 233280 / 233280; return x; };
  const s = shuffledTips(rnd);
  assert.equal(s.length, TIPS.length);
  assert.deepEqual(new Set(s), new Set(TIPS));
});
