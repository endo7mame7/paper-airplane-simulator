// 投げ方の決め方（描画ライブラリに依存しない純粋なロジック）

export const THROW_LIMITS = {
  minSpeed: 2, maxSpeed: 15,   // [m/s]
  minAngle: -15, maxAngle: 45, // [度]
  maxYaw: 20,                  // [度]
};

// ---------------------------------------------------------------- 投げるタイミング（スイングメーター）
//
// ボタンを 3 回押して投げる。
//   1 回目：振りかぶり始める。カーソルが 0 から右（強さ 100%）へ動く
//   2 回目：強さを決める。カーソルは折り返して左へ戻る（腕を前へ振る）
//   3 回目：カーソルが 0 の「ジャスト」の所で押すと、狙いどおりに投げられる。
//           早い・遅いと、向き・傾き・角度がずれ、強さも落ちる。押さないまま左はしまで行くと大失敗
// カーソルの位置 v は SWING.min（左はし）〜 1（強さ 100%）

export const SWING = {
  min: -0.15,       // バーの左はし（ここまで来たら大失敗）
  just: 0.03,       // ジャストの幅（±）
  good: 0.08,       // まあまあの幅（±）
  powerTime: 1.1,   // 0 → 100% にかかる時間 [s]
  impactSpeed: 1.3, // 戻るときの速さ [1/s]
};

export function speedFromPower(power) {
  const { minSpeed, maxSpeed } = THROW_LIMITS;
  return minSpeed + (maxSpeed - minSpeed) * Math.max(0, Math.min(1, power));
}

/**
 * 強さとタイミングから、実際の投げ方を決める
 * @param {number} power 2 回目に押したときのカーソル（0〜1）
 * @param {number|null} timing 3 回目に押したときのカーソル（正なら早い、負なら遅い）。押さなかったら null
 * @returns {{ grade, speed, yawErr, bankErr, angleErr }} grade は 'just' | 'good' | 'early' | 'late' | 'miss'
 */
export function swingResult(power, timing) {
  const e = timing ?? SWING.min;
  const a = Math.abs(e);
  let grade;
  if (timing === null) grade = 'miss';
  else if (a <= SWING.just) grade = 'just';
  else if (a <= SWING.good) grade = 'good';
  else grade = e > 0 ? 'early' : 'late';
  const base = speedFromPower(power);
  // ジャストなら少しだけ強く。外れるほど力が逃げる
  const k = grade === 'just' ? 1.03 : 1 - Math.min(0.55, (a - SWING.just) * 3);
  const err = grade === 'just' ? 0 : e;
  return {
    grade,
    speed: base * k,
    yawErr: err * 90,      // 早いと左（+）、遅いと右へ [度]
    bankErr: -err * 110,   // 早いと左の翼が下がる [度]
    angleErr: -err * 40,   // 早いと低く、遅いと高く [度]
  };
}
