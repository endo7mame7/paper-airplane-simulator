// 分析モード用の、翼のまわりの空気の流れの簡易モデル（描画ライブラリに依存しない純粋なロジック）
//
// 本物の流体計算（CFD）ではなく、翼の揚力をうずの集まりに置き換える「揚力線理論」を使った近似。
//   - 翼を翼幅方向に区切り、それぞれに馬てい形のうず（翼弦の 1/4 の線 + 後ろへ伸びる 2 本）を置く
//   - うずの強さ（循環）Γ は、揚力が楕円形に分布するとして、全体の揚力係数 CL から決める
//   - ある点の空気の速さ = 一様な流れ + うずが作る速さ（ビオ・サバールの法則）
// こうすると、翼の前の吹き上げ・後ろの吹き下ろし・翼端うずといった特徴が出る。
//
// 座標は機体座標（aero.js と同じ）：x 前、y 右、z 上。原点は重心。単位 m・m/s。
// 空気は前から後ろへ流れる。迎え角 α のときの流れ：V (-cos α, 0, +sin α)。

import { coefficients, makeAirframe } from './flight.js';

const RAD = Math.PI / 180;

/**
 * うずのモデルを作る
 * @param aero analyzeAirplane の結果
 * @param {{ V, alpha, panels }} o 速さ [m/s]、迎え角 [rad]、翼幅方向の区切りの数
 */
export function buildVortexModel(aero, { V = 8, alpha = 4 * RAD, panels = 16 } = {}) {
  const af = makeAirframe(aero);
  const { CL, CD } = coefficients(af, alpha);
  const strips = aero.strips ?? [];
  const b = aero.span;
  const freestream = [-V * Math.cos(alpha), 0, V * Math.sin(alpha)];
  const model = { V, alpha, CL, CD, freestream, segments: [], panels: [], span: b, core: Math.max(0.004, b * 0.03) };
  if (!strips.length || b <= 0 || !af.hasWing) return model;

  // 帯をまとめて panels 個の区切りにする
  const yMin = Math.min(...strips.map((s) => s.y - s.w / 2));
  const yMax = Math.max(...strips.map((s) => s.y + s.w / 2));
  const dy = (yMax - yMin) / panels;
  // 楕円分布の循環：Γ(y) = Γ0 √(1 - (2y'/b)²)、全体の揚力 L = ρ V ∫Γ dy = ½ρV²S CL → Γ0 = 2 V S CL / (π b)
  const yc = (yMin + yMax) / 2;
  const G0 = (2 * V * aero.wingArea * CL) / (Math.PI * b);
  const far = Math.max(1, aero.length * 6); // 後ろへ伸びるうずの長さ
  for (let k = 0; k < panels; k++) {
    const y0 = yMin + k * dy;
    const y1 = y0 + dy;
    const ym = (y0 + y1) / 2;
    const inside = strips.filter((s) => s.y >= y0 && s.y < y1);
    if (!inside.length) continue;
    const lead = Math.max(...inside.map((s) => s.lead));
    const trail = Math.min(...inside.map((s) => s.trail));
    const xq = lead - 0.25 * (lead - trail); // 翼弦の 1/4
    const e = Math.max(0, 1 - ((2 * (ym - yc)) / b) ** 2);
    const G = G0 * Math.sqrt(e);
    model.panels.push({ y0, y1, ym, lead, trail, xq, G });
    // 馬てい形のうず：右後ろ → 1/4 翼弦の線（右から左）→ 左後ろ。
    // 流れが -x 向きなので、クッタ・ジューコフスキーの定理 L = ρ V × Γ で揚力が上向きになる向き
    const A = [xq, y0, 0];
    const B = [xq, y1, 0];
    model.segments.push({ a: [xq - far, y1, 0], b: B, G });
    model.segments.push({ a: B, b: A, G });
    model.segments.push({ a: A, b: [xq - far, y0, 0], G });
  }
  return model;
}

// 線分 a→b を流れる強さ G のうずが、点 P に作る速さ（芯の半径 rc でなめらかにする）
function segmentVelocity(P, a, b, G, rc) {
  const r1 = [P[0] - a[0], P[1] - a[1], P[2] - a[2]];
  const r2 = [P[0] - b[0], P[1] - b[1], P[2] - b[2]];
  const cx = r1[1] * r2[2] - r1[2] * r2[1];
  const cy = r1[2] * r2[0] - r1[0] * r2[2];
  const cz = r1[0] * r2[1] - r1[1] * r2[0];
  const c2 = cx * cx + cy * cy + cz * cz;
  const n1 = Math.hypot(r1[0], r1[1], r1[2]);
  const n2 = Math.hypot(r2[0], r2[1], r2[2]);
  if (n1 < 1e-9 || n2 < 1e-9) return [0, 0, 0];
  const r0 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L2 = r0[0] * r0[0] + r0[1] * r0[1] + r0[2] * r0[2];
  const k = (r0[0] * (r1[0] / n1 - r2[0] / n2) + r0[1] * (r1[1] / n1 - r2[1] / n2) + r0[2] * (r1[2] / n1 - r2[2] / n2));
  // 線の近く（芯の半径 rc の中）では、うずの速さが無限大にならないよう弱める
  const f = (G / (4 * Math.PI)) * k / (c2 + rc * rc * L2);
  return [cx * f, cy * f, cz * f];
}

