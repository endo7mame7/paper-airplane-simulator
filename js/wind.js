// コースの風（描画ライブラリに依存しない純粋なロジック）
//
// 風は投げるたびに変わる。向きと強さ（平均）に、ゆっくりした息（突風）が重なる。
// 座標は flight.js と同じ（x 前、y 左、z 上）。dir は風が「吹いていく」向き（x 軸から左回り、rad）。

export const WIND_MAX = 2.5; // 一番強い風 [m/s]

// 0〜1 の乱数を返す、種から決まる乱数（同じ種なら同じ風になる）
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 新しい風を決める。弱い風が多く、強い風はたまに
export function randomWind(seed = Math.floor(Math.random() * 2 ** 32)) {
  const r = rng(seed);
  const speed = Math.round(WIND_MAX * r() ** 1.6 * 10) / 10;
  const dir = r() * Math.PI * 2;
  return {
    seed,
    speed,
    dir,
    gust: 0.15 + 0.2 * r(),     // 息の大きさ（平均の何割か）
    gustPeriod: 1.2 + 1.5 * r(), // 息の周期 [s]
    gustPhase: r() * Math.PI * 2,
  };
}

export const CALM = { seed: 0, speed: 0, dir: 0, gust: 0, gustPeriod: 1, gustPhase: 0 };

// 時刻 t [s] の風のベクトル [m/s]
export function windVector(w, t = 0) {
  if (!w || w.speed === 0) return [0, 0, 0];
  const k = 1 + w.gust * Math.sin((2 * Math.PI * t) / w.gustPeriod + w.gustPhase);
  const v = w.speed * k;
  // 向きも少しゆらぐ（±8°）
  const d = w.dir + 0.14 * Math.sin((2 * Math.PI * t) / (w.gustPeriod * 1.7) + w.gustPhase * 0.5);
  return [v * Math.cos(d), v * Math.sin(d), 0];
}

// flight.js の simOpts.wind に渡す関数
export function windField(w) {
  return (t) => windVector(w, t);
}

/**
 * 投げる向き yaw [度] から見た風を言葉にする
 * @returns {{ text, head, cross }} head：追い風なら正、cross：左へ流れる風なら正 [m/s]
 */
export function describeWind(w, yawDeg = 0) {
  if (!w || w.speed < 0.05) return { text: '無風', head: 0, cross: 0 };
  const rel = w.dir - (yawDeg * Math.PI) / 180;
  const head = w.speed * Math.cos(rel);
  const cross = w.speed * Math.sin(rel);
  const s = `${w.speed.toFixed(1)} m/s`;
  let kind;
  if (Math.abs(head) >= Math.abs(cross) * 1.7) kind = head > 0 ? '追い風' : '向かい風';
  else if (Math.abs(cross) >= Math.abs(head) * 1.7) kind = cross > 0 ? '右からの横風' : '左からの横風';
  else kind = `${head > 0 ? '追い風' : '向かい風'}ぎみの${cross > 0 ? '右' : '左'}からの風`;
  return { text: `${kind} ${s}`, head, cross };
}
