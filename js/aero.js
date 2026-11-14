// 紙飛行機の形の解析（描画ライブラリに依存しない純粋なロジック）
//
// 折り紙シミュレーターの状態（面の集合と手順の角度）から、飛び方を決める値を取り出す。
//
//   - 質量・重心：面ごとの面積に紙の坪量をかけて足し合わせる（重なった所は重くなる）
//   - 機体の向き：
//       上下 … 面の向き（法線）が一番そろっている方向。翼は水平なので翼の法線が上下になる
//       左右 … 上下の成分を除いた法線が一番そろっている方向。胴（キール）は縦の面なので左右を向く
//       前後 … 上下と左右に垂直な方向。翼の面積が少ない（とがった）側を機首とする
//       上向き … キールが翼より下になる向き
//   - 翼：機体を真上から見た形（平面形）を細かいマス目で塗って、面積・翼幅・翼弦などを求める
//     （重なった紙を二重に数えないため）
//   - 静安定余裕：重心が空力中心（各翼弦の前から 1/4 の点の平均）よりどれだけ前にあるか
//   - 上反角・左右の対称性
//
// 座標は折り紙シミュレーターの単位（紙の幅 2 など）。実寸は options.metersPerUnit で変換する。

import { poseFaces, signedArea } from './paper.js';

const DEG = 180 / Math.PI;

// ---------------------------------------------------------------- ベクトル

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = norm(a); return l < 1e-12 ? [0, 0, 0] : scale(a, 1 / l); };

// 対称 3x3 行列の、一番大きい固有値の固有ベクトル（べき乗法。行列は半正定値）
function principalAxis(M, guess = [0, 0, 1]) {
  // 初期値が固有ベクトルと直交していても収束するよう、少しずらす
  let v = unit(add(guess, [0.031, 0.017, 0.007]));
  for (let it = 0; it < 200; it++) {
    const w = [dot(M[0], v), dot(M[1], v), dot(M[2], v)];
    const l = norm(w);
    if (l < 1e-15) return null;
    const nv = scale(w, 1 / l);
    if (norm(sub(nv, v)) < 1e-12) { v = nv; break; }
    v = nv;
  }
  return v;
}

function outerAdd(M, n, w) {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += w * n[i] * n[j];
}

// ---------------------------------------------------------------- 面

// 3D の多角形の面積・重心・単位法線
function polygonInfo(pts) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const area = Math.hypot(nx, ny, nz) / 2;
  const n = unit([nx, ny, nz]);
  // 三角形に分けて面積重心を求める
  let c = [0, 0, 0];
  let tot = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const t = norm(cross(sub(pts[i], pts[0]), sub(pts[i + 1], pts[0]))) / 2;
    c = add(c, scale(add(add(pts[0], pts[i]), pts[i + 1]), t / 3));
    tot += t;
  }
  return { area, n, c: tot > 0 ? scale(c, 1 / tot) : pts[0] };
}

// ---------------------------------------------------------------- 平面形（マス目塗り）

// 2D の凸多角形（反時計回りでも時計回りでもよい）に点が入っているか
function inConvex(poly, x, y) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (Math.abs(c) < 1e-14) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// 多角形の集合（2D）をマス目で塗る。重なりは一度だけ数える
// 戻り値: { grid: Uint8Array, nx, ny, x0, y0, h }
function rasterize(polys, res) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) for (const [x, y] of p) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  if (!isFinite(minX)) return null;
  const size = Math.max(maxX - minX, maxY - minY, 1e-9);
  const h = size / res;
  const nx = Math.max(1, Math.ceil((maxX - minX) / h) + 1);
  const ny = Math.max(1, Math.ceil((maxY - minY) / h) + 1);
  const grid = new Uint8Array(nx * ny);
  for (const p of polys) {
    let pminX = Infinity, pminY = Infinity, pmaxX = -Infinity, pmaxY = -Infinity;
    for (const [x, y] of p) {
      pminX = Math.min(pminX, x); pmaxX = Math.max(pmaxX, x);
      pminY = Math.min(pminY, y); pmaxY = Math.max(pmaxY, y);
    }
    const i0 = Math.max(0, Math.floor((pminX - minX) / h));
    const i1 = Math.min(nx - 1, Math.ceil((pmaxX - minX) / h));
    const j0 = Math.max(0, Math.floor((pminY - minY) / h));
    const j1 = Math.min(ny - 1, Math.ceil((pmaxY - minY) / h));
    for (let j = j0; j <= j1; j++) {
      const y = minY + (j + 0.5) * h;
      for (let i = i0; i <= i1; i++) {
        if (grid[j * nx + i]) continue;
        if (inConvex(p, minX + (i + 0.5) * h, y)) grid[j * nx + i] = 1;
      }
    }
  }
  return { grid, nx, ny, x0: minX, y0: minY, h };
}