// 点 P（機体座標）での空気の速さ
export function velocityAt(model, P) {
  let v = model.freestream.slice();
  for (const s of model.segments) {
    const u = segmentVelocity(P, s.a, s.b, s.G, model.core);
    v[0] += u[0]; v[1] += u[1]; v[2] += u[2];
  }
  return v;
}

/**
 * 翼の上下の圧力係数（平らな板の薄翼理論の近似）
 * 前のふち近くほど上面の負圧（吸い上げ）が強く、後ろのふちで 0 になる：ΔCp = 4 α_e √((1-ξ)/ξ)
 * @returns {{ upper, lower }} Cp（負なら周りより低い圧力）。ξ は前のふちからの割合
 */
export function surfaceCp(model, x, y) {
  const p = model.panels.find((q) => y >= q.y0 && y < q.y1);
  if (!p || p.lead - p.trail <= 0) return { upper: 0, lower: 0 };
  const xi = Math.min(0.995, Math.max(0.01, (p.lead - x) / (p.lead - p.trail)));
  // その区切りの局所の揚力係数から、有効な迎え角を逆算する（楕円分布なら翼端ほど小さい）
  const cl = (2 * p.G) / (model.V * (p.lead - p.trail));
  const aEff = cl / (2 * Math.PI);
  const dCp = 4 * aEff * Math.sqrt((1 - xi) / xi);
  return { upper: -dCp / 2, lower: dCp / 2 };
}

/**
 * 流れの線（流線）を、上流から何本か流して求める
 * @param seeds 出発点の配列（機体座標）
 * @returns 線ごとの点列 [{ pts: [[x,y,z],...], speed: [...] }]
 */
export function traceStreamlines(model, seeds, { step = 0.01, length = 1.2 } = {}) {
  const lines = [];
  const n = Math.ceil(length / step);
  for (const s of seeds) {
    let P = s.slice();
    const pts = [P.slice()];
    const speed = [];
    for (let i = 0; i < n; i++) {
      // 2 次のルンゲ・クッタ（速さで割って、進む距離を一定にする）
      const v1 = velocityAt(model, P);
      const m1 = Math.hypot(...v1) || 1;
      const mid = [P[0] + (v1[0] / m1) * step / 2, P[1] + (v1[1] / m1) * step / 2, P[2] + (v1[2] / m1) * step / 2];
      const v2 = velocityAt(model, mid);
      const m2 = Math.hypot(...v2) || 1;
      P = [P[0] + (v2[0] / m2) * step, P[1] + (v2[1] / m2) * step, P[2] + (v2[2] / m2) * step];
      pts.push(P.slice());
      speed.push(m2 / model.V);
    }
    speed.push(speed[speed.length - 1] ?? 1);
    lines.push({ pts, speed });
  }
  return lines;
}

/**
 * 投げた結果を読み解いて、飛距離が伸びなかった理由と、直すコツを挙げる
 * @param flight simulateThrow の結果（swing, wind があれば使う）
 * @param aero analyzeAirplane の結果
 * @returns {{ findings: [{ level, title, text, fix }], stats }} level は 'good' | 'warn' | 'bad'
 */
