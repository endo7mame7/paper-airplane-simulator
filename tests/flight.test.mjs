import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaper } from '../js/paper.js';
import { PRESETS, applyOp } from '../js/presets.js';
import { analyzeAirplane } from '../js/aero.js';
import { simulateThrow, makeAirframe, coefficients, G } from '../js/flight.js';

function dart(extra = {}) {
  const p = PRESETS.find((q) => q.id === 'airplane');
  let s = createPaper();
  for (const op of p.steps) s = applyOp(s, op).state;
  p.steps.forEach((op, i) => { if (op.angle !== undefined) s.steps[i].angle = op.angle; });
  return { ...analyzeAirplane(s), ...extra };
}

test('揚力係数：小さい迎え角では比例し、失速すると下がる', () => {
  const af = makeAirframe(dart());
  const a = (deg) => coefficients(af, (deg * Math.PI) / 180);
  assert.ok(Math.abs(a(0).CL) < 1e-9);
  assert.ok(Math.abs(a(4).CL / a(2).CL - 2) < 0.05);
  assert.ok(a(-5).CL < 0);
  assert.ok(a(80).CL < a(20).CL);
  assert.ok(a(60).CD > a(5).CD * 3);
});

test('翼のない紙は、抗力を受けながら放物線に近い形で落ちる', () => {
  const a = { ...dart(), wingArea: 0, sideArea: 1e-4 };
  const r = simulateThrow(a, { speed: 5, angle: 0, height: 1 });
  assert.equal(r.reason, 'landed');
  // 空気抵抗がなければ 5 * sqrt(2 / g) ≒ 2.26m。抵抗があるので短い
  assert.ok(r.distance < 5 * Math.sqrt(2 / G));
  assert.ok(r.distance > 0.1);
});

test('見本の紙飛行機を 8m/s で投げると、数 m〜十数 m 飛ぶ', () => {
  const r = simulateThrow(dart(), { speed: 8, angle: 5 });
  assert.equal(r.reason, 'landed');
  assert.ok(r.distance > 4 && r.distance < 20, `distance=${r.distance}`);
  assert.ok(r.time > 1, `time=${r.time}`);
  // ほぼまっすぐ
  assert.ok(Math.abs(r.lateral) < r.distance * 0.1, `lateral=${r.lateral}`);
});

test('速く投げるほど遠くまで飛ぶ', () => {
  const a = dart();
  const d = [4, 8, 12].map((speed) => simulateThrow(a, { speed, angle: 0 }).distance);
  assert.ok(d[0] < d[1] && d[1] < d[2], `d=${d}`);
});

test('重心がかなり前（機首が重すぎる）と、すぐ落ちて飛距離が短い', () => {
  const ok = simulateThrow(dart(), { speed: 8, angle: 0 }).distance;
  const heavy = simulateThrow(dart({ staticMargin: 0.3 }), { speed: 8, angle: 0 }).distance;
  assert.ok(heavy < ok * 0.7, `ok=${ok} heavy=${heavy}`);
});

test('昇降舵（後ろのふちを上げる）で、機首が重い機体も長く飛ぶ', () => {
  const heavy = simulateThrow(dart({ staticMargin: 0.15 }), { speed: 8, angle: 0 });
  const trimmed = simulateThrow(dart({ staticMargin: 0.15, pitchTrim: 0.03 }), { speed: 8, angle: 0 });
  assert.ok(trimmed.distance > heavy.distance * 1.3, `heavy=${heavy.distance} trimmed=${trimmed.distance}`);
  assert.ok(trimmed.time > heavy.time);
});

test('補助翼（右の翼の迎え角を大きく）で左に曲がる', () => {
  const r = simulateThrow(dart({ dihedral: 5, rollTrim: 0.002 }), { speed: 8, angle: 0 });
  // 右の翼が上がる → 左に傾く → 左（+y）へ曲がる
  assert.ok(r.lateral > 0.5, `lateral=${r.lateral}`);
  const l = simulateThrow(dart({ dihedral: 5, rollTrim: -0.002 }), { speed: 8, angle: 0 });
  assert.ok(l.lateral < -0.5, `lateral=${l.lateral}`);
});

test('同じ条件なら毎回同じ結果になる', () => {
  const a = dart();
  const r1 = simulateThrow(a, { speed: 9, angle: 7 });
  const r2 = simulateThrow(a, { speed: 9, angle: 7 });
  assert.equal(r1.distance, r2.distance);
});

test('軌跡は時刻順で、最後の点は地面', () => {
  const r = simulateThrow(dart(), { speed: 8, angle: 5 });
  for (let i = 1; i < r.path.length; i++) assert.ok(r.path[i].t > r.path[i - 1].t);
  assert.equal(r.path[r.path.length - 1].pos[2], 0);
  assert.equal(r.path[0].pos[2], 1.6);
});
