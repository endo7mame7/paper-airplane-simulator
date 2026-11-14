// 紙飛行機の飛行シミュレーション（描画ライブラリに依存しない純粋なロジック）
//
// aero.js の解析結果（重さ・翼の面積・静安定余裕など）から、投げた紙飛行機の動きを計算する。
//
// 座標（地面に固定）: x 前（投げる方向）、y 左、z 上。単位は m・s・kg・rad。
//
// 機体の動き
//   - 重心の位置と速度（3 次元）
//   - ピッチ角 θ（機首の上下）とその角速度 q：迎え角が決まり、揚力・抗力が変わる
//   - バンク角 φ（左右の傾き。右の翼が下がると正）とその角速度 p：揚力が傾いて曲がる
//   機首は常に進む方向（左右）を向くとする（胴＝キールが風見鶏のようにはたらく）。
//
// 空気の力
//   揚力係数 CL：縦横比の小さい翼の揚力傾斜（Helmbold の式）で迎え角に比例し、
//                失速角を越えると平らな板の値（sin 2α）に移る
//   抗力係数 CD：形の抗力 + 誘導抗力（CL² / πeAR）+ 失速後の板の抗力
//   ピッチモーメント：静安定余裕（重心と空力中心の距離）・昇降舵・失速後の圧力中心の移動・ダンピング
//   ロールモーメント：左右の揚力のずれ・補助翼・上反角の復元・ダンピング

export const G = 9.81;
export const AIR = 1.2; // 空気の密度 [kg/m³]

export const DEFAULT_THROW = {
  speed: 8,        // 投げる速さ [m/s]
  angle: 5,        // 投げる角度（上向きが正） [度]
  height: 1.6,     // 手を離す高さ [m]
  yaw: 0,          // 左右の向き（左が正） [度]
  pitch: undefined, // 機首の角度 [度]。省略時は投げる角度と同じ（迎え角 0）
  bank: 0,         // 投げるときの傾き（右が下がると正） [度]
};

export const DEFAULT_SIM = {
  dt: 0.001,       // 計算の刻み [s]
  maxTime: 60,     // これ以上は計算しない [s]
  sampleEvery: 1 / 60, // 軌跡を記録する間隔 [s]
  wind: [0, 0, 0], // 風 [m/s]（地面の座標）
  cd0: 0.04,       // 紙の形の抗力係数（翼の面積あたり）
  oswald: 0.8,     // 翼効率 e
};

const RAD = Math.PI / 180;

// ---------------------------------------------------------------- 空力係数

// 解析結果から、飛行計算に使う定数をまとめる
export function makeAirframe(a, sim = {}) {
  const o = { ...DEFAULT_SIM, ...sim };
  const S = Math.max(a.wingArea, 1e-6);
  const hasWing = a.wingArea > 1e-5;
  const AR = Math.max(a.aspectRatio, 0.05);
  const span = Math.max(a.span, 1e-3);
  const mac = Math.max(a.mac, 1e-3);
  // 縦横比の小さい翼の揚力傾斜（Helmbold） [1/rad]
  const CLa = hasWing ? (2 * Math.PI * AR) / (2 + Math.sqrt(AR * AR + 4)) : 0;
  // 縦横比が小さいほど失速しにくい
  const alphaStall = Math.min(35, 14 + 10 / AR) * RAD;
  const [Ixx, Iyy] = a.inertia;
  // ダンピング係数（翼の帯ごとの揚力から見積もった、無次元の値）
  const Cmq = -CLa * Math.max(1, (a.length / mac) ** 2) / 4 - 0.5;
  const Clp = -CLa / 6 - 0.1;
  return {
    mass: a.mass,
    S, span, mac, AR, CLa, alphaStall,
    hasWing,
    // 胴（キール）の面積も形の抗力に加える
    cd0: o.cd0 * (1 + a.sideArea / S),
    k: 1 / (Math.PI * o.oswald * AR),
    staticMargin: a.staticMargin,
    cm0: CLa * a.pitchTrim,
    // 左右の揚力のずれ（翼幅に対する割合）と補助翼
    yLift: a.lateralOffset,
    cl0: CLa * a.rollTrim,
    // 上反角による復元：横すべり角あたりのロールモーメント係数（Clβ ≈ -CLα·Γ/4 の符号を反転）
    clDihedral: (CLa * Math.sin(a.dihedral * RAD)) / 4,
    // 胴（キール）が大きいほど、機首が速く進む向きにそろう [1/m]（速さをかけると 1/s）
    yawFollow: 2 + 8 * Math.min(1, a.sideArea / Math.max(a.wingArea * 0.3, 1e-6)),
    Cmq, Clp,
    Ixx: Math.max(Ixx, 1e-9),
    Iyy: Math.max(Iyy, 1e-9),
    // 翼がないときは、紙のかたまりとして抗力だけを受ける
    blobArea: Math.max(a.sideArea, a.wingArea, 1e-4),
  };
}

