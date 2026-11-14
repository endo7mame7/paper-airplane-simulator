import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaper, fold, makeLine, sideOf } from '../js/paper.js';
import { PRESETS, applyOp } from '../js/presets.js';
import { analyzeAirplane } from '../js/aero.js';

const close = (a, b, eps) => Math.abs(a - b) < eps;

function build(id, edit) {
  const p = PRESETS.find((q) => q.id === id);
  let s = createPaper();
  for (const op of p.steps) s = applyOp(s, op).state;
  p.steps.forEach((op, i) => { if (op.angle !== undefined) s.steps[i].angle = op.angle; });
  if (edit) edit(s);
  return s;
}

test('質量は紙の面積と坪量で決まり、折っても変わらない', () => {
  const opts = { metersPerUnit: 0.075, gsm: 80 }; // 15cm 角、80g/m²
  const expected = 0.15 * 0.15 * 0.08; // 1.8g
  const flat = analyzeAirplane(fold(createPaper(), {
    line: makeLine({ x: 0, y: -1 }, { x: 0, y: 1 }), side: 1, type: 'valley',
  }).state, opts);
  assert.ok(close(flat.mass, expected, 1e-9));
  assert.ok(close(analyzeAirplane(build('airplane'), opts).mass, expected, 1e-9));
});

test('平らな紙：翼面積は紙の面積、上反角 0、左右対称', () => {
  // 半分に折った長方形（1 x 2）を開いた状態
  const line = makeLine({ x: 0, y: -1 }, { x: 0, y: 1 });
  const s = fold(createPaper(), { line, side: Math.sign(sideOf(line, { x: -0.5, y: 0 })), type: 'valley' }).state;
  s.steps[0].angle = 0;
  const a = analyzeAirplane(s, { metersPerUnit: 1 });
  assert.ok(close(a.wingArea, 4, 0.1), `wingArea=${a.wingArea}`);
  assert.ok(close(a.dihedral, 0, 1e-6));
  assert.ok(a.symmetry > 0.97);
  assert.ok(close(a.span, 2, 0.05) && close(a.length, 2, 0.05));
});

test('紙飛行機の見本：機首は折り始めの角（y=+1）、翼を広げると翼幅が出る', () => {
  const a = analyzeAirplane(build('airplane'), { metersPerUnit: 1 });
  // 機首の向きは +y
  assert.ok(a.axes.forward[1] > 0.95, `forward=${a.axes.forward}`);
  // 胴は翼の下（上向きは胴から翼の向き）。胴は x=0 側、翼のつけ根は x=0.22
  assert.ok(a.axes.up[0] > 0.8, `up=${a.axes.up}`);
  assert.ok(a.length > 1.9 && a.length < 2.2, `length=${a.length}`);
  assert.ok(a.span > 1.0, `span=${a.span}`);
  assert.ok(a.sideArea > 0.1, `sideArea=${a.sideArea}`);
  assert.ok(a.symmetry > 0.95, `symmetry=${a.symmetry}`);
  // 機首から重心まで：重なった紙が前に多いので、全長の半分より前
  assert.ok(a.cgFromNose < a.length / 2 + 0.2);
});

test('翼を上に開くと上反角が大きくなる', () => {
  const down = analyzeAirplane(build('airplane'));
  const up = analyzeAirplane(build('airplane', (s) => { s.steps[5].angle = 60; s.steps[6].angle = 60; }));
  assert.ok(up.dihedral > down.dihedral + 10, `down=${down.dihedral} up=${up.dihedral}`);
});

test('片方の翼だけ開くと、左右の対称性が下がる', () => {
  const sym = analyzeAirplane(build('airplane'));
  const asym = analyzeAirplane(build('airplane', (s) => { s.steps[6].angle = 180; }), {
    axes: { up: sym.axes.up, forward: sym.axes.forward },
  });
  assert.ok(asym.symmetry < sym.symmetry - 0.1, `sym=${sym.symmetry} asym=${asym.symmetry}`);
  assert.ok(Math.abs(asym.wingBalance) > 0.2, `wingBalance=${asym.wingBalance}`);
});

test('紙の大きさを 2 倍にすると、長さは 2 倍・面積と質量は 4 倍', () => {
  const s = build('airplane');
  const a = analyzeAirplane(s, { metersPerUnit: 0.05 });
  const b = analyzeAirplane(s, { metersPerUnit: 0.1 });
  assert.ok(close(b.span / a.span, 2, 1e-6));
  assert.ok(close(b.wingArea / a.wingArea, 4, 1e-6));
  assert.ok(close(b.mass / a.mass, 4, 1e-6));
  assert.ok(close(b.staticMargin, a.staticMargin, 1e-6));
});

test('すべての見本で解析が数値を返す', () => {
  for (const p of PRESETS) {
    const a = analyzeAirplane(build(p.id));
    for (const k of ['mass', 'wingArea', 'span', 'length', 'staticMargin', 'dihedral', 'symmetry']) {
      assert.ok(Number.isFinite(a[k]), `${p.id}.${k}=${a[k]}`);
    }
  }
});