// ---------------------------------------------------------------- 解析

export const DEFAULT_OPTIONS = {
  metersPerUnit: 0.15 / 2, // 紙の幅 2 を 15cm（折り紙の標準サイズ）とする
  gsm: 70,                 // 紙の坪量 [g/m²]（折り紙用紙は 60〜80 程度）
  resolution: 160,         // 平面形を塗るマス目の細かさ（長い方の辺の分割数）
  liftCos: Math.cos(50 / DEG), // 法線と上下の角が 50° 以内の面を「翼」とみなす
};

/**
 * 紙飛行機の形を解析する
 * @param {object} state 折り紙シミュレーターの状態
 * @param {object} [options]
 *   angles: 手順ごとの開き具合（省略時は state の値）
 *   metersPerUnit, gsm, resolution: DEFAULT_OPTIONS を参照
 *   axes: { up, forward }（3D ベクトル）を指定すると、機体の向きの自動判定を使わない
 * @returns 解析結果（単位は SI。長さ m、面積 m²、質量 kg、角度 度）
 */
export function analyzeAirplane(state, options = {}) {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  const m = opt.metersPerUnit;
  const posed = poseFaces(state, opt.angles);

  // 各面の 3D 情報。質量は展開図上の面積で決まる（姿勢で変わらない）
  const rho = (opt.gsm / 1000) * m * m; // 単位面積（シミュレーター単位）あたりの質量 [kg]
  const faces = posed.map(({ face, pts }) => {
    const info = polygonInfo(pts);
    const uvArea = Math.abs(signedArea(face.verts, 'uv'));
    return { pts, ...info, mass: uvArea * rho };
  }).filter((f) => f.area > 1e-12);
  if (!faces.length) return null;

  // 質量と重心
  let mass = 0;
  let cg = [0, 0, 0];
  for (const f of faces) { mass += f.mass; cg = add(cg, scale(f.c, f.mass)); }
  cg = scale(cg, 1 / mass);

  // ---- 機体の向き
  const axes = opt.axes ? fixedAxes(opt.axes) : detectAxes(faces, cg, opt);
  const { up, fwd, right } = axes;
  // 機体座標（前 x、右 y、上 z。原点は重心）
  const toBody = (P) => { const d = sub(P, cg); return [dot(d, fwd), dot(d, right), dot(d, up)]; };

  const bodyFaces = faces.map((f) => ({
    ...f,
    bp: f.pts.map(toBody),
    bc: toBody(f.c),
    nb: [dot(f.n, fwd), dot(f.n, right), dot(f.n, up)],
  }));

  // ---- 平面形（真上から見た形）：前 x・右 y の平面に投影
  const plan = rasterize(bodyFaces.map((f) => f.bp.map(([x, y]) => [x, y])), opt.resolution);
  const planform = analyzePlanform(plan);

  // ---- 横から見た形（キールの面積）：前 x・上 z の平面に投影
  const side = rasterize(bodyFaces.map((f) => f.bp.map(([x, , z]) => [x, z])), opt.resolution);
  let sideArea = 0;
  if (side) for (const g of side.grid) sideArea += g;
  sideArea *= side ? side.h * side.h : 0;

  // ---- 上反角：翼とみなす面の、左右方向の傾き（翼端が上がっていれば正）
  let dihW = 0, dihSum = 0;
  let wingL = 0, wingR = 0;
  for (const f of bodyFaces) {
    let [, ny, nz] = f.nb;
    if (Math.abs(nz) < opt.liftCos) continue;
    if (nz < 0) { ny = -ny; nz = -nz; }
    const yc = f.bc[1];
    if (Math.abs(yc) < 1e-6) continue;
    const tilt = Math.atan2(ny, nz) * DEG; // 右に傾くと正
    const d = -tilt * Math.sign(yc);
    const w = f.area * Math.abs(f.nb[2]);
    dihSum += d * w;
    dihW += w;
    if (yc > 0) wingR += w; else wingL += w;
  }

  // ---- 静安定余裕（重心は機体座標の原点）
  const mac = planform.mac;
  const staticMargin = mac > 0 ? (0 - planform.xAC) / mac : 0;

  const S = planform.area * m * m;
  const span = planform.span * m;
  return {
    mass,                                  // 質量 [kg]
    cg: scale(cg, m),                      // 重心（シミュレーターの座標を m にしたもの）
    axes: { up, forward: fwd, right },     // 機体の向き（シミュレーターの座標）
    autoAxes: !opt.axes,
    wingArea: S,                           // 翼面積（真上から見た面積） [m²]
    span,                                  // 翼幅 [m]
    length: planform.length * m,           // 全長 [m]
    rootChord: planform.rootChord * m,     // 中心の翼弦 [m]
    mac: mac * m,                          // 平均空力翼弦 [m]
    aspectRatio: S > 0 ? (span * span) / S : 0,
    wingLoading: S > 0 ? (mass * 9.81) / S : Infinity, // 翼面荷重 [N/m²]
    sideArea: sideArea * m * m,            // 横から見た面積（キール） [m²]
    cgFromNose: (planform.xNose - 0) * m,  // 機首から重心までの距離 [m]
    acFromNose: (planform.xNose - planform.xAC) * m, // 機首から空力中心までの距離 [m]
    staticMargin,                          // 静安定余裕（平均翼弦に対する割合。正なら安定）
    dihedral: dihW > 0 ? dihSum / dihW : 0, // 上反角 [度]
    symmetry: planform.symmetry,           // 平面形の左右対称性（1 なら完全に対称）
    lateralOffset: planform.span > 0 ? planform.yCentroid / planform.span : 0, // 平面形の中心の左右のずれ（翼幅に対する割合。正なら右）
    wingBalance: wingL + wingR > 0 ? (wingR - wingL) / (wingL + wingR) : 0,     // 左右の翼の面積の差（正なら右が大きい）
  };
}

