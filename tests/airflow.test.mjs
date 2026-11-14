import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaper } from '../js/paper.js';
import { PRESETS, applyOp } from '../js/presets.js';
import { analyzeAirplane } from '../js/aero.js';
import { simulateThrow } from '../js/flight.js';
import { buildVortexModel, velocityAt, surfaceCp, traceStreamlines, diagnose } from '../js/airflow.js';

const RAD = Math.PI / 180;
function dart(extra = {}) {
  const p = PRESETS.find((q) => q.id === 'airplane');
  let s = createPaper();
  for (const op of p.steps) s = applyOp(s, op).state;
  p.steps.forEach((op, i) => { if (op.angle !== undefined) s.steps[i].angle = op.angle; });
  return { ...analyzeAirplane(s), ...extra };
}

test('解析結果に、翼幅方向の帯（翼弦）が入っている', () => {
  const a = dart();
  assert.ok(a.strips.length > 10);
  const area = a.strips.reduce((s, t) => s + t.c * t.w, 0);
  assert.ok(Math.abs(area / a.wingArea - 1) < 0.05, `${area} vs ${a.wingArea}`);
});

test('うずのモデル：翼の前は吹き上げ、後ろは吹き下ろし、遠くは一様な流れ', () => {
  const a = dart();
  const m = buildVortexModel(a, { V: 8, alpha: 5 * RAD });
  assert.ok(m.CL > 0 && m.segments.length > 0);
  const fz = m.freestream[2];
  const ahead = velocityAt(m, [a.length * 0.9, 0, 0]);
  const behind = velocityAt(m, [-a.length * 0.9, 0, 0]);
  assert.ok(ahead[2] > fz, `ahead=${ahead[2]} fz=${fz}`);
  assert.ok(behind[2] < fz, `behind=${behind[2]} fz=${fz}`);
  const farAway = velocityAt(m, [0, 0, 50]);
  assert.ok(Math.hypot(farAway[0] - m.freestream[0], farAway[2] - fz) < 0.01);
});

test('翼端うず：翼端の外側は吹き上げ、内側は吹き下ろし', () => {
  const a = dart();
  const m = buildVortexModel(a, { V: 8, alpha: 6 * RAD });
  const tip = a.span / 2;
  const x = -a.length * 0.6;
  const out = velocityAt(m, [x, tip * 1.3, 0]);
  const inn = velocityAt(m, [x, tip * 0.6, 0]);
  assert.ok(out[2] > m.freestream[2] && inn[2] < m.freestream[2], `out=${out[2]} in=${inn[2]}`);
});

test('翼の上面は負圧、下面は正圧で、前のふちほど強い', () => {
  const a = dart();
  const m = buildVortexModel(a, { V: 8, alpha: 5 * RAD });
  const p = m.panels[Math.floor(m.panels.length / 2)];
  const front = surfaceCp(m, p.lead - 0.1 * (p.lead - p.trail), p.ym);
  const back = surfaceCp(m, p.lead - 0.9 * (p.lead - p.trail), p.ym);
  assert.ok(front.upper < 0 && front.lower > 0);
  assert.ok(front.upper < back.upper);
});

test('流線は下流（-x）へ流れる', () => {
  const a = dart();
  const m = buildVortexModel(a, { V: 8, alpha: 5 * RAD });
  const [l] = traceStreamlines(m, [[a.length, a.span * 0.2, 0.02]], { step: 0.01, length: 0.5 });
  assert.ok(l.pts.at(-1)[0] < l.pts[0][0] - 0.4);
  assert.equal(l.pts.length, l.speed.length);
});

test('診断：機首が重すぎると急降下、後ろが重いと失速と出る', () => {
  const heavy = dart({ staticMargin: 0.35 });
  const fh = simulateThrow(heavy, { speed: 8, angle: 0 });
  const dh = diagnose(fh, heavy);
  assert.ok(dh.findings.some((f) => f.title.includes('急降下')), JSON.stringify(dh.findings.map((f) => f.title)));
  const tail = dart({ staticMargin: -0.15 });
  const ft = simulateThrow(tail, { speed: 12, angle: 20 });
  const dt = diagnose(ft, tail);
  assert.ok(dt.findings.some((f) => f.title.includes('失速')), JSON.stringify(dt.findings.map((f) => f.title)));
  assert.ok(dt.stats.bestLD > 1);
});