// 失速していない度合い（1：失速前、0：失速後）
function stallBlend(af, alpha) {
  const al = Math.atan2(Math.sin(alpha), Math.cos(alpha));
  return 1 / (1 + Math.exp((Math.abs(al) - af.alphaStall) / (3 * RAD)));
}

// 迎え角 α [rad] での揚力係数・抗力係数
export function coefficients(af, alpha) {
  if (!af.hasWing) return { CL: 0, CD: 1.2 };
  // -π..π にそろえる
  const al = Math.atan2(Math.sin(alpha), Math.cos(alpha));
  const lin = af.CLa * al;
  const plate = 1.0 * Math.sin(2 * al); // 失速後の板
  // 失速角のまわりでなめらかに切り替える
  const t = stallBlend(af, al);
  // 線形の揚力は失速角を越えて大きくならないよう、失速角の値で頭打ちにする
  const linCapped = Math.sign(lin) * Math.min(Math.abs(lin), af.CLa * af.alphaStall);
  const CL = t * linCapped + (1 - t) * plate;
  const s = Math.sin(al);
  const CD = af.cd0 + af.k * CL * CL * t + 2 * s * s * (1 - t) + 0.1 * s * s;
  return { CL, CD };
}

// ---------------------------------------------------------------- ベクトル

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = norm(a); return l < 1e-12 ? [0, 0, 0] : scale(a, 1 / l); };

// ---------------------------------------------------------------- 運動方程式

// 状態 s = { pos, vel, theta, q, phi, p, psi }
//   theta: ピッチ角（水平から機首の上向き）、phi: バンク角、psi: 機首の左右の向き（左が正）
function derivatives(af, s, wind) {
  const air = sub(s.vel, wind); // 空気に対する速度
  const V = norm(air);
  const ev = V > 1e-6 ? scale(air, 1 / V) : [Math.cos(s.psi), Math.sin(s.psi), 0];
  // 経路角（空気に対する進む向きの上下）
  const gamma = Math.asin(Math.max(-1, Math.min(1, ev[2])));
  const alpha = s.theta - gamma;
  const { CL, CD } = coefficients(af, alpha);
  const qd = 0.5 * AIR * V * V;

  // 揚力の向き：進む向きに垂直で、バンク角だけ傾けた「上」
  let upPerp = sub([0, 0, 1], scale(ev, ev[2]));
  if (norm(upPerp) < 1e-6) {
    // 真上・真下に進んでいるとき：機首の向きの反対側を「上」とする
    upPerp = [-Math.cos(s.psi) * Math.sign(ev[2]), -Math.sin(s.psi) * Math.sign(ev[2]), 0];
  }
  upPerp = unit(upPerp);
  const right = cross(ev, upPerp);
  const liftDir = add(scale(upPerp, Math.cos(s.phi)), scale(right, Math.sin(s.phi)));

  let force;
  if (af.hasWing) {
    force = add(scale(liftDir, qd * af.S * CL), scale(ev, -qd * af.S * CD));
  } else {
    force = scale(ev, -qd * af.blobArea * CD);
  }
  force = add(force, [0, 0, -af.mass * G]);
  const acc = scale(force, 1 / af.mass);

  // ---- ピッチ（機首上げが正）
  let Mpitch = 0;
  let Mroll = 0;
  if (af.hasWing && V > 1e-6) {
    const sa = Math.sin(alpha);
    const ca = Math.cos(alpha);
    const CN = CL * ca + CD * sa; // 翼に垂直な力
    // 失速して迎え角が大きくなると、圧力中心が翼弦の 1/4 から 1/2 へ下がる
    const cpShift = 0.25 * Math.abs(sa) * (1 - stallBlend(af, alpha));
    const Cm = af.cm0 - af.staticMargin * CL - CN * cpShift
      + af.Cmq * (s.q * af.mac) / (2 * V);
    Mpitch = qd * af.S * af.mac * Cm;

    // ---- ロール（右の翼が下がるのが正）
    // 傾くと重力で低い方へ横すべりし、キールが機首を向け直すまでの間だけ横すべりが残る
    const beta = (G * Math.sin(s.phi) * Math.cos(gamma)) / (V * V * af.yawFollow);
    const Cl = -af.yLift * CL - af.cl0
      - af.clDihedral * Math.max(-0.5, Math.min(0.5, beta))
      + af.Clp * (s.p * af.span) / (2 * V);
    Mroll = qd * af.S * af.span * Cl;
  }
  // 空気がほとんど当たらないときも回転が止まるよう、わずかに空気抵抗の減衰を入れる
  Mpitch -= 1e-7 * s.q;
  Mroll -= 1e-7 * s.p;

  // 機首の左右の向きは、空気に対して進む向きに追従する
  const psiAir = Math.atan2(air[1], air[0]);
  const horiz = Math.hypot(air[0], air[1]);
  let dpsi = 0;
  if (horiz > 0.05) {
    let d = psiAir - s.psi;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    dpsi = d * Math.min(30, horiz * af.yawFollow);
  }

  return {
    pos: s.vel,
    vel: acc,
    theta: s.q,
    q: Mpitch / af.Iyy,
    phi: s.p,
    p: Mroll / af.Ixx,
    psi: dpsi,
    info: { V, alpha, gamma, CL, CD },
  };
}