// 指定された向きから、直交する 3 軸を作る
function fixedAxes({ up, forward }) {
  const u = unit(up);
  const f = unit(sub(forward, scale(u, dot(forward, u))));
  return { up: u, fwd: f, right: cross(f, u) };
}

// 面の向きと配置から、機体の上下・前後・左右を判定する
function detectAxes(faces, cg, opt) {
  // 左右：機体を左右に折り返したときに一番よく重なる方向（対称面の法線）。
  // 候補は、面の法線の分布と点の広がりの主軸（それぞれ 3 本）
  const pts = samplePoints(faces);
  const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const f of faces) outerAdd(N, f.n, f.area);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const P of pts) outerAdd(C, sub(P, cg), 1);
  const candidates = [...eigenAxes(N), ...eigenAxes(C)];
  let lat = null;
  let best = Infinity;
  // 紙が平らに広がっている面そのもの（厚みのない方向）は対称面にしない
  const spread = (v) => dot([dot(C[0], v), dot(C[1], v), dot(C[2], v)], v);
  const maxSpread = Math.max(...candidates.map(spread));
  for (const c of candidates) {
    if (spread(c) < 0.01 * maxSpread) continue;
    const e = mirrorError(pts, cg, c);
    if (e < best - 1e-9) { best = e; lat = c; }
  }
  lat = lat ?? [1, 0, 0];

  // 上下：対称面に投影した法線が一番そろっている方向。
  // キールの法線はほぼ左右を向くので、投影すると小さくなり、翼の法線が残る
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let wSum = 0;
  for (const f of faces) {
    const t = sub(f.n, scale(lat, dot(f.n, lat)));
    const w = f.area * dot(t, t);
    if (w > 1e-15) { outerAdd(M, unit(t), w); wSum += w; }
  }
  let up = wSum > 0 ? principalAxis(M, perpendicular(lat)) : perpendicular(lat);
  up = unit(sub(up, scale(lat, dot(up, lat))));
  let fwd = unit(cross(lat, up));

  // 上向き：縦の面（キール）が翼より下にくる向き
  let zKeel = 0, wKeel = 0, zWing = 0, wWing = 0;
  for (const f of faces) {
    const c = Math.abs(dot(f.n, up));
    const z = dot(sub(f.c, cg), up);
    if (c >= opt.liftCos) { zWing += z * f.area; wWing += f.area; }
    else { zKeel += z * f.area; wKeel += f.area; }
  }
  if (wKeel > 0 && wWing > 0 && zKeel / wKeel > zWing / wWing) up = scale(up, -1);

  // 前向き：翼の面積が少ない（とがった）側を機首にする
  let lo = Infinity, hi = -Infinity;
  for (const P of pts) {
    const x = dot(sub(P, cg), fwd);
    lo = Math.min(lo, x); hi = Math.max(hi, x);
  }
  const mid = (lo + hi) / 2;
  let front = 0, back = 0;
  for (const f of faces) {
    const w = f.area * Math.abs(dot(f.n, up));
    if (dot(sub(f.c, cg), fwd) > mid) front += w; else back += w;
  }
  if (front > back + 1e-9) fwd = scale(fwd, -1);
  return { up, fwd, right: cross(fwd, up) };
}

