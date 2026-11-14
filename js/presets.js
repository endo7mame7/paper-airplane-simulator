// 見本の折り方（1辺 2 の正方形、中心が原点）
// 各手順:
//   fold: 折り線の 2 点 a, b、動かす側にある点 at、type（valley/mountain）
//         mode: 'component' のときは at の位置の一番上（select:'bottom' なら一番下）の部分だけ折る
//   angle: 完成後に設定する開き具合（度）
//   rotate / flip: 紙全体を回す・裏返す（rotate は deg 度）
// view: 完成後のカメラの位置（注視点からの相対位置）

import { fold, flip, rotate, reverseFold, makeLine, sideOf } from './paper.js';

const T = Math.tan((22.5 * Math.PI) / 180); // 0.4142...
const X = 2 * T; // 0.8284...
const N = 2 * Math.tan((11.25 * Math.PI) / 180); // 0.3978...（ふちをもう一度中心線へ）

export const PRESETS = [
  {
    id: 'airplane',
    name: '紙飛行機',
    view: [3, 0.6, 1.6],
    steps: [
      { op: 'fold', a: [0, 1], b: [-1, 0], at: [-0.9, 0.9], type: 'valley', caption: '左上の角を中心へ' },
      { op: 'fold', a: [0, 1], b: [1, 0], at: [0.9, 0.9], type: 'valley', caption: '右上の角を中心へ' },
      { op: 'fold', a: [0, 1], b: [-X, -1], at: [-0.9, -0.5], type: 'valley', caption: '左のふちを中心線へ' },
      { op: 'fold', a: [0, 1], b: [X, -1], at: [0.9, -0.5], type: 'valley', caption: '右のふちを中心線へ' },
      { op: 'fold', a: [0, -1], b: [0, 1], at: [-0.3, -0.5], type: 'mountain', caption: '中心で山折り', angle: 150 },
      { op: 'fold', a: [0.22, -1], b: [0.22, 1], at: [0.5, -0.7], type: 'valley', mode: 'component', select: 'top', caption: '上の翼を折る', angle: 85 },
      { op: 'fold', a: [0.22, -1], b: [0.22, 1], at: [0.5, -0.7], type: 'mountain', mode: 'component', select: 'bottom', caption: '下の翼を折る', angle: 85 },
    ],
  },
  {
    id: 'dart',
    name: 'やり飛行機（細い翼）',
    view: [3, 0.6, 1.6],
    steps: [
      { op: 'fold', a: [0, 1], b: [-1, 0], at: [-0.9, 0.9], type: 'valley', caption: '左上の角を中心へ' },
      { op: 'fold', a: [0, 1], b: [1, 0], at: [0.9, 0.9], type: 'valley', caption: '右上の角を中心へ' },
      { op: 'fold', a: [0, 1], b: [-X, -1], at: [-0.9, -0.5], type: 'valley', caption: '左のふちを中心線へ' },
      { op: 'fold', a: [0, 1], b: [X, -1], at: [0.9, -0.5], type: 'valley', caption: '右のふちを中心線へ' },
      { op: 'fold', a: [0, 1], b: [-N, -1], at: [-0.7, -0.9], type: 'valley', caption: '左のふちをもう一度中心線へ' },
      { op: 'fold', a: [0, 1], b: [N, -1], at: [0.7, -0.9], type: 'valley', caption: '右のふちをもう一度中心線へ' },
      { op: 'fold', a: [0, -1], b: [0, 1], at: [-0.2, -0.5], type: 'mountain', caption: '中心で山折り', angle: 150 },
      { op: 'fold', a: [0.12, -1], b: [0.12, 1], at: [0.3, -0.9], type: 'valley', mode: 'component', select: 'top', caption: '上の翼を折る', angle: 60 },
      { op: 'fold', a: [0.12, -1], b: [0.12, 1], at: [0.3, -0.9], type: 'mountain', mode: 'component', select: 'bottom', caption: '下の翼を折る', angle: 60 },
    ],
  },
];

// 見本の 1 手順を状態に適用する
export function applyOp(state, op) {
  if (op.op === 'flip') return flip(state);
  if (op.op === 'rotate') return rotate(state, op.deg ?? 90);
  const line = makeLine({ x: op.a[0], y: op.a[1] }, { x: op.b[0], y: op.b[1] });
  const at = { x: op.at[0], y: op.at[1] };
  const sideAt = Math.sign(sideOf(line, at));
  const pick = { ...at, select: op.select ?? 'top' };
  if (op.op === 'reverse') return reverseFold(state, { line, side: sideAt, pick });
  return fold(state, {
    line,
    side: Math.sign(sideOf(line, at)),
    type: op.type,
    mode: op.mode ?? 'all',
    pick: { ...at, select: op.select ?? 'top' },
  });
}
