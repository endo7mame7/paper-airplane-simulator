import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaper } from '../js/paper.js';
import { PRESETS, applyOp } from '../js/presets.js';
import { analyzeAirplane } from '../js/aero.js';
import { simulateThrow } from '../js/flight.js';
import { randomWind, windVector, windField, describeWind, WIND_MAX, CALM } from '../js/wind.js';

function dart() {
  const p = PRESETS.find((q) => q.id === 'airplane');
  let s = createPaper();
  for (const op of p.steps) s = applyOp(s, op).state;
  p.steps.forEach((op, i) => { if (op.angle !== undefined) s.steps[i].angle = op.angle; });
  return { ...analyzeAirplane(s), dihedral: 3 };
}
const steady = (speed, deg) => ({ ...CALM, speed, dir: (deg * Math.PI) / 180 });
const fly = (w) => simulateThrow(dart(), { speed: 8, angle: 5 }, { wind: windField(w) });

test('同じ種なら同じ風、強さは 0〜最大', () => {
  assert.deepEqual(randomWind(42), randomWind(42));
  for (let i = 0; i < 200; i++) {
    const w = randomWind(i);
    assert.ok(w.speed >= 0 && w.speed <= WIND_MAX);
    assert.ok(w.dir >= 0 && w.dir < Math.PI * 2);
  }
});

test('風のベクトルは、息でゆらぎながら平均の強さのまわりにある', () => {
  const w = { ...randomWind(7), speed: 2 };
  let sum = 0;
  const n = 2000;
  for (let i = 0; i < n; i++) {
    const v = windVector(w, (i / n) * w.gustPeriod * 17);
    assert.equal(v[2], 0);
    sum += Math.hypot(v[0], v[1]);
  }
  assert.ok(Math.abs(sum / n - 2) < 0.1, `mean=${sum / n}`);
  assert.deepEqual(windVector(CALM, 3), [0, 0, 0]);
});

test('追い風だと遠くへ、向かい風だと手前に落ちる', () => {
  const calm = fly(CALM).distance;
  const tail = fly(steady(1.5, 0)).distance;
  const head = fly(steady(1.5, 180)).distance;
  assert.ok(tail > calm * 1.1, `calm=${calm} tail=${tail}`);
  assert.ok(head < calm * 0.9, `calm=${calm} head=${head}`);
});

test('横風で、風下へ流される', () => {
  const toLeft = fly(steady(1.5, 90)); // 左へ吹く風（右からの横風）
  const toRight = fly(steady(1.5, -90));
  assert.ok(toLeft.lateral > 0.5, `lateral=${toLeft.lateral}`);
  assert.ok(toRight.lateral < -0.5, `lateral=${toRight.lateral}`);
});

test('風の説明', () => {
  assert.equal(describeWind(CALM).text, '無風');
  assert.match(describeWind(steady(1.2, 0)).text, /^追い風 1.2/);
  assert.match(describeWind(steady(1.2, 180)).text, /^向かい風/);
  assert.match(describeWind(steady(1, 90)).text, /^右からの横風/);
  assert.match(describeWind(steady(1, -90)).text, /^左からの横風/);
  // 投げる向きを左に 90° 変えると、左へ吹く風は追い風
  assert.match(describeWind(steady(1, 90), 90).text, /^追い風/);
});