// 対称 3x3 行列の固有ベクトル 3 本（大きい順。べき乗法とデフレーション）
function eigenAxes(M) {
  const A = M.map((r) => r.slice());
  const out = [];
  for (let k = 0; k < 3; k++) {
    let v = k === 2 && out.length === 2 ? unit(cross(out[0], out[1])) : principalAxis(A, [0.3, 0.5, 0.8]);
    if (!v || norm(v) < 0.5) {
      // 固有値が 0：残りの方向から作る
      v = out.length === 0 ? [1, 0, 0] : out.length === 1 ? perpendicular(out[0]) : unit(cross(out[0], out[1]));
    }
    for (const o of out) v = sub(v, scale(o, dot(v, o)));
    v = unit(v);
    const lam = dot([dot(A[0], v), dot(A[1], v), dot(A[2], v)], v);
    outerAdd(A, v, -lam);
    out.push(v);
  }
  return out;
}

// 面の上に、ほぼ等間隔に点をとる
function samplePoints(faces, target = 1500) {
  const total = faces.reduce((s, f) => s + f.area, 0);
  const spacing = Math.sqrt(total / target);
  const pts = [];
  for (const f of faces) {
    const P = f.pts;
    for (let i = 1; i + 1 < P.length; i++) {
      const a = P[0], b = P[i], c = P[i + 1];
      const n = Math.max(1, Math.ceil(Math.max(norm(sub(b, a)), norm(sub(c, a)), norm(sub(c, b))) / spacing));
      for (let p = 0; p <= n; p++) {
        for (let q = 0; p + q <= n; q++) {
          const r = n - p - q;
          pts.push(scale(add(add(scale(a, r), scale(b, p)), scale(c, q)), 1 / n));
        }
      }
    }
  }
  return pts;
}