function step(af, s, dt, wind) {
  // 4 次のルンゲ・クッタ法
  const f = (st) => derivatives(af, st, wind);
  const move = (st, d, h) => ({
    pos: add(st.pos, scale(d.pos, h)),
    vel: add(st.vel, scale(d.vel, h)),
    theta: st.theta + d.theta * h,
    q: st.q + d.q * h,
    phi: st.phi + d.phi * h,
    p: st.p + d.p * h,
    psi: st.psi + d.psi * h,
  });
  const k1 = f(s);
  const k2 = f(move(s, k1, dt / 2));
  const k3 = f(move(s, k2, dt / 2));
  const k4 = f(move(s, k3, dt));
  const comb = (key) => {
    if (Array.isArray(s[key])) {
      return add(s[key], scale(add(add(k1[key], scale(k2[key], 2)), add(scale(k3[key], 2), k4[key])), dt / 6));
    }
    return s[key] + ((k1[key] + 2 * k2[key] + 2 * k3[key] + k4[key]) * dt) / 6;
  };
  return {
    next: {
      pos: comb('pos'), vel: comb('vel'),
      theta: comb('theta'), q: comb('q'),
      phi: comb('phi'), p: comb('p'), psi: comb('psi'),
    },
    info: k1.info,
  };
}

/**
 * 紙飛行機を投げて、地面に落ちるまでを計算する
 * @param {object} aero analyzeAirplane の結果
 * @param {object} [throwOpts] DEFAULT_THROW を参照
 * @param {object} [simOpts] DEFAULT_SIM を参照
 * @returns {{ distance, time, maxHeight, landing, path, reason, airframe }}
 *   path: 一定間隔で記録した { t, pos, theta, phi, psi, V, alpha }
 *   distance: 手を離した所から落ちた所までの水平距離 [m]
 *   reason: 'landed'（地面に落ちた）または 'timeout'
 */
export function simulateThrow(aero, throwOpts = {}, simOpts = {}) {
  const th = { ...DEFAULT_THROW, ...throwOpts };
  const sim = { ...DEFAULT_SIM, ...simOpts };
  const af = makeAirframe(aero, sim);
  const ang = th.angle * RAD;
  const yaw = th.yaw * RAD;
  let s = {
    pos: [0, 0, th.height],
    vel: [th.speed * Math.cos(ang) * Math.cos(yaw), th.speed * Math.cos(ang) * Math.sin(yaw), th.speed * Math.sin(ang)],
    theta: (th.pitch ?? th.angle) * RAD,
    q: 0,
    phi: th.bank * RAD,
    p: 0,
    psi: yaw,
  };
  const path = [];
  let t = 0;
  let nextSample = 0;
  let maxHeight = s.pos[2];
  let reason = 'timeout';
  const record = (st, info) => path.push({
    t, pos: st.pos.slice(), theta: st.theta, phi: st.phi, psi: st.psi, V: info.V, alpha: info.alpha,
  });
  while (t < sim.maxTime) {
    const { next, info } = step(af, s, sim.dt, sim.wind);
    if (t >= nextSample) { record(s, info); nextSample += sim.sampleEvery; }
    if (next.pos[2] <= 0) {
      // 地面に着いた瞬間を線形補間で求める
      const k = s.pos[2] / (s.pos[2] - next.pos[2]);
      const land = add(s.pos, scale(sub(next.pos, s.pos), k));
      land[2] = 0;
      t += sim.dt * k;
      s = { ...next, pos: land };
      record(s, info);
      reason = 'landed';
      break;
    }
    s = next;
    t += sim.dt;
    maxHeight = Math.max(maxHeight, s.pos[2]);
    if (![s.pos[0], s.pos[1], s.pos[2], s.theta, s.phi].every(Number.isFinite)) { reason = 'diverged'; break; }
  }
  const landing = s.pos;
  return {
    distance: Math.hypot(landing[0], landing[1]),
    forward: landing[0],
    lateral: landing[1],
    time: t,
    maxHeight,
    landing,
    path,
    reason,
    airframe: af,
  };
}