export function diagnose(flight, aero) {
  const af = makeAirframe(aero);
  const path = flight.path ?? [];
  const stallA = af.alphaStall;
  let stallT = 0, maxA = -Infinity, minA = Infinity, maxV = 0, minV = Infinity, prevT = 0, steepDive = 0;
  let sumLD = 0, nLD = 0;
  let prevP = null;
  for (const p of path) {
    const dt = p.t - prevT;
    prevT = p.t;
    // 進む向きが水平から 25° 以上下を向いていたら「急降下」
    if (prevP) {
      const dz = p.pos[2] - prevP.pos[2];
      const dh = Math.hypot(p.pos[0] - prevP.pos[0], p.pos[1] - prevP.pos[1]);
      if (dz < 0 && Math.atan2(-dz, dh) > 25 * RAD && Math.abs(p.alpha) < stallA) steepDive += dt;
    }
    prevP = p;
    maxA = Math.max(maxA, p.alpha); minA = Math.min(minA, p.alpha);
    maxV = Math.max(maxV, p.V); minV = Math.min(minV, p.V);
    if (Math.abs(p.alpha) > stallA) stallT += dt;
    if (Math.abs(p.alpha) < stallA) {
      const { CL, CD } = coefficients(af, p.alpha);
      if (CD > 0) { sumLD += CL / CD; nLD++; }
    }
  }
  const T = Math.max(flight.time, 1e-6);
  const stats = {
    time: flight.time,
    distance: flight.distance,
    maxAlpha: maxA / RAD,
    minAlpha: minA / RAD,
    stallFraction: stallT / T,
    diveFraction: steepDive / T,
    maxV, minV,
    meanLD: nLD ? sumLD / nLD : 0,
    bestLD: bestGlide(af),
  };
  const out = [];
  const add = (level, title, text, fix) => out.push({ level, title, text, fix });

  if (!af.hasWing || aero.wingArea * 1e4 < 5) {
    add('bad', '翼がほとんどない', '真上から見た翼の面積がとても小さく、揚力が出ません。', '翼を広げる（翼のスライダーを小さくする）か、翼の広い折り方にしよう。');
  }
  if (stats.stallFraction > 0.15) {
    add('bad', '失速している', `飛んでいる時間の ${Math.round(stats.stallFraction * 100)}% で、迎え角が失速角（約 ${Math.round(stallA / RAD)}°）を超えて、揚力が落ちています。`,
      aero.staticMargin < 0 ? '重心が後ろすぎます。先を少し重くする（先を折り込む）と安定します。' : '強く投げすぎか、上向きに投げすぎです。強さや角度を少し下げよう。後ろのふちを上げすぎていたら戻そう。');
  } else if (stats.stallFraction > 0) {
    add('warn', '一瞬だけ失速', '投げた直後などに、迎え角が大きくなりすぎた瞬間がありました。', '投げる角度を少し下げると、なめらかに飛び出せます。');
  }
  if (stats.diveFraction > 0.3) {
    add('bad', '急降下している', '機首が大きく下を向いたまま落ちています。', aero.staticMargin > 0.25 ? '機首が重すぎます。翼の後ろのふちを少し上げる（昇降舵）と、機首が上がって滑空します。' : '翼の後ろのふちを少し上げてみよう。');
  }
  if (aero.dihedral < -5) {
    add('warn', '翼が下向き（下反角）', `翼が ${Math.abs(aero.dihedral).toFixed(0)}° 下がっていて、傾くとそのまま傾き続けやすい形です。`, '翼のスライダーを少し小さくして、翼を水平〜少し上向きにしよう。');
  }
  if (aero.symmetry < 0.95 || Math.abs(aero.rollTrim) > 0.001) {
    add('warn', '左右がそろっていない', '左右の翼の形や角度がずれていて、片側に曲がる力がはたらきます。', '「左右の翼をいっしょに動かす」をオンにして、左右の開き具合をそろえよう。');
  }
  if (Math.abs(flight.lateral ?? 0) > Math.max(1, flight.distance * 0.15)) {
    const sw = flight.swing;
    const by = sw && sw.grade !== 'just' ? '投げるタイミングのずれ' : flight.wind && flight.wind.speed > 0.5 ? '横風' : '機体の左右差';
    add('warn', `${flight.lateral > 0 ? '左' : '右'}へ ${Math.abs(flight.lateral).toFixed(1)} m 曲がった`, `おもな原因は、${by}です。曲がったぶん、まっすぐの距離が短くなっています。`, by === '横風' ? '風上へ少し向きを変えて投げよう（←→）。' : by.startsWith('投げる') ? '3 回目のボタンを白い「ジャスト」に合わせよう。' : '左右の翼の開き具合をそろえよう。');
  }
  if (flight.wind && flight.wind.speed >= 0.8) {
    const head = -Math.cos(flight.wind.dir - (flight.yaw ?? 0) * RAD) * flight.wind.speed;
    if (head > 0.8) add('warn', '向かい風', `${head.toFixed(1)} m/s の向かい風で、空気に対する速さは出ても、地面に対しては進みにくくなっていました。`, '向かい風では、低めの角度で強めに投げよう。');
    else if (head < -0.8) add('good', '追い風', `${(-head).toFixed(1)} m/s の追い風に乗りました。`, '追い風のときは、少し高めに投げると長く風に乗れます。');
  }
  if (stats.meanLD > 0 && stats.bestLD > 0 && stats.meanLD < stats.bestLD * 0.6 && stats.stallFraction < 0.15) {
    add('warn', '効率のよい迎え角で飛べていない', `平均の揚抗比は ${stats.meanLD.toFixed(1)}（この機体の最高は ${stats.bestLD.toFixed(1)}）。迎え角が小さすぎて、揚力をうまく使えていません。`, '翼の後ろのふちを少し上げると、迎え角が増えて、ゆっくり長く滑空します。');
  }
  if (!out.some((f) => f.level !== 'good')) {
    add('good', 'きれいに飛べた', '失速も急降下もなく、安定して飛びました。', 'もっと遠くへは、翼を広く・軽くするか、ジャストで強めに投げよう。');
  }
  return { findings: out, stats };
}

// この機体のいちばんよい揚抗比（L/D）
export function bestGlide(af) {
  let best = 0;
  for (let a = 0; a <= af.alphaStall; a += 0.25 * RAD) {
    const { CL, CD } = coefficients(af, a);
    if (CD > 0) best = Math.max(best, CL / CD);
  }
  return best;
}