// 点の集合を、cg を通り法線 n の面で折り返したときの、最寄り点までの距離の平均
function mirrorError(pts, cg, n) {
  const step = Math.max(1, Math.floor(pts.length / 400));
  let sum = 0, cnt = 0;
  for (let i = 0; i < pts.length; i += step) {
    const P = pts[i];
    const d = dot(sub(P, cg), n);
    const Q = sub(P, scale(n, 2 * d));
    let m = Infinity;
    for (const R of pts) {
      const dx = R[0] - Q[0], dy = R[1] - Q[1], dz = R[2] - Q[2];
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < m) m = dd;
    }
    sum += Math.sqrt(m);
    cnt++;
  }
  return sum / cnt;
}

function perpendicular(v) {
  const a = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(cross(v, a));
}

// up に垂直な面内で、頂点の広がりが一番小さい方向
function shortAxis(faces, cg, up) {
  const e1 = perpendicular(up);
  const e2 = cross(up, e1);
  let sxx = 0, sxy = 0, syy = 0;
  for (const f of faces) for (const P of f.pts) {
    const d = sub(P, cg);
    const x = dot(d, e1), y = dot(d, e2);
    sxx += x * x; sxy += x * y; syy += y * y;
  }
  // 2x2 の小さい方の固有ベクトル
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy) + Math.PI / 2;
  return unit(add(scale(e1, Math.cos(th)), scale(e2, Math.sin(th))));
}

// 平面形のマス目から、翼の寸法と空力中心を求める（x が前、y が右）
function analyzePlanform(plan) {
  const empty = { area: 0, span: 0, length: 0, rootChord: 0, mac: 0, xAC: 0, xNose: 0, yCentroid: 0, symmetry: 1 };
  if (!plan) return empty;
  const { grid, nx, ny, x0, y0, h } = plan;
  const cell = h * h;
  let count = 0;
  let sumY = 0;
  let xNose = -Infinity, xTail = Infinity;
  let yMin = Infinity, yMax = -Infinity;
  // 翼弦方向（x）ごとではなく、翼幅方向（y）の列ごとに翼弦を測る
  let sumC = 0, sumC2 = 0, sumAC = 0;
  let rootChord = 0, rootDist = Infinity;
  for (let j = 0; j < ny; j++) {
    const y = y0 + (j + 0.5) * h;
    let lead = -Infinity, trail = Infinity, n = 0;
    for (let i = 0; i < nx; i++) {
      if (!grid[j * nx + i]) continue;
      const x = x0 + (i + 0.5) * h;
      n++;
      lead = Math.max(lead, x + h / 2);
      trail = Math.min(trail, x - h / 2);
    }
    if (!n) continue;
    count += n;
    sumY += n * y;
    xNose = Math.max(xNose, lead);
    xTail = Math.min(xTail, trail);
    yMin = Math.min(yMin, y - h / 2);
    yMax = Math.max(yMax, y + h / 2);
    const c = n * h; // 塗られた長さ（穴は除く）
    sumC += c * h;
    sumC2 += c * c * h;
    sumAC += (lead - 0.25 * (lead - trail)) * c * h; // 前から 1/4 の点を翼弦で重み付け
    if (Math.abs(y) < rootDist) { rootDist = Math.abs(y); rootChord = c; }
  }
  if (!count) return empty;
  const area = count * cell;
  // 左右対称性：y=0（重心を通る前後の線）で折り返して重なる割合
  let same = 0;
  for (let j = 0; j < ny; j++) {
    const y = y0 + (j + 0.5) * h;
    const jm = Math.round((-y - y0) / h - 0.5);
    for (let i = 0; i < nx; i++) {
      if (!grid[j * nx + i]) continue;
      if (jm >= 0 && jm < ny && grid[jm * nx + i]) same++;
    }
  }
  return {
    area,
    span: yMax - yMin,
    length: xNose - xTail,
    rootChord,
    mac: sumC > 0 ? sumC2 / sumC : 0,
    xAC: sumC > 0 ? sumAC / sumC : 0,
    xNose,
    yCentroid: sumY / count,
    symmetry: same / count,
  };
}
