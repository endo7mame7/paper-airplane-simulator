import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  createPaper, fold, flip, rotate, makeLine, bisectorLine, sideOf, reflectPoint,
  poseFaces, creasePattern, snapPoints, bounds, cloneState, LAYER_GAP, isFrontUp,
  reverseFold, addCrease, pairedSteps, creaseSegmentsXY, faceAffine, clipToFaceUV,
} from './paper.js';
import { VERSION } from './version.js';
import { CHANGELOG } from './changelog.js';
import { PRESETS, applyOp } from './presets.js';
import { Bgm } from './bgm.js';
import { analyzeAirplane } from './aero.js';
import { simulateThrow } from './flight.js';
import { Course, SWING, speedFromPower } from './course.js';
import { Records, planeId } from './records.js';
import { describeWind, randomWind, CALM } from './wind.js';
import { TIP_CATEGORIES, shuffledTips } from './tips.js';
import { Analysis, ANALYSIS_NOTE } from './analysis.js';
import { diagnose } from './airflow.js';

// ================================================================ 状態

const PAPER_SHAPES = {
  square: [2, 2],
  a4: [2 / Math.SQRT2, 2],
  strip: [1, 2],
};

const ui = {
  input: 'line',      // 'line' | 'point'
  type: 'valley',     // 'valley' | 'mountain' | 'crease' | 'reverse'
  mode: 'all',        // 'all' | 'component'
  orbit: false,
  speed: 1,
  frontColor: '#e2463f',
  backColor: '#fbf8f1',
  pattern: 'plain',
  shape: 'square',
};

let state = createPaper(...PAPER_SHAPES[ui.shape]);
let undoStack = [];
let redoStack = [];
let busy = false;
let dirty = true;
let currentStep = -1; // 再生中などに強調する手順

// 入力の状態
const input = {
  phase: 'idle',   // 'idle' | 'drawing' | 'choose'
  start: null,
  end: null,
  line: null,
  hover: null,
  downAt: null,
  pointers: new Set(),
  shift: false,
};

// ================================================================ three.js

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
camera.up.set(0, 0, 1);
camera.position.set(0, -3.4, 4.4);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.minDistance = 1.2;
controls.maxDistance = 14;
controls.enablePan = true;
setOrbitButtons();

scene.add(new THREE.HemisphereLight(0xffffff, 0xd8cbb8, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-2.5, -3, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -4; sun.shadow.camera.right = 4;
sun.shadow.camera.top = 4; sun.shadow.camera.bottom = -4;
sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 20;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.01;
scene.add(sun);
scene.add(sun.target);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.ShadowMaterial({ opacity: 0.16, depthWrite: false }),
);
ground.receiveShadow = true;
ground.position.z = -0.02;
scene.add(ground);

// 紙
const paperGeom = new THREE.BufferGeometry();
const frontMat = new THREE.MeshStandardMaterial({
  side: THREE.FrontSide, roughness: 0.85, metalness: 0,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
});
const backMat = new THREE.MeshStandardMaterial({
  side: THREE.BackSide, roughness: 0.9, metalness: 0,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
});
const frontMesh = new THREE.Mesh(paperGeom, frontMat);
const backMesh = new THREE.Mesh(paperGeom, backMat);
frontMesh.castShadow = backMesh.castShadow = true;
frontMesh.receiveShadow = backMesh.receiveShadow = true;
scene.add(frontMesh, backMesh);

const edgeGeom = new THREE.BufferGeometry();
const edges = new THREE.LineSegments(edgeGeom, new THREE.LineBasicMaterial({
  color: 0x3a2a20, transparent: true, opacity: 0.35,
}));
scene.add(edges);

// 折り筋（開いた後に残る線）
const markGeom = new THREE.BufferGeometry();
const marks = new THREE.LineSegments(markGeom, new THREE.LineBasicMaterial({
  color: 0x5a4a40, transparent: true, opacity: 0.55,
}));
scene.add(marks);


// 折り線のプレビュー
const previewGroup = new THREE.Group();
scene.add(previewGroup);
const highlightMat = new THREE.MeshBasicMaterial({
  color: 0xffc94a, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthTest: false,
});
const landingMat = new THREE.LineDashedMaterial({
  color: 0x2b2622, dashSize: 0.05, gapSize: 0.035, transparent: true, opacity: 0.8, depthTest: false,
});
const foldLineMat = new THREE.MeshBasicMaterial({ color: 0x2f6fd6, transparent: true, opacity: 0.9, depthTest: false });
const pointMat = new THREE.MeshBasicMaterial({ color: 0x2b2622, depthTest: false });
const snapMat = new THREE.MeshBasicMaterial({ color: 0x2f6fd6, transparent: true, opacity: 0.85, depthTest: false });
const snapRing = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.05, 32), snapMat);
snapRing.renderOrder = 20;
snapRing.visible = false;
scene.add(snapRing);

// ================================================================ 紙の模様

function makeTexture(color, pattern, isFront) {
  const [w, h] = [state.width, state.height];
  const W = 1024;
  const H = Math.round(W * h / w);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, W, H);

  // 和紙のような細かいムラ
  const img = g.getImageData(0, 0, W, H);
  let seed = isFront ? 7 : 13;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 10;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  if (isFront && pattern !== 'plain') {
    const light = shade(color, 0.35);
    const dark = shade(color, -0.25);
    g.lineWidth = 3;
    if (pattern === 'grid') {
      g.strokeStyle = 'rgba(255,255,255,0.45)';
      const n = 8;
      for (let i = 1; i < n; i++) {
        g.beginPath(); g.moveTo((W * i) / n, 0); g.lineTo((W * i) / n, H); g.stroke();
      }
      const m = Math.round(n * h / w);
      for (let i = 1; i < m; i++) {
        g.beginPath(); g.moveTo(0, (H * i) / m); g.lineTo(W, (H * i) / m); g.stroke();
      }
    } else if (pattern === 'wave') {
      const r = 64;
      g.lineWidth = 4;
      for (let row = -1, y = H + r; y > -r; row++, y -= r / 2) {
        const off = (row % 2) * r;
        for (let x = -r + off; x < W + 2 * r; x += 2 * r) {
          for (let k = 4; k >= 1; k--) {
            g.beginPath();
            g.arc(x, y, (r * k) / 4, Math.PI, 2 * Math.PI);
            g.fillStyle = k % 2 ? color : dark;
            g.fill();
            g.strokeStyle = light;
            g.stroke();
          }
        }
      }
    } else if (pattern === 'dots') {
      g.fillStyle = light;
      const s = 96;
      for (let y = s / 2, row = 0; y < H + s; y += s / 2, row++) {
        for (let x = (row % 2) * (s / 2); x < W + s; x += s) {
          g.beginPath(); g.arc(x, y, 14, 0, Math.PI * 2); g.fill();
        }
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const t = amt > 0 ? 255 : 0;
    return Math.round(v + (t - v) * Math.abs(amt));
  });
  return `rgb(${ch.join(',')})`;
}

function updateTextures() {
  frontMat.map?.dispose();
  backMat.map?.dispose();
  frontMat.map = makeTexture(ui.frontColor, ui.pattern, true);
  backMat.map = makeTexture(ui.backColor, 'plain', false);
  frontMat.needsUpdate = backMat.needsUpdate = true;
  dirty = true;
}

// ================================================================ ジオメトリ更新

let lastPoseMinZ = 0;

function rebuildGeometry() {
  const posed = poseFaces(state);
  const pos = [];
  const uv = [];
  const ep = [];
  const w = state.width;
  const h = state.height;
  let minZ = Infinity;
  for (const { face, pts } of posed) {
    const vs = face.verts;
    for (let i = 1; i < pts.length - 1; i++) {
      for (const j of [0, i, i + 1]) {
        pos.push(...pts[j]);
        uv.push((vs[j].u + w / 2) / w, (vs[j].v + h / 2) / h);
      }
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      ep.push(...a, ...b);
      minZ = Math.min(minZ, a[2]);
    }
  }
  paperGeom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  paperGeom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  paperGeom.deleteAttribute('normal'); // 頂点数が変わるので作り直す
  paperGeom.computeVertexNormals();
  paperGeom.computeBoundingSphere();
  edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
  edgeGeom.computeBoundingSphere();
  // 折り筋を、各面の今の姿勢に合わせて描く（表と裏の両方から見えるように少し浮かせる）
  const mp = [];
  const cm = state.creaseMarks ?? [];
  if (cm.length) {
    for (const { face, pts } of posed) {
      const map = faceAffine(face, pts);
      const n = new THREE.Vector3().crossVectors(
        new THREE.Vector3(...pts[1]).sub(new THREE.Vector3(...pts[0])),
        new THREE.Vector3(...pts[2]).sub(new THREE.Vector3(...pts[0])),
      ).normalize().multiplyScalar(0.0012);
      for (const m of cm) {
        const r = clipToFaceUV(face, m.a, m.b);
        if (!r) continue;
        const at = (t) => map(m.a.u + (m.b.u - m.a.u) * t, m.a.v + (m.b.v - m.a.v) * t);
        const a = at(r[0]);
        const b = at(r[1]);
        for (const sg of [1, -1]) {
          mp.push(a[0] + n.x * sg, a[1] + n.y * sg, a[2] + n.z * sg, b[0] + n.x * sg, b[1] + n.y * sg, b[2] + n.z * sg);
        }
      }
    }
  }
  markGeom.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
  markGeom.computeBoundingSphere();
  lastPoseMinZ = minZ;
  ground.position.z = Math.min(0, minZ) - 0.02;
  scheduleAero();
}

// ================================================================ 飛行機としての性能

// 紙の実寸（シミュレーター単位 1 あたりの m）。正方形は 15cm、A4 は長い辺 29.7cm
const PAPER_METERS = { square: 0.15 / 2, a4: 0.297 / 2, strip: 0.15 / 2 };

const aeroMarker = new THREE.Group();
{
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x1b6fd8, depthTest: false }),
  );
  dot.renderOrder = 10;
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.5, 0x1b6fd8, 0.12, 0.07);
  arrow.traverse((o) => { if (o.material) { o.material.depthTest = false; o.renderOrder = 10; } });
  aeroMarker.add(dot, arrow);
  aeroMarker.userData = { dot, arrow };
}
scene.add(aeroMarker);

let aeroTimer = 0;
let lastAero = null;
function scheduleAero() {
  clearTimeout(aeroTimer);
  aeroTimer = setTimeout(updateAero, 120);
}

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

function updateAero() {
  const a = state.steps.length ? analyzeAirplane(state, { metersPerUnit: PAPER_METERS[ui.shape] ?? 0.075 }) : null;
  lastAero = a;
  const dl = $('aero-stats');
  const notes = $('aero-notes');
  dl.innerHTML = '';
  notes.innerHTML = '';
  aeroMarker.visible = !!a && $('aero-marker').checked;
  if (!a) return;
  const rows = [
    ['重さ', `${fmt(a.mass * 1000, 2)} g`],
    ['翼の面積', `${fmt(a.wingArea * 1e4)} cm²`],
    ['翼幅 × 全長', `${fmt(a.span * 100)} × ${fmt(a.length * 100)} cm`],
    ['縦横比（アスペクト比）', fmt(a.aspectRatio, 2)],
    ['翼面荷重', `${fmt(a.wingLoading, 2)} N/m²`],
    ['機首から重心', `${fmt(a.cgFromNose * 100)} cm`],
    ['機首から空力中心', `${fmt(a.acFromNose * 100)} cm`],
    ['静安定余裕', `${fmt(a.staticMargin * 100, 0)} %`],
    ['上反角', `${fmt(a.dihedral)}°`],
    ['胴（キール）の面積', `${fmt(a.sideArea * 1e4)} cm²`],
    ['左右の対称性', `${fmt(a.symmetry * 100, 0)} %`],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  for (const [cls, text] of aeroNotes(a)) {
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = text;
    notes.append(li);
  }
  const { dot, arrow } = aeroMarker.userData;
  const m = PAPER_METERS[ui.shape] ?? 0.075;
  const cg = new THREE.Vector3(...a.cg).multiplyScalar(1 / m);
  dot.position.copy(cg);
  arrow.position.copy(cg);
  arrow.setDirection(new THREE.Vector3(...a.axes.forward));
}

// 解析結果から、飛び方の目安を言葉にする
function aeroNotes(a) {
  const out = [];
  if (a.wingArea * 1e4 < 5) {
    out.push(['warn', '翼がほとんどありません。翼を広げると、よく滑空します。']);
    return out;
  }
  if (a.staticMargin < 0) out.push(['warn', '重心が空力中心より後ろです。機首が上がって失速しやすくなります（先を重くしよう）。']);
  else if (a.staticMargin > 0.4) out.push(['warn', '重心がかなり前です。安定しますが、すぐに落ちやすくなります。']);
  else out.push(['good', '重心の位置はちょうどよい範囲です。']);
  if (a.dihedral < -3) out.push(['warn', '翼が下がっています（下反角）。少し上に開くと左右に安定します。']);
  else if (a.dihedral > 25) out.push(['warn', '翼が上がりすぎています。揚力が減ります。']);
  if (a.symmetry < 0.9) out.push(['warn', '左右の形がずれています。左右どちらかに曲がりやすくなります。']);
  if (a.sideArea < a.wingArea * 0.05) out.push(['warn', '胴（キール）が小さいので、まっすぐ飛びにくくなります。']);
  return out;
}


// ================================================================ アニメーション

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// 複数の手順の角度を同時に変える
function animateAngles(targets, baseDuration = 700) {
  const entries = Object.entries(targets)
    .map(([i, to]) => ({ i: +i, from: state.steps[+i].angle, to }))
    .filter((e) => e.from !== e.to);
  if (entries.length === 0) return Promise.resolve();
  const maxDelta = Math.max(...entries.map((e) => Math.abs(e.to - e.from)));
  const duration = (baseDuration * Math.max(0.35, maxDelta / 180)) / ui.speed;
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      const k = easeInOut(t);
      for (const e of entries) state.steps[e.i].angle = e.from + (e.to - e.from) * k;
      dirty = true;
      syncStepSliders();
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

// 同時に動く手順（つぶし折りなど）をまとめる
function stepGroups() {
  const groups = [];
  state.steps.forEach((s, i) => {
    const last = groups[groups.length - 1];
    if (last && s.group && state.steps[last[0]].group === s.group) last.push(i);
    else groups.push([i]);
  });
  return groups;
}

function fullAngle(step) {
  return step.kind === 'rotate' ? step.full : 180;
}

async function runBusy(fn) {
  if (busy) return;
  busy = true;
  cancelInput();
  updateButtons();
  try {
    await fn();
  } finally {
    busy = false;
    currentStep = -1;
    updateButtons();
    renderSteps();
    updateHint();
  }
}

// 部分的に開いている手順があれば、折りたたんでから次の操作を行う
async function flattenAll() {
  const targets = {};
  state.steps.forEach((s, i) => { if (s.angle !== fullAngle(s)) targets[i] = fullAngle(s); });
  if (Object.keys(targets).length) {
    toast('折るために、いったんたたみます');
    await animateAngles(targets, 500);
  }
}

// 新しい状態（最後の手順が追加されたもの）へアニメーションしながら進む
async function commit(result, targetAngle) {
  if (result.error) { toast(result.error); return false; }
  undoStack.push(cloneState(state));
  redoStack = [];
  const prevSteps = state.steps;
  state = result.state;
  // 既存の手順の角度は引き継ぐ
  prevSteps.forEach((s, i) => { state.steps[i].angle = s.angle; });
  // 新しい手順（つぶし折りなどは複数の手順を同時に動かす）
  const targets = {};
  for (let i = prevSteps.length; i < state.steps.length; i++) {
    targets[i] = targetAngle ?? fullAngle(state.steps[i]);
    state.steps[i].angle = 0;
  }
  currentStep = prevSteps.length;
  dirty = true;
  renderSteps();
  drawCreasePattern();
  await animateAngles(targets);
  recenter();
  return true;
}

// ================================================================ 操作

// 今の設定で折った結果を計算する（プレビューにも使う）
function computeFold(line, side, pick) {
  const p = pick && { ...pick, select: viewFromBelow() ? 'bottom' : 'top' };
  if (ui.type === 'reverse') return reverseFold(state, { line, side, pick: p });
  const type = ui.type === 'crease' ? 'valley' : ui.type;
  return fold(state, { line, side, type, mode: ui.mode, pick: p });
}

// 新しく折るときは、線を引いた平らな形で折るために一度たたみ、折ったあとで元の開き具合に戻す
async function restoreAngles(saved) {
  const t = {};
  saved.forEach((a, i) => { if (state.steps[i] && state.steps[i].angle !== a) t[i] = a; });
  if (Object.keys(t).length) await animateAngles(t, 500);
}

function doFold(line, side, pick) {
  return runBusy(async () => {
    const saved = state.steps.map((st) => st.angle);
    await flattenAll();
    if (ui.type === 'crease') {
      // 折ってから開いて、折り筋だけを残す
      const before = cloneState(state);
      const c = addCrease(state, { line, side, mode: ui.mode, pick: pick && { ...pick, select: viewFromBelow() ? 'bottom' : 'top' } });
      if (c.error) { toast(c.error); return; }
      if (!c.marks.length) { toast('折り筋がつきませんでした'); return; }
      if (!(await commit({ state: c.folded }))) return;
      await wait(120 / ui.speed);
      const idx = state.steps.length - 1;
      await animateAngles({ [idx]: 0 }, 600);
      const angles = before.steps.map((st, i) => state.steps[i].angle);
      state = c.state;
      state.steps.forEach((st, i) => { st.angle = angles[i]; });
      dirty = true;
      drawCreasePattern();
      await restoreAngles(saved);
      return;
    }
    if (await commit(computeFold(line, side, pick))) await restoreAngles(saved);
  });
}

// 裏返す・回すは紙全体を動かすだけなので、開いている手順はそのままにする
function doFlip() {
  return runBusy(async () => { await commit(flip(state)); });
}

function doRotate() {
  return runBusy(async () => { await commit(rotate(state, 90)); });
}

function undo() {
  if (!undoStack.length) return;
  runBusy(async () => {
    // この操作で増えた手順だけを開く（折り筋は手順が増えないので、そのまま戻す）
    const prevLen = undoStack[undoStack.length - 1].steps.length;
    const t = {};
    for (let i = prevLen; i < state.steps.length; i++) t[i] = 0;
    await animateAngles(t);
    redoStack.push(cloneState(state));
    // 元に戻した時の角度は今の角度を引き継ぐ
    const angles = state.steps.map((s) => s.angle);
    state = undoStack.pop();
    state.steps.forEach((s, i) => { if (angles[i] !== undefined) s.angle = angles[i]; });
    dirty = true;
    drawCreasePattern();
    recenter();
  });
}

function redo() {
  if (!redoStack.length) return;
  runBusy(async () => {
    const next = redoStack.pop();
    undoStack.push(cloneState(state));
    const prevLen = state.steps.length;
    const goals = {};
    for (let i = prevLen; i < next.steps.length; i++) goals[i] = next.steps[i].angle;
    state.steps.forEach((s, i) => { next.steps[i].angle = s.angle; });
    state = next;
    if (next.steps.length > prevLen) {
      for (const i of Object.keys(goals)) state.steps[i].angle = 0;
      currentStep = prevLen;
      renderSteps();
      await animateAngles(goals);
    }
    dirty = true;
    drawCreasePattern();
    recenter();
  });
}

function reset(shape = ui.shape) {
  if (busy) return;
  if (state.steps.length) undoStack.push(cloneState(state));
  redoStack = [];
  ui.shape = shape;
  state = createPaper(...PAPER_SHAPES[shape]);
  updateTextures();
  dirty = true;
  cancelInput();
  renderSteps();
  drawCreasePattern();
  recenter(true);
  updateButtons();
}

function replay() {
  if (!state.steps.length) return;
  runBusy(async () => {
    const targets = state.steps.map((s) => (s.angle > 0 ? s.angle : fullAngle(s)));
    const all = {};
    state.steps.forEach((s, i) => { all[i] = 0; });
    await animateAngles(all, 600);
    await wait(250);
    for (const g of stepGroups()) {
      currentStep = g[0];
      renderSteps();
      const t = {};
      for (const i of g) t[i] = targets[i];
      await animateAngles(t);
      await wait(120 / ui.speed);
    }
  });
}

function setAllAngles(open) {
  runBusy(async () => {
    const t = {};
    state.steps.forEach((s, i) => { t[i] = open ? 0 : fullAngle(s); });
    await animateAngles(t, 900);
  });
}

// i 番目の手順まで折った状態を見せる
function goToStep(i) {
  runBusy(async () => {
    const t = {};
    const last = stepGroups().find((g) => g.includes(i)) ?? [i];
    const end = last[last.length - 1];
    state.steps.forEach((s, j) => { t[j] = j <= end ? fullAngle(s) : 0; });
    currentStep = last[0];
    renderSteps();
    await animateAngles(t, 700);
  });
}

function playPreset(preset) {
  if (busy) return;
  if (ui.shape !== 'square') {
    document.getElementById('paper-shape').value = 'square';
  }
  reset('square');
  runBusy(async () => {
    await wait(200);
    for (const op of preset.steps) {
      const first = state.steps.length;
      const ok = await commit(applyOp(state, op));
      if (!ok) break;
      if (state.steps[first]) state.steps[first].caption = op.caption;
      renderSteps();
      await wait(150 / ui.speed);
    }
    const t = {};
    preset.steps.forEach((op, i) => { if (op.angle !== undefined && state.steps[i]) t[i] = op.angle; });
    await animateAngles(t, 900);
    preset.lastId = planeId(state); // 記録に見本の名前を付けるため
    if (preset.view) moveCamera(preset.view);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================================================ 入力（折り線を引く）

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

function viewFromBelow() {
  return camera.position.z < controls.target.z;
}

function pointerToPaper(ev) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const p = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(plane, p)) return null;
  return { x: p.x, y: p.y };
}

function snapRadius() {
  return 0.022 * camera.position.distanceTo(controls.target);
}

let snapCache = null;
function getSnapPoints() {
  if (!snapCache || snapCache.state !== state) {
    const pts = snapPoints(state);
    // 折り筋の端と、折り筋どうしの交点
    const segs = creaseSegmentsXY(state);
    for (const sg of segs) pts.push({ ...sg.a, kind: 'vertex' }, { ...sg.b, kind: 'vertex' });
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const p = segIntersect(segs[i], segs[j]);
        if (p) pts.push({ ...p, kind: 'vertex' });
      }
    }
    snapCache = { state, pts, segs };
  }
  return snapCache.pts;
}

function segIntersect(s1, s2) {
  const rx = s1.b.x - s1.a.x, ry = s1.b.y - s1.a.y;
  const sx = s2.b.x - s2.a.x, sy = s2.b.y - s2.a.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = s2.a.x - s1.a.x, qy = s2.a.y - s1.a.y;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return { x: s1.a.x + rx * t, y: s1.a.y + ry * t };
}

function snap(pt) {
  if (!pt) return { pt, snapped: false };
  const r = snapRadius();
  let best = null;
  let bd = r;
  for (const s of getSnapPoints()) {
    const d = Math.hypot(s.x - pt.x, s.y - pt.y);
    // 頂点を優先
    const dd = s.kind === 'vertex' ? d * 0.7 : d;
    if (dd < bd) { bd = dd; best = s; }
  }
  if (best) return { pt: { x: best.x, y: best.y }, snapped: true };
  // 点がなければ、折り筋の線の上に吸い付く
  let bl = r * 0.8;
  let onSeg = null;
  for (const sg of snapCache?.segs ?? []) {
    const dx = sg.b.x - sg.a.x, dy = sg.b.y - sg.a.y;
    const L2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((pt.x - sg.a.x) * dx + (pt.y - sg.a.y) * dy) / L2));
    const q = { x: sg.a.x + dx * t, y: sg.a.y + dy * t };
    const d = Math.hypot(q.x - pt.x, q.y - pt.y);
    if (d < bl) { bl = d; onSeg = q; }
  }
  return onSeg ? { pt: onSeg, snapped: true } : { pt, snapped: false };
}

function snapAngle(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  const step = Math.PI / 8;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: start.x + Math.cos(a) * len, y: start.y + Math.sin(a) * len };
}

function anyPartial() {
  return state.steps.some((s) => s.angle !== fullAngle(s));
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (ev) => {
  if (mode === 'fly') { ev.preventDefault(); flyPress(ev); return; } // 画面をタップしても投げられる
  if (mode !== 'fold') return;
  input.pointers.add(ev.pointerId);
  if (input.pointers.size > 1) { // 2 本指は視点操作
    if (input.phase === 'drawing') cancelInput();
    return;
  }
  if (busy || ui.orbit) return;
  if (ev.pointerType === 'mouse' && ev.button !== 0) {
    if (ev.button === 2 && input.phase === 'choose') cancelInput();
    return;
  }
  if (anyPartial()) {
    toast('開いている手順があります。「たたむ」で折りたたんでから折ってください');
    return;
  }
  const raw = pointerToPaper(ev);
  if (!raw) return;
  input.downAt = { x: ev.clientX, y: ev.clientY, raw, phase: input.phase };
  const { pt } = snap(raw);
  if (input.phase !== 'choose') {
    input.phase = 'drawing';
    input.start = pt;
    input.end = pt;
  }
  canvas.setPointerCapture(ev.pointerId);
  updatePreview();
});

canvas.addEventListener('pointermove', (ev) => {
  if (mode !== 'fold') return;
  if (busy || ui.orbit) { snapRing.visible = false; return; }
  const raw = pointerToPaper(ev);
  if (!raw) return;
  input.shift = ev.shiftKey;

  if (input.phase === 'choose' && input.downAt && moved(ev)) {
    // 選択中に新しくドラッグを始めたら、引き直し
    input.phase = 'drawing';
    input.start = snap(input.downAt.raw).pt;
  }

  if (input.phase === 'drawing') {
    let { pt, snapped } = snap(raw);
    if (input.shift && ui.input === 'line') { pt = snapAngle(input.start, raw); snapped = false; }
    input.end = pt;
    showSnap(snapped ? pt : null);
  } else if (input.phase === 'choose') {
    input.hover = raw;
    showSnap(null);
  } else {
    const { pt, snapped } = snap(raw);
    showSnap(snapped ? pt : null);
  }
  updatePreview();
});

function moved(ev) {
  const d = input.downAt;
  return d && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 6;
}

function endPointer(ev) {
  input.pointers.delete(ev.pointerId);
  if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
}

canvas.addEventListener('pointerup', (ev) => {
  if (mode !== 'fold') return;
  const wasDown = input.downAt;
  const isClick = wasDown && !moved(ev);
  endPointer(ev);
  input.downAt = null;
  if (busy || !wasDown) return;

  if (input.phase === 'drawing') {
    const len = input.start && input.end ? Math.hypot(input.end.x - input.start.x, input.end.y - input.start.y) : 0;
    if (len < 0.03) {
      cancelInput();
      if (wasDown.phase !== 'choose') updateHint('紙の上をドラッグして折り線を引いてください');
      return;
    }
    if (ui.input === 'point') {
      const line = bisectorLine(input.start, input.end);
      const side = Math.sign(sideOf(line, input.start));
      const pick = { ...input.start };
      // 点の少し内側を選ぶ（角そのものだと境界になるため）
      const toward = { x: line.p.x - pick.x, y: line.p.y - pick.y };
      const tl = Math.hypot(toward.x, toward.y) || 1;
      pick.x += (toward.x / tl) * 0.01; pick.y += (toward.y / tl) * 0.01;
      cancelInput();
      doFold(line, side, pick);
    } else {
      input.line = makeLine(input.start, input.end);
      input.phase = 'choose';
      input.hover = pointerToPaper(ev);
      updatePreview();
      updateHint();
    }
    return;
  }

  if (input.phase === 'choose' && isClick) {
    const pt = pointerToPaper(ev);
    if (!pt) return;
    const side = Math.sign(sideOf(input.line, pt));
    const line = input.line;
    cancelInput();
    doFold(line, side, pt);
  }
});

canvas.addEventListener('pointercancel', (ev) => { endPointer(ev); input.downAt = null; });
canvas.addEventListener('pointerleave', () => { snapRing.visible = false; });

function cancelInput() {
  input.phase = 'idle';
  input.start = input.end = input.line = input.hover = null;
  clearPreview();
  snapRing.visible = false;
  updateHint();
}

function showSnap(pt) {
  if (!pt) { snapRing.visible = false; return; }
  snapRing.visible = true;
  snapRing.position.set(pt.x, pt.y, topZ() + 0.003);
  const s = snapRadius() / 0.05 * 0.6;
  snapRing.scale.setScalar(Math.max(0.5, s));
}

function topZ() {
  const maxL = Math.max(0, ...state.faces.map((f) => f.layer));
  return maxL * LAYER_GAP + 0.004;
}

// ================================================================ プレビュー

function clearPreview() {
  for (const c of [...previewGroup.children]) {
    previewGroup.remove(c);
    c.geometry?.dispose();
  }
}

function lineQuad(a, b, width, z, mat) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * width / 2;
  const ny = (dx / len) * width / 2;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    a.x + nx, a.y + ny, z, a.x - nx, a.y - ny, z, b.x - nx, b.y - ny, z,
    a.x + nx, a.y + ny, z, b.x - nx, b.y - ny, z, b.x + nx, b.y + ny, z,
  ], 3));
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = 15;
  return m;
}

function dot(p, z, r) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 24), pointMat);
  m.position.set(p.x, p.y, z);
  m.renderOrder = 16;
  return m;
}

function updatePreview() {
  clearPreview();
  const z = topZ() + 0.002;
  const w = 0.012 * camera.position.distanceTo(controls.target) / 5.5;

  let line = null;
  let side = 0;
  let pick = null;
  if (input.phase === 'drawing' && input.start && input.end) {
    if (ui.input === 'point') {
      line = bisectorLine(input.start, input.end);
      if (line) { side = Math.sign(sideOf(line, input.start)); pick = input.start; }
      // 動かす点から重ねる点への矢印
      previewGroup.add(lineQuad(input.start, input.end, w * 0.6, z + 0.001, pointMat));
      previewGroup.add(dot(input.start, z + 0.002, w * 1.6));
      previewGroup.add(dot(input.end, z + 0.002, w * 1.6));
    } else {
      line = makeLine(input.start, input.end);
      previewGroup.add(dot(input.start, z + 0.002, w * 1.4));
      previewGroup.add(dot(input.end, z + 0.002, w * 1.4));
    }
  } else if (input.phase === 'choose' && input.line) {
    line = input.line;
    if (input.hover) { side = Math.sign(sideOf(line, input.hover)); pick = input.hover; }
  }
  if (!line) return;

  // 折り線（長く伸ばして表示）
  const L = 6;
  const a = { x: line.p.x - line.d.x * L, y: line.p.y - line.d.y * L };
  const b = { x: line.p.x + line.d.x * L, y: line.p.y + line.d.y * L };
  foldLineMat.color.set({ valley: 0x2f6fd6, mountain: 0xd2392b, crease: 0x6b5a4e, reverse: 0x0f8a6a }[ui.type]);
  previewGroup.add(lineQuad(a, b, w, z, foldLineMat));

  if (!side) return;
  // 動く部分の強調表示と、折った後の位置（点線）
  const r = computeFold(line, side, pick);
  if (r.error) return;
  const first = state.steps.length;
  for (const f of r.state.faces) {
    const mine = f.moves.filter((k) => k >= first);
    if (!mine.length) continue;
    // 新しい手順の鏡映を逆にたどって、元の位置を求める
    let orig = f.verts.map((v) => ({ x: v.x, y: v.y }));
    for (let q = mine.length - 1; q >= 0; q--) {
      const st = r.state.steps[mine[q]];
      orig = orig.map((v) => reflectPoint(st, v));
    }
    const pos = [];
    for (let i = 1; i < orig.length - 1; i++) {
      for (const j of [0, i, i + 1]) pos.push(orig[j].x, orig[j].y, z - 0.001);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.Mesh(g, highlightMat);
    m.renderOrder = 14;
    previewGroup.add(m);

    const lp = [];
    for (let i = 0; i < f.verts.length; i++) {
      const p = f.verts[i];
      const q = f.verts[(i + 1) % f.verts.length];
      lp.push(p.x, p.y, z, q.x, q.y, z);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    const ls = new THREE.LineSegments(lg, landingMat);
    ls.computeLineDistances();
    ls.renderOrder = 15;
    previewGroup.add(ls);
  }
}

// ================================================================ カメラ

let targetGoal = new THREE.Vector3();

function recenter(immediate = false) {
  const b = bounds(state);
  targetGoal.set(b.cx, b.cy, 0);
  if (immediate) {
    const d = targetGoal.clone().sub(controls.target);
    controls.target.add(d);
    camera.position.add(d);
  }
}

function setView(kind) {
  const dist = camera.position.distanceTo(controls.target);
  let dir;
  if (kind === 'top') dir = new THREE.Vector3(0, -0.0001, 1);
  else if (kind === 'side') dir = new THREE.Vector3(0, -1, 0.12);
  else dir = new THREE.Vector3(0, -0.61, 0.79);
  moveCamera(dir.normalize().multiplyScalar(dist).toArray());
}

// 注視点からの相対位置 offset へカメラを動かす
function moveCamera(offset) {
  const t = controls.target.clone();
  const dist = new THREE.Vector3(...offset).length();
  const goal = t.clone().add(new THREE.Vector3(...offset));
  const from = camera.position.clone();
  const d0 = from.distanceTo(t);
  const t0 = performance.now();
  const tick = (now) => {
    const k = easeInOut(Math.min(1, (now - t0) / 600));
    camera.position.lerpVectors(from, goal, k);
    // 円弧に沿うように距離をなめらかに変える
    camera.position.sub(controls.target).setLength(d0 + (dist - d0) * k).add(controls.target);
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function setOrbitButtons() {
  controls.mouseButtons = {
    LEFT: ui.orbit ? THREE.MOUSE.ROTATE : null,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  controls.touches = {
    ONE: ui.orbit ? THREE.TOUCH.ROTATE : null,
    TWO: THREE.TOUCH.DOLLY_ROTATE,
  };
  canvas.classList.toggle('orbit', ui.orbit);
}

// ================================================================ UI

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}

function updateHint(msg) {
  const el = $('hint');
  if (msg) { el.textContent = msg; return; }
  if (busy) { el.textContent = ''; return; }
  if (ui.orbit) { el.textContent = 'ドラッグで視点を回転中（「⟲ 視点」で折るモードに戻ります）'; return; }
  if (input.phase === 'choose') {
    el.textContent = ui.type === 'reverse' ? '折り込みたい袋の先をクリック（Esc で取り消し）'
      : ui.mode === 'component' ? '折りたい部分をクリック（Esc で取り消し）'
      : '折りたい側をクリック（Esc で取り消し）';
    return;
  }
  if (ui.type === 'reverse') { el.textContent = '袋の途中に折り線を引いて、折り込む先をクリック'; return; }
  if (ui.input === 'point') {
    el.textContent = '動かしたい点を、重ねたい点までドラッグ';
  } else {
    el.textContent = state.steps.length === 0
      ? '紙の上をドラッグして折り線を引こう'
      : 'ドラッグで折り線を引く（Shift で角度を固定）';
  }
}

function stepLabel(s) {
  const cls = s.kind === 'rotate' || s.type === 'flip' ? 'other'
    : s.type === 'reverse' ? 'special' : s.type;
  if (s.label && !s.caption) return { text: s.label, cls };
  if (s.caption) return { text: s.caption, cls };
  if (s.kind === 'rotate') return { text: `${Math.round(s.full)}° 回す`, cls };
  if (s.type === 'flip') return { text: '裏返す', cls };
  const t = s.type === 'valley' ? '谷折り' : '山折り';
  return { text: s.mode === 'component' ? `${t}（一部）` : t, cls };
}

function renderSteps() {
  const ol = $('steps');
  ol.innerHTML = '';
  const groups = stepGroups();
  const pairs = pairedSteps(state.steps);
  groups.forEach((g, n) => {
    const i = g[0];
    const s = state.steps[i];
    const li = document.createElement('li');
    if (g.includes(currentStep)) li.classList.add('current');
    const { text, cls } = stepLabel(s);
    const pair = pairs.has(i) ? '<span class="pair" title="左右の対になる手順">⇄</span>' : '';
    li.innerHTML = `<span class="num">${n + 1}</span><span><span class="tag ${cls}"></span>${text}${pair}</span>`;
    if (s.kind === 'fold' && s.type !== 'flip') {
      const r = document.createElement('input');
      r.type = 'range'; r.min = 0; r.max = 180; r.step = 1; r.value = s.angle;
      r.title = '開き具合';
      r.dataset.idx = i;
      r.addEventListener('pointerdown', (e) => e.stopPropagation());
      r.addEventListener('click', (e) => e.stopPropagation());
      r.addEventListener('input', () => {
        if (busy) { r.value = state.steps[i].angle; return; }
        for (const j of g) state.steps[j].angle = +r.value;
        // 左右の翼は、いっしょに動かす
        if ($('link-wings').checked && pairs.has(i)) {
          state.steps[pairs.get(i)].angle = +r.value;
          syncStepSliders();
        }
        cancelInput();
        dirty = true;
      });
      li.appendChild(r);
    } else {
      li.appendChild(document.createElement('span'));
    }
    li.title = 'クリックでこの手順まで表示';
    li.addEventListener('click', () => goToStep(i));
    ol.appendChild(li);
  });
  $('step-count').textContent = groups.length ? `${groups.length} 手` : '';
  const cur = groups.findIndex((g) => g.includes(currentStep));
  if (cur >= 0) ol.children[cur]?.scrollIntoView({ block: 'nearest' });
}

function syncStepSliders() {
  for (const r of $('steps').querySelectorAll('input[type=range]')) {
    const s = state.steps[+r.dataset.idx];
    if (s) r.value = s.angle;
  }
}

function updateButtons() {
  $('btn-undo').disabled = busy || !undoStack.length;
  $('btn-redo').disabled = busy || !redoStack.length;
  for (const id of ['btn-replay', 'btn-unfold', 'btn-refold']) $(id).disabled = busy || !state.steps.length;
  for (const id of ['btn-flip', 'btn-rotate', 'btn-reset']) $(id).disabled = busy;
  for (const b of $('presets').children) b.disabled = busy;
}

function bindSeg(group, key, after) {
  for (const el of document.querySelectorAll(`.seg[data-group="${group}"]`)) {
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      setSeg(group, key, b.dataset.value);
      after?.();
    });
  }
}

function setSeg(group, key, value) {
  ui[key] = value;
  for (const b of document.querySelectorAll(`.seg[data-group="${group}"] button`)) {
    b.classList.toggle('on', b.dataset.value === value);
  }
  updatePreview();
  updateHint();
}

bindSeg('input', 'input', cancelInput);
bindSeg('type', 'type', () => { if (input.phase === 'choose') updatePreview(); });
bindSeg('mode', 'mode');

$('btn-undo').onclick = undo;
$('btn-redo').onclick = redo;
$('btn-flip').onclick = doFlip;
$('btn-rotate').onclick = doRotate;
$('btn-reset').onclick = () => reset();
$('btn-replay').onclick = replay;
$('btn-unfold').onclick = () => setAllAngles(true);
$('btn-refold').onclick = () => setAllAngles(false);
$('btn-view-top').onclick = () => setView('top');
$('btn-view-angle').onclick = () => setView('angle');
$('btn-view-side').onclick = () => setView('side');
$('btn-orbit').onclick = () => {
  ui.orbit = !ui.orbit;
  $('btn-orbit').classList.toggle('on', ui.orbit);
  cancelInput();
  setOrbitButtons();
  updateHint();
};
$('btn-panel').onclick = () => $('panel').classList.toggle('open');

$('paper-shape').onchange = (e) => reset(e.target.value);
$('paper-pattern').onchange = (e) => { ui.pattern = e.target.value; updateTextures(); };
$('color-front').oninput = (e) => { ui.frontColor = e.target.value; updateTextures(); drawCreasePattern(); };
$('color-back').oninput = (e) => { ui.backColor = e.target.value; updateTextures(); };
$('speed').oninput = (e) => { ui.speed = +e.target.value; };

for (const p of PRESETS) {
  const b = document.createElement('button');
  b.textContent = p.name;
  b.onclick = () => { playPreset(p); $('panel').classList.remove('open'); };
  $('presets').appendChild(b);
}

// ================================================================ BGM

const bgm = new Bgm();
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても動く */ } },
};
bgm.volume = store.get('origami.bgmVolume', 0.5);
$('bgm-volume').value = bgm.volume;

function syncBgmButtons() {
  for (const id of ['btn-bgm', 'btn-bgm2', 'menu-bgm']) {
    $(id).classList.toggle('on', bgm.playing);
    $(id).setAttribute('aria-pressed', String(bgm.playing));
  }
  $('btn-bgm2').textContent = bgm.playing ? '♪ BGM を止める' : '♪ BGM を流す';
}

async function toggleBgm() {
  if (bgm.playing) bgm.stop();
  else if (!(await bgm.start())) toast('このブラウザでは音を出せません');
  store.set('origami.bgm', bgm.playing);
  syncBgmButtons();
}

$('btn-bgm').onclick = toggleBgm;
$('btn-bgm2').onclick = toggleBgm;
$('menu-bgm').onclick = toggleBgm;
$('bgm-volume').oninput = (e) => { bgm.setVolume(+e.target.value); store.set('origami.bgmVolume', +e.target.value); };
// 前回 BGM をオンにしていたら、最初に画面を触ったときに流す（ブラウザは操作前の自動再生を止めるため）
if (store.get('origami.bgm', false)) {
  window.addEventListener('pointerdown', async function once() {
    window.removeEventListener('pointerdown', once, true);
    if (!bgm.playing) { await bgm.start(); syncBgmButtons(); }
  }, true);
}
syncBgmButtons();

window.addEventListener('keydown', (e) => {
  if (loading) { loadingKeyDown(e); return; }
  if (mode === 'analysis') { analysisKeyDown(e); return; }
  if (e.target.closest('input, select, textarea')) return;
  if (mode === 'menu') {
    if (e.key === 'Escape') { $('howto').hidden = true; $('ranking').hidden = true; $('menu-presets').hidden = true; }
    return;
  }
  if (mode === 'brief') {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goCourse(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeBrief(); }
    return;
  }
  if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); toggleFly(); return; }
  if (mode === 'fly') { flyKeyDown(e); return; }
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'escape') cancelInput();
  else if (k === 'v') setSeg('type', 'type', 'valley');
  else if (k === 'm') setSeg('type', 'type', 'mountain');
  else if (k === 'c') setSeg('type', 'type', 'crease');
  else if (k === 'i') setSeg('type', 'type', 'reverse');
  else if (k === 'l') { setSeg('input', 'input', 'line'); cancelInput(); }
  else if (k === 'p') { setSeg('input', 'input', 'point'); cancelInput(); }
  else if (k === 'a') setSeg('mode', 'mode', 'all');
  else if (k === 't') setSeg('mode', 'mode', 'component');
  else if (k === 'f') doFlip();
  else if (k === 'r') doRotate();
  else if (k === 'b') toggleBgm();
  else if (k === 'shift') { input.shift = true; }
});

// ================================================================ 展開図

function drawCreasePattern() {
  const c = $('cp');
  const g = c.getContext('2d');
  const W = c.width;
  const H = c.height;
  g.clearRect(0, 0, W, H);
  const pw = state.width;
  const ph = state.height;
  const pad = 24;
  const scale = Math.min((W - 2 * pad) / pw, (H - 2 * pad) / ph);
  const ox = W / 2;
  const oy = H / 2;
  const tx = (u) => ox + u * scale;
  const ty = (v) => oy - v * scale;

  // 紙
  g.fillStyle = ui.frontColor + '22';
  g.fillRect(tx(-pw / 2), ty(ph / 2), pw * scale, ph * scale);


  // 表が上を向いている面を少し濃く
  for (const f of state.faces) {
    g.beginPath();
    f.verts.forEach((v, i) => (i ? g.lineTo(tx(v.u), ty(v.v)) : g.moveTo(tx(v.u), ty(v.v))));
    g.closePath();
    g.fillStyle = isFrontUp(f) ? ui.frontColor + '30' : 'rgba(0,0,0,0)';
    g.fill();
  }

  g.lineWidth = 2;
  g.strokeStyle = '#2b2622';
  g.setLineDash([]);
  g.strokeRect(tx(-pw / 2), ty(ph / 2), pw * scale, ph * scale);

  // 折り筋（灰色の細い線）
  g.strokeStyle = 'rgba(90,74,64,.6)';
  g.setLineDash([3, 3]);
  g.lineWidth = 1.2;
  for (const m of state.creaseMarks ?? []) {
    g.beginPath();
    g.moveTo(tx(m.a.u), ty(m.a.v));
    g.lineTo(tx(m.b.u), ty(m.b.v));
    g.stroke();
  }
  g.setLineDash([]);

  for (const cr of creasePattern(state)) {
    if (cr.type === 'flat') {
      g.strokeStyle = 'rgba(0,0,0,.18)';
      g.setLineDash([]);
      g.lineWidth = 1;
    } else if (cr.type === 'valley') {
      g.strokeStyle = '#2f6fd6';
      g.setLineDash([10, 6]);
      g.lineWidth = 2.2;
    } else {
      g.strokeStyle = '#d2392b';
      g.setLineDash([10, 4, 2, 4]);
      g.lineWidth = 2.2;
    }
    g.beginPath();
    g.moveTo(tx(cr.a.u), ty(cr.a.v));
    g.lineTo(tx(cr.b.u), ty(cr.b.v));
    g.stroke();
  }
  g.setLineDash([]);
}

// ================================================================ ループ

function resize() {
  const r = canvas.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  course.resize(r.width, r.height);
  analysis?.resize(r.width, r.height);
  if (mode === 'analysis') fitAnalysisFrame();
  const prevAspect = camera.aspect;
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
  // 縦長の画面では紙がはみ出さないように少し離れる
  const fit = (a) => 5.6 * Math.max(1, 0.95 / a);
  const offset = camera.position.clone().sub(controls.target);
  offset.multiplyScalar(fit(camera.aspect) / fit(prevAspect));
  camera.position.copy(controls.target).add(offset);
}
window.addEventListener('resize', resize);

let lastFrame = performance.now();
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (dirty) {
    rebuildGeometry();
    dirty = false;
  }
  if (mode === 'analysis') {
    updateAnalysisFrame(dt);
    analysis.render();
    return;
  }
  if (mode === 'fly' || mode === 'menu') {
    course.update(dt);
    course.render();
    return;
  }
  // 注視点をゆっくり紙の中心へ
  const d = targetGoal.clone().sub(controls.target);
  if (d.lengthSq() > 1e-8 && input.phase === 'idle') {
    d.multiplyScalar(0.08);
    controls.target.add(d);
    camera.position.add(d);
  }
  controls.update();
  renderer.render(scene, camera);
}

// ================================================================ 飛ばす画面

let mode = 'fold'; // 'fold' | 'fly'
const records = new Records();
let currentPlane = null; // 飛ばしている紙飛行機の ID
let lastRecordId = null; // 最後に記録した 1 投
const course = new Course({
  renderer, paperGeom, edgeGeom, frontMat, backMat,
  onLanded: (f) => showFlyResult(f),
  onReplayEnd: () => endReplayUi(),
  onUpdate: (info) => updateFlyHud(info),
  onSwing: (sw) => showGrade(sw),
  onWind: () => updateWindHud(),
});

// 風の表示：矢印は風が吹いていく向き（画面の上が投げる方向）
function updateWindHud() {
  const w = course.wind;
  const d = describeWind(w, course.yaw);
  $('wind-text').textContent = d.text;
  $('fly-wind').classList.toggle('calm', w.speed < 0.05);
  // ➤ は右向きの文字。上（投げる方向）を 0° として、左回りの風向きを画面の回転に直す
  const rel = (w.dir * 180) / Math.PI - course.yaw;
  $('wind-arrow').firstElementChild.style.transform = `rotate(${-90 - rel}deg) scale(${0.7 + 0.3 * Math.min(1, w.speed / 2)})`;
}

const GRADE_TEXT = { just: 'ジャスト！', good: 'ナイス', early: '早い！', late: '遅い！', miss: 'ミス…' };
let gradeTimer = 0;
function showGrade(sw) {
  const el = $('fly-grade');
  el.textContent = GRADE_TEXT[sw.grade];
  el.className = `show ${sw.grade}`;
  clearTimeout(gradeTimer);
  gradeTimer = setTimeout(() => { el.className = sw.grade; }, 1100);
}

function toggleFly() {
  if (mode === 'fold') openBrief();
  else if (mode === 'brief') closeBrief();
  else if (mode === 'fly') exitFly();
}

// ================================================================ メインメニュー

function showMenu() {
  if (mode === 'fly') exitFly();
  if (mode === 'brief') closeBrief();
  if (input.phase !== 'idle') cancelInput();
  mode = 'menu';
  document.body.classList.add('menu');
  $('menu').hidden = false;
  $('howto').hidden = true;
  $('menu-presets').hidden = true;
  $('ranking').hidden = true;
  course.setAttract(true);
  if (course.wind.speed === 0 && course.windEnabled) course.newWind();
  updateMenu();
  resize();
}

function leaveMenu() {
  document.body.classList.remove('menu');
  $('menu').hidden = true;
  $('ranking').hidden = true;
  course.setAttract(false);
  mode = 'fold';
  resize();
  recenter(true);
  updateHint();
}

function updateMenu() {
  const b = records.best;
  $('menu-best').textContent = b ? `🏆 ベスト ${b.distance.toFixed(2)} m${b.name ? `（${b.name}）` : ''}` : '';
  $('menu-version').textContent = `v${VERSION}`;
  const w = $('menu-wind');
  w.classList.toggle('on', course.windEnabled);
  w.textContent = course.windEnabled ? '🌬 風あり' : '🌬 風なし';
  $('menu-fold').textContent = state.steps.length ? '✎ 折りかけの紙飛行機に戻る' : '✎ 紙飛行機を折る';
}

// 見本を、アニメーションなしですぐに折った状態にする
function loadPresetInstant(preset) {
  if (state.steps.length) undoStack.push(cloneState(state));
  redoStack = [];
  ui.shape = 'square';
  $('paper-shape').value = 'square';
  let s = createPaper(...PAPER_SHAPES.square);
  for (const op of preset.steps) {
    const first = s.steps.length;
    const r = applyOp(s, op);
    if (r.error) break;
    s = r.state;
    if (s.steps[first]) s.steps[first].caption = op.caption;
  }
  preset.steps.forEach((op, i) => { if (op.angle !== undefined && s.steps[i]) s.steps[i].angle = op.angle; });
  state = s;
  preset.lastId = planeId(state);
  updateTextures();
  dirty = true;
  renderSteps();
  drawCreasePattern();
  recenter(true);
  updateButtons();
}

// ================================================================ 準備画面（折り紙 → コース）

let briefWind = CALM;

function planeNameFor(st) {
  const id = planeId(st);
  const preset = PRESETS.find((p) => p.lastId === id);
  if (preset) return preset.name;
  return st.steps.length ? `${st.steps.length} 手で折った紙飛行機` : '折っていない紙';
}

function stars(n) {
  return `${'★'.repeat(n)}<span class="off">${'★'.repeat(3 - n)}</span>`;
}

function openBrief() {
  if (busy) { toast('折り終わるまで待ってください'); return; }
  if (input.phase !== 'idle') cancelInput();
  if (dirty) { rebuildGeometry(); dirty = false; }
  const m = PAPER_METERS[ui.shape] ?? 0.075;
  const a = analyzeAirplane(state, { metersPerUnit: m });
  if (!a) { toast('紙がありません'); return; }
  mode = 'brief';
  document.body.classList.add('brief');
  $('brief').hidden = false;
  snapRing.visible = false;
  clearPreview();
  // 紙飛行機をゆっくり回して見せる
  controls.autoRotate = true;
  controls.autoRotateSpeed = 2.5;
  resize();

  $('brief-name').textContent = planeNameFor(state);
  const dl = $('brief-stats');
  dl.innerHTML = '';
  for (const [k, v] of [
    ['重さ', `${(a.mass * 1000).toFixed(2)} g`],
    ['翼幅 × 全長', `${(a.span * 100).toFixed(1)} × ${(a.length * 100).toFixed(1)} cm`],
    ['翼の面積', `${(a.wingArea * 1e4).toFixed(1)} cm²`],
  ]) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
  const sm = a.staticMargin, dih = a.dihedral, sym = a.symmetry, S = a.wingArea * 1e4;
  const rate = [
    ['重心のバランス', sm >= 0 && sm <= 0.25 ? 3 : sm >= -0.06 && sm <= 0.4 ? 2 : 1],
    ['左右の安定（上反角）', dih >= 0 && dih <= 20 ? 3 : dih >= -12 && dih <= 30 ? 2 : 1],
    ['まっすぐ飛ぶ（左右対称）', sym >= 0.97 ? 3 : sym >= 0.9 ? 2 : 1],
    ['よく滑空する（翼の大きさ）', S >= 50 ? 3 : S >= 25 ? 2 : 1],
  ];
  $('brief-stars').innerHTML = rate.map(([k, n]) => `<span>${k}</span><span class="st">${stars(n)}</span>`).join('');
  const pred = simulateThrow(a, { speed: 10, angle: 5 });
  $('brief-predict').textContent = `${pred.distance.toFixed(1)} m`;
  const pb = records.bestFor(planeId(state));
  $('brief-best').textContent = pb ? `この紙飛行機のベスト ${pb.distance.toFixed(2)} m` : 'この紙飛行機はまだ投げていません';
  briefWind = course.windEnabled ? randomWind() : CALM;
  $('brief-wind').textContent = `いまのコースの風：${describeWind(briefWind).text}`;
}

function closeBrief() {
  mode = 'fold';
  document.body.classList.remove('brief');
  $('brief').hidden = true;
  controls.autoRotate = false;
  resize();
  updateHint();
}

// ================================================================ 分析モード（投げたあと）

let analysis = null; // 最初の resize より前に参照されるので、あとで作る
const an = { t: 0, playing: false, lastBuild: 0, diag: null };

function enterAnalysis() {
  const f = course.flight;
  if (!f || course.phase !== 'landed') return;
  mode = 'analysis';
  document.body.classList.add('analysis');
  $('analysis').hidden = false;
  $('an-note').textContent = ANALYSIS_NOTE;
  analysis.controls.enabled = true;
  resize();
  analysis.setup({ state, aero: course.aero, flight: f, metersPerUnit: course.metersPerUnit });
  an.diag = diagnose(f, course.aero);
  renderDiagnosis(an.diag);
  const slider = $('an-time');
  slider.max = f.time.toFixed(2);
  // はじめは、いちばん揚力を使っている（迎え角の大きい）飛行中の瞬間を見せる
  const mid = f.path.reduce((best, p) => (p.t > 0.2 && p.t < f.time - 0.1 && Math.abs(p.alpha) > Math.abs(best.alpha) && Math.abs(p.alpha) < 0.35 ? p : best), f.path[Math.floor(f.path.length / 3)] ?? f.path[0]);
  an.t = mid.t;
  an.playing = false;
  $('an-play').textContent = '▶';
  setAnalysisTime(an.t, true);
  // 狭い画面では、はじめから診断をたたんでおく
  for (const id of ['an-side', 'an-legend']) {
    $(id).classList.toggle('folded', window.innerWidth < 900);
    $(id).querySelector('.an-fold').textContent = $(id).classList.contains('folded') ? '＋' : '－';
  }
  fitAnalysisFrame();
}

// パネルに隠れない空き領域を求めて、3D をそこに合わせる
function fitAnalysisFrame() {
  const c = canvas.getBoundingClientRect();
  const W = c.width, H = c.height;
  let x0 = 0, x1 = W, y0 = 0, y1 = H;
  const box = (id) => {
    const el = $(id);
    if (!el || getComputedStyle(el).display === 'none') return null;
    const r = el.getBoundingClientRect();
    return { l: r.left - c.left, r: r.right - c.left, t: r.top - c.top, b: r.bottom - c.top };
  };
  const top = document.querySelector('.an-top').getBoundingClientRect();
  y0 = Math.max(y0, top.bottom - c.top + 6);
  const bottom = box('an-bottom');
  if (bottom) y1 = Math.min(y1, bottom.t - 6);
  const side = box('an-side');
  // 左のパネル：横に置いてあるときは左はしを、下に置いてある（狭い画面）ときは下はしを削る
  if (side) {
    if (side.r < W * 0.45 && side.b - side.t > (y1 - y0) * 0.4) x0 = Math.max(x0, side.r + 6);
    else if (side.t > H * 0.4) y1 = Math.min(y1, side.t - 6);
  }
  const legend = box('an-legend');
  if (legend && legend.l > W * 0.55 && legend.b - legend.t > (y1 - y0) * 0.4) x1 = Math.min(x1, legend.l - 6);
  if (x1 - x0 < 160) { x0 = 0; x1 = W; }
  if (y1 - y0 < 120) { y0 = 0; y1 = H; }
  analysis.setFrame(W, H, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

function toggleAnalysisPanel(id) {
  const el = $(id);
  el.classList.toggle('folded');
  const b = el.querySelector('.an-fold');
  if (id !== 'an-bottom') b.textContent = el.classList.contains('folded') ? '＋' : '－';
  fitAnalysisFrame();
}

function exitAnalysis() {
  mode = 'fly';
  an.playing = false;
  document.body.classList.remove('analysis');
  $('analysis').hidden = true;
  analysis.controls.enabled = false;
  resize();
}

function renderDiagnosis(d) {
  const ul = $('an-findings');
  ul.innerHTML = '';
  for (const f of d.findings) {
    const li = document.createElement('li');
    li.className = f.level;
    const b = document.createElement('b'); b.textContent = f.title;
    const p = document.createElement('span'); p.textContent = f.text;
    const fix = document.createElement('span'); fix.className = 'fix'; fix.textContent = f.fix;
    li.append(b, p, fix);
    ul.append(li);
  }
  const st = d.stats;
  const dl = $('an-stats');
  dl.innerHTML = '';
  for (const [k, v] of [
    ['飛距離', `${st.distance.toFixed(2)} m`],
    ['滞空時間', `${st.time.toFixed(2)} 秒`],
    ['速さ（最高 / 最低）', `${st.maxV.toFixed(1)} / ${st.minV.toFixed(1)} m/s`],
    ['迎え角（最大）', `${st.maxAlpha.toFixed(1)}°`],
    ['失速していた時間', `${Math.round(st.stallFraction * 100)} %`],
    ['揚抗比（平均 / この機体の最高）', `${st.meanLD.toFixed(1)} / ${st.bestLD.toFixed(1)}`],
  ]) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
}

function setAnalysisTime(t, rebuild = false) {
  const f = course.flight;
  an.t = Math.max(0, Math.min(f.time, t));
  $('an-time').value = an.t;
  // 流れの計算は重いので、再生中は少し間をあけて計算し直す
  const now = performance.now();
  if (rebuild || now - an.lastBuild > 250) {
    analysis.setTime(an.t);
    an.lastBuild = now;
  } else {
    analysis.updateForces(analysis.sample = pathAt(f, an.t));
  }
  const p = analysis.sample;
  const fo = analysis.forces;
  $('an-readout').innerHTML = `<b>${an.t.toFixed(2)} 秒</b>　速さ <b>${p.V.toFixed(1)}</b> m/s　迎え角 <b>${(p.alpha * 180 / Math.PI).toFixed(1)}°</b>　高さ <b>${p.pos[2].toFixed(2)}</b> m　距離 <b>${Math.hypot(p.pos[0], p.pos[1]).toFixed(1)}</b> m　揚力 / 重さ <b>${(fo.L / fo.W).toFixed(2)}</b>　揚抗比 <b>${fo.LD.toFixed(1)}</b>`;
  drawAnalysisChart();
}

function pathAt(f, t) {
  let p = f.path[0];
  for (const q of f.path) { if (q.t > t) break; p = q; }
  return p;
}

// 下のグラフ：左は横から見た道すじ（失速した所は赤）、右は迎え角の変化（失速角の線つき）
function drawAnalysisChart() {
  const cv = $('an-chart');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const f = course.flight;
  const aStall = Math.min(35, 14 + 10 / Math.max(course.aero.aspectRatio, 0.05)); // flight.js と同じ
  const split = W * 0.6;
  const pad = 18;
  // 横から見た道すじ
  const maxX = Math.max(5, ...f.path.map((p) => Math.hypot(p.pos[0], p.pos[1])));
  const maxZ = Math.max(2, ...f.path.map((p) => p.pos[2]));
  const sx = (split - pad * 2) / maxX;
  const sz = Math.min(sx, (H - pad * 2) / maxZ);
  const X = (d) => pad + d * sx;
  const Z = (z) => H - pad - z * sz;
  ctx.strokeStyle = 'rgba(148,180,220,.35)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, Z(0)); ctx.lineTo(split - pad, Z(0)); ctx.stroke();
  ctx.fillStyle = '#9fb4d0';
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillText('横から見た道すじ', pad, 20);
  for (let i = 1; i < f.path.length; i++) {
    const a = f.path[i - 1], b = f.path[i];
    ctx.strokeStyle = Math.abs(b.alpha) * 180 / Math.PI > aStall ? '#f87171' : '#60a5fa';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(X(Math.hypot(a.pos[0], a.pos[1])), Z(a.pos[2]));
    ctx.lineTo(X(Math.hypot(b.pos[0], b.pos[1])), Z(b.pos[2]));
    ctx.stroke();
  }
  const cur = pathAt(f, an.t);
  ctx.fillStyle = '#fbbf24';
  ctx.beginPath(); ctx.arc(X(Math.hypot(cur.pos[0], cur.pos[1])), Z(cur.pos[2]), 6, 0, Math.PI * 2); ctx.fill();
  // 迎え角の変化
  const x0 = split + pad, x1 = W - pad;
  const T = Math.max(f.time, 0.1);
  const aMax = Math.max(aStall + 5, ...f.path.map((p) => Math.abs(p.alpha) * 180 / Math.PI));
  const tx = (t) => x0 + (t / T) * (x1 - x0);
  const ay = (a) => H / 2 + 10 - (a / aMax) * (H / 2 - 22);
  ctx.fillStyle = 'rgba(248,113,113,.15)';
  ctx.fillRect(x0, ay(aMax), x1 - x0, ay(aStall) - ay(aMax));
  ctx.fillRect(x0, ay(-aStall), x1 - x0, ay(-aMax) - ay(-aStall));
  ctx.strokeStyle = 'rgba(148,180,220,.35)';
  ctx.beginPath(); ctx.moveTo(x0, ay(0)); ctx.lineTo(x1, ay(0)); ctx.stroke();
  ctx.fillStyle = '#9fb4d0';
  ctx.fillText('迎え角（赤い帯 = 失速）', x0, 20);
  ctx.strokeStyle = '#a78bfa';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  f.path.forEach((p, i) => {
    const x = tx(p.t), y = ay(p.alpha * 180 / Math.PI);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(tx(an.t), 26); ctx.lineTo(tx(an.t), H - 4); ctx.stroke();
}

function updateAnalysisFrame(dt) {
  analysis.update(dt);
  if (an.playing) {
    const f = course.flight;
    let t = an.t + dt * 0.5; // 半分の速さで再生
    if (t >= f.time) { t = f.time; an.playing = false; $('an-play').textContent = '▶'; }
    setAnalysisTime(t);
  }
}

function toggleAnalysisPlay() {
  if (!an.playing && an.t >= course.flight.time - 1e-3) an.t = 0;
  an.playing = !an.playing;
  $('an-play').textContent = an.playing ? '❚❚' : '▶';
  if (!an.playing) setAnalysisTime(an.t, true);
}

function analysisKeyDown(e) {
  if (e.key === 'Escape') exitAnalysis();
  else if (e.key === ' ') { e.preventDefault(); toggleAnalysisPlay(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); setAnalysisTime(an.t + 0.1, true); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); setAnalysisTime(an.t - 0.1, true); }
  else if (e.key.toLowerCase() === 'd') toggleAnalysisPanel('an-side');
  else if (e.key.toLowerCase() === 'l') toggleAnalysisPanel('an-legend');
  else if (e.key.toLowerCase() === 'g') toggleAnalysisPanel('an-bottom');
}

// ================================================================ ローディング画面（準備画面 → コース）

const LOAD_TIME = 2600; // 読み込みを見せる時間 [ms]
let loading = null; // { start, ready, tips, i, timer }

function goCourse() {
  if (loading) return;
  // 裏でコースを用意しておき、ローディング画面を上にかぶせる
  closeBrief();
  enterFly();
  course.setWind(briefWind);
  loading = { start: performance.now(), ready: false, tips: shuffledTips(), i: 0, timer: 0 };
  const el = $('loading');
  el.classList.remove('out');
  el.hidden = false;
  $('ld-title').textContent = 'コースへ移動中…';
  $('ld-start').disabled = true;
  $('ld-start').textContent = '読み込み中…';
  showTip(0);
  requestAnimationFrame(loadingTick);
}

function loadingTick() {
  if (!loading) return;
  const k = Math.min(1, (performance.now() - loading.start) / LOAD_TIME);
  // はじめ速く、終わりはゆっくり
  $('ld-fill').style.width = `${(100 * (1 - (1 - k) ** 2)).toFixed(1)}%`;
  if (k < 1) { requestAnimationFrame(loadingTick); return; }
  loading.ready = true;
  $('ld-title').textContent = '準備ができました！';
  const b = $('ld-start');
  b.disabled = false;
  b.textContent = 'コースへ ▶';
  b.focus({ preventScroll: true });
}

function showTip(i) {
  const n = loading.tips.length;
  loading.i = (i + n) % n;
  const t = loading.tips[loading.i];
  const c = TIP_CATEGORIES[t.cat];
  $('tip-icon').textContent = c.icon;
  $('tip-cat').textContent = c.label;
  $('tip-title').textContent = t.title;
  $('tip-text').textContent = t.text;
  $('tip-count').textContent = `${loading.i + 1} / ${n}`;
  const card = document.querySelector('.tip-card');
  card.classList.remove('swap');
  void card.offsetWidth;
  card.classList.add('swap');
  // しばらくしたら次のヒントへ（自分で切り替えたら数え直す）
  clearTimeout(loading.timer);
  loading.timer = setTimeout(() => loading && showTip(loading.i + 1), 7000);
}

function finishLoading() {
  if (!loading || !loading.ready) return;
  clearTimeout(loading.timer);
  loading = null;
  const el = $('loading');
  el.classList.add('out');
  setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, 500);
  course.playIntro();
}

function loadingKeyDown(e) {
  if (e.key === 'ArrowRight') { e.preventDefault(); showTip(loading.i + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); showTip(loading.i - 1); }
  else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); finishLoading(); }
}

function enterFly() {
  if (busy) { toast('折り終わるまで待ってください'); return; }
  if (input.phase !== 'idle') cancelInput();
  if (dirty) { rebuildGeometry(); dirty = false; }
  const m = PAPER_METERS[ui.shape] ?? 0.075;
  const a = analyzeAirplane(state, { metersPerUnit: m });
  if (!a) { toast('紙がありません'); return; }
  course.setAirplane(a, m);
  currentPlane = planeId(state);
  mode = 'fly';
  updateBestHud();
  $('ranking').hidden = true;
  document.body.classList.add('fly');
  $('fly-hud').hidden = false;
  $('fly-result').hidden = true;
  $('replay-bar').hidden = true;
  toggleResultMin(false);
  $('btn-fly').textContent = '✎ 折る';
  controls.enabled = false;
  snapRing.visible = false;
  resize(); // 右のパネルを隠したので、3D を画面いっぱいに
  updateFlyStatic();
}

function exitFly() {
  mode = 'fold';
  hideResult();
  $('replay-bar').hidden = true;
  document.body.classList.remove('fly', 'landed', 'replaying');
  $('fly-hud').hidden = true;
  $('btn-fly').textContent = '✈ 飛ばす';
  controls.enabled = true;
  resize();
}

const VIEWS = ['chase', 'thrower', 'side'];
const VIEW_LABEL = { chase: '🎥 追いかける', thrower: '🎥 見送る', side: '🎥 横から' };
function nextView() {
  return VIEWS[(VIEWS.indexOf(course.view) + 1) % VIEWS.length];
}

function updateFlyStatic() {
  updateWindHud();
  const wb = $('btn-wind');
  wb.classList.toggle('on', course.windEnabled);
  wb.textContent = course.windEnabled ? '🌬 風あり' : '🌬 風なし';
  $('fly-angle').textContent = `${course.angle}°`;
  const y = course.yaw;
  $('fly-yaw').textContent = y === 0 ? 'まっすぐ' : `${y > 0 ? '左' : '右'} ${Math.abs(y)}°`;
  $('btn-view-fly').textContent = VIEW_LABEL[course.view];
  $('btn-view-fly').title = `カメラ：${VIEW_LABEL[course.view].slice(3)}（C で切り替え）`;
}

const swingX = (v) => `${(((v - SWING.min) / (1 - SWING.min)) * 100).toFixed(2)}%`;
const THROW_LABEL = { ready: '振りかぶる', power: '強さを決める', impact: '投げる！', throwing: 'スキップ', flying: 'スキップ', landed: '振りかぶる' };

function updateFlyHud(info) {
  // スイングメーター
  const zero = (0 - SWING.min) / (1 - SWING.min);
  const v = info.phase === 'ready' ? 0 : info.cursor;
  $('swing-cursor').style.left = swingX(v);
  const pw = info.phase === 'power' ? info.cursor : info.power ?? 0;
  $('swing-fill').style.width = `${(pw * (1 - zero) * 100).toFixed(2)}%`;
  const pm = $('swing-power');
  pm.style.display = info.power !== null && info.phase !== 'ready' ? 'block' : 'none';
  if (info.power !== null) pm.style.left = swingX(info.power);
  const sp = info.flight?.speed ?? (info.phase === 'power' || info.phase === 'impact' ? speedFromPower(pw) : null);
  $('fly-speed').textContent = sp ? `${sp.toFixed(1)} m/s` : '';
  $('btn-throw').textContent = THROW_LABEL[info.phase] ?? '振りかぶる';
  const flying = info.phase === 'flying' || info.phase === 'landed' || info.phase === 'replay';
  document.body.classList.toggle('landed', info.phase === 'landed');
  document.body.classList.toggle('replaying', info.phase === 'replay');
  $('fly-dist').firstChild.textContent = (flying ? info.distance : 0).toFixed(2);
  $('fly-sub').textContent = info.phase === 'replay'
    ? `リプレイ　${info.t.toFixed(1)} 秒・高さ ${info.height.toFixed(2)} m`
    : info.phase === 'flying'
    ? `${info.t.toFixed(1)} 秒・高さ ${info.height.toFixed(2)} m（Space で飛ばす）`
    : info.phase === 'ready' ? 'ボタン（Space）を 3 回：振りかぶる → 強さを決める → ジャストで投げる'
      : info.phase === 'power' ? 'ほしい強さのところで押す'
        : info.phase === 'impact' ? '白い「ジャスト」のところで押す！' : '';

}

// ---------------------------------------------------------------- 記録

function planeLabel() {
  const preset = PRESETS.find((p) => p.lastId === currentPlane);
  return preset ? preset.name : `${state.steps.length} 手の紙飛行機`;
}

function saveThrow(f) {
  const sw = f.swing ?? {};
  const res = records.add({
    distance: f.distance, lateral: f.lateral, time: f.time, speed: f.speed, angle: f.angle,
    grade: sw.grade, power: sw.power,
    wind: f.wind ? { speed: f.wind.speed, text: describeWind(f.wind, f.yaw - (sw.yawErr ?? 0)).text } : null,
    plane: currentPlane, planeName: planeLabel(),
    state: cloneState(state),
    paper: { shape: ui.shape, frontColor: ui.frontColor, backColor: ui.backColor, pattern: ui.pattern },
  });
  lastRecordId = res.record.id;
  updateBestHud();
  renderRanking();
  return res;
}

function updateBestHud() {
  const b = records.best;
  $('fly-best-all').textContent = b ? `ベスト ${b.distance.toFixed(2)} m${b.name ? `（${b.name}）` : ''}` : 'まだ記録なし';
  const pb = currentPlane ? records.bestFor(currentPlane) : null;
  $('fly-best-plane').textContent = pb ? `この紙飛行機 ${pb.distance.toFixed(2)} m` : '';
  course.setBest(b ? b.distance : null);
}

const fmtDate = (iso) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function renderRanking() {
  const ol = $('ranking-list');
  ol.innerHTML = '';
  records.ranking.forEach((r, i) => {
    const li = document.createElement('li');
    if (r.id === lastRecordId) li.className = 'me';
    const no = document.createElement('span');
    no.className = 'no';
    no.textContent = i + 1;
    const dist = document.createElement('span');
    dist.className = 'dist';
    dist.textContent = `${r.distance.toFixed(2)} m`;
    const who = document.createElement('span');
    who.className = 'who';
    const grade = r.grade ? `・${GRADE_TEXT[r.grade]}` : '';
    const wind = r.wind ? `・${r.wind.text}` : '';
    who.textContent = `${r.name || 'ななし'}・${r.planeName || '紙飛行機'}${grade}${wind}・${fmtDate(r.date)}`;
    li.append(no, dist);
    if (r.state) {
      const b = document.createElement('button');
      b.textContent = 'この機体で飛ばす';
      b.title = 'この記録の紙飛行機を呼び出す';
      b.onclick = () => loadRecordPlane(r);
      li.append(b);
    }
    li.append(who);
    ol.append(li);
  });
  $('ranking-stats').textContent = records.throws ? `これまでに ${records.throws} 回投げました` : '';
}

function loadRecordPlane(r) {
  if (busy || !r.state) return;
  undoStack.push(cloneState(state));
  redoStack = [];
  state = cloneState(r.state);
  const p = r.paper ?? {};
  if (p.shape) { ui.shape = p.shape; $('paper-shape').value = p.shape; }
  if (p.frontColor) { ui.frontColor = p.frontColor; $('color-front').value = p.frontColor; }
  if (p.backColor) { ui.backColor = p.backColor; $('color-back').value = p.backColor; }
  if (p.pattern) { ui.pattern = p.pattern; $('paper-pattern').value = p.pattern; }
  updateTextures();
  dirty = true;
  renderSteps();
  drawCreasePattern();
  recenter(true);
  updateButtons();
  enterFly();
  toast(`${r.distance.toFixed(2)} m の紙飛行機を呼び出しました`);
}

function toggleRanking(show = $('ranking').hidden) {
  $('ranking').hidden = !show;
  if (show) { $('player-name').value = records.name; renderRanking(); }
}

function showFlyResult(f) {
  const res = saveThrow(f);
  const rk = $('fly-result-rank');
  rk.className = 'rank';
  if (res.isBest && res.prevBest) { rk.textContent = '🏆 新記録！'; rk.classList.add('new'); }
  else if (res.isBest) rk.textContent = '🏆 はじめての記録！';
  else if (res.rank) rk.textContent = `ランキング ${res.rank} 位`;
  else if (res.isPlaneBest) rk.textContent = 'この紙飛行機のベスト更新';
  else rk.textContent = '';
  $('fly-result-dist').textContent = `${f.distance.toFixed(2)} m`;
  const sw = f.swing;
  $('fly-result-grade').textContent = sw ? `${GRADE_TEXT[sw.grade]}　強さ ${Math.round(sw.power * 100)}%` : '';
  const side = Math.abs(f.lateral) < 0.05 ? 'まっすぐ' : `${f.lateral > 0 ? '左' : '右'}へ ${Math.abs(f.lateral).toFixed(2)} m`;
  $('fly-result-sub').textContent = `${f.speed.toFixed(1)} m/s・${Math.round(f.angle)}°で投げて、滞空 ${f.time.toFixed(2)} 秒・${side}${f.wind && f.wind.speed >= 0.05 ? `・${describeWind(f.wind, course.yaw).text}` : ''}`;
  // 落ちた様子を見てから、結果を出す
  clearTimeout(resultTimer);
  resultTimer = setTimeout(() => {
    if (mode === 'fly' && course.phase === 'landed') $('fly-result').hidden = false;
  }, RESULT_DELAY);
}

const RESULT_DELAY = 1100; // 着地してから結果を出すまで [ms]
let resultTimer = 0;

function hideResult() {
  clearTimeout(resultTimer);
  $('fly-result').hidden = true;
}

function flyAgain() {
  hideResult();
  $('replay-bar').hidden = true;
  course.reset();
}

function flyPress(e) {
  hideResult();
  course.press(e?.timeStamp ?? performance.now());
}

// 結果をたたむ / ひらく（落ちた所をよく見たいとき）
function toggleResultMin(force) {
  const el = $('fly-result');
  const on = force ?? !el.classList.contains('min-on');
  el.classList.toggle('min-on', on);
  $('btn-result-min').textContent = on ? '▴' : '▾';
}

// ---------------------------------------------------------------- リプレイ

let replaySpeed = 1;

function startReplay() {
  if (!course.flight || (course.phase !== 'landed' && course.phase !== 'replay')) return;
  hideResult();
  $('replay-bar').hidden = false;
  course.replay(replaySpeed);
}

function setReplaySpeed(v) {
  replaySpeed = v;
  course.setReplaySpeed(v);
  for (const b of document.querySelectorAll('#replay-bar [data-speed]')) b.classList.toggle('on', +b.dataset.speed === v);
}

function endReplayUi() {
  $('replay-bar').hidden = true;
  if (mode === 'fly') $('fly-result').hidden = false;
}

function flyKeyDown(e) {
  const k = e.key;
  if (k === ' ') {
    e.preventDefault();
    if (e.repeat) return;
    flyPress(e);
  } else if (k === 'ArrowUp') { e.preventDefault(); course.setAngle(course.angle + 1); }
  else if (k === 'ArrowDown') { e.preventDefault(); course.setAngle(course.angle - 1); }
  else if (k === 'ArrowLeft') { e.preventDefault(); course.setYaw(course.yaw + 1); }
  else if (k === 'ArrowRight') { e.preventDefault(); course.setYaw(course.yaw - 1); }
  else if (k.toLowerCase() === 'c') course.setView(nextView());
  else if (k === 'Enter' && course.phase === 'landed') flyAgain();
  else if (k.toLowerCase() === 'p' && (course.phase === 'landed' || course.phase === 'replay')) startReplay();
  else if (k.toLowerCase() === 'h' && course.phase === 'landed') toggleResultMin();
  else if (k === 'Escape' && course.phase === 'replay') course.stopReplay();
  else if (k.toLowerCase() === 'a' && course.phase === 'landed') enterAnalysis();
  else if (k.toLowerCase() === 'r') toggleRanking();
  else if (k.toLowerCase() === 'w') course.setWindEnabled(!course.windEnabled);
  else if (k === 'Escape') { if (!$('ranking').hidden) toggleRanking(false); else exitFly(); }
  updateFlyStatic();
}


$('btn-fly').onclick = toggleFly;
$('btn-view-fly').onclick = () => { course.setView(nextView()); updateFlyStatic(); };
$('btn-again').onclick = flyAgain;
$('btn-ranking').onclick = () => toggleRanking();
$('btn-wind').onclick = () => { course.setWindEnabled(!course.windEnabled); updateFlyStatic(); };
$('btn-ranking-close').onclick = () => toggleRanking(false);
$('player-name').oninput = (e) => {
  records.name = e.target.value.trim();
  // 直前の 1 投にも名前を付ける
  if (lastRecordId) { records.rename(lastRecordId, records.name); renderRanking(); updateBestHud(); }
};
$('btn-ranking-clear').onclick = () => {
  if (!confirm('ランキングと記録をすべて消しますか？（元に戻せません）')) return;
  records.clear();
  lastRecordId = null;
  renderRanking();
  updateBestHud();
};
$('btn-refold-plane').onclick = exitFly;
{
  const b = $('btn-throw');
  // 押した瞬間に反応させる（click だと離したときになり、タイミングがずれる）
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); flyPress(e); });
}
// 角度・向きのボタン（押し続けると連続で変わる）
for (const btn of document.querySelectorAll('#fly-controls [data-adj]')) {
  let timer = 0;
  const apply = () => {
    const d = +btn.dataset.d;
    if (btn.dataset.adj === 'angle') course.setAngle(course.angle + d);
    else course.setYaw(course.yaw + d);
    updateFlyStatic();
  };
  const stop = () => { clearTimeout(timer); clearInterval(timer); };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    apply();
    stop();
    timer = setTimeout(() => { timer = setInterval(apply, 60); }, 350);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, stop);
}

$('version').textContent = `v${VERSION}`;

// ================================================================ バージョン情報

function showVersionInfo() {
  const ol = $('vi-list');
  if (!ol.children.length) {
    CHANGELOG.forEach((e, i) => {
      const li = document.createElement('li');
      if (/折り紙シミュレーター）$/.test(e.summary)) li.className = 'origami';
      const det = document.createElement('details');
      if (i === 0) det.open = true;
      const sum = document.createElement('summary');
      const v = document.createElement('span'); v.className = 'v'; v.textContent = `v${e.version}`;
      const d = document.createElement('span'); d.className = 'd'; d.textContent = e.date.replace(/-/g, '/');
      const t = document.createElement('span'); t.className = 's'; t.textContent = e.summary;
      if (i === 0) { const n = document.createElement('span'); n.className = 'new'; n.textContent = '最新'; t.append(n); }
      sum.append(v, d, t);
      const ul = document.createElement('ul');
      for (const it of e.items) {
        const li2 = document.createElement('li');
        li2.textContent = it.text;
        if (it.sub.length) {
          const sub = document.createElement('ul');
          for (const x of it.sub) { const l = document.createElement('li'); l.textContent = x; sub.append(l); }
          li2.append(sub);
        }
        ul.append(li2);
      }
      det.append(sum, ul);
      li.append(det);
      ol.append(li);
    });
  }
  $('vi-current').textContent = `紙飛行機シミュレーター v${VERSION}（${CHANGELOG[0].date.replace(/-/g, '/')}）`;
  $('version-info').hidden = false;
}

function hideVersionInfo() { $('version-info').hidden = true; }

$('version').onclick = showVersionInfo;
$('menu-version').onclick = showVersionInfo;
$('vi-close').onclick = hideVersionInfo;
$('version-info').addEventListener('click', (e) => { if (e.target.id === 'version-info') hideVersionInfo(); });
window.addEventListener('keydown', (e) => {
  if (!$('version-info').hidden && e.key === 'Escape') { e.stopImmediatePropagation(); hideVersionInfo(); }
}, true);
$('aero-marker').onchange = () => { aeroMarker.visible = !!lastAero && $('aero-marker').checked; };
updateTextures();
resize();
renderSteps();
drawCreasePattern();
updateButtons();
updateHint();

// メインメニューと準備画面のボタン
document.body.append($('ranking')); // メニューからも開けるよう、飛ばす画面の外に出す
$('link-wings').checked = store.get('origami.linkWings', true);
$('link-wings').onchange = (e) => store.set('origami.linkWings', e.target.checked);
analysis = new Analysis({ renderer, canvas });
resize();
$('btn-analyze').onclick = enterAnalysis;
$('btn-replay').onclick = startReplay;
$('btn-result-min').onclick = () => toggleResultMin();
$('rp-again').onclick = startReplay;
$('rp-stop').onclick = () => course.stopReplay();
$('rp-view').onclick = () => { course.setView(nextView()); updateFlyStatic(); };
for (const b of document.querySelectorAll('#replay-bar [data-speed]')) b.onclick = () => setReplaySpeed(+b.dataset.speed);
$('an-back').onclick = exitAnalysis;
$('an-again').onclick = () => { exitAnalysis(); flyAgain(); };
$('an-refold').onclick = () => { exitAnalysis(); exitFly(); };
$('an-play').onclick = toggleAnalysisPlay;
$('an-time').oninput = (e) => { an.playing = false; $('an-play').textContent = '▶'; setAnalysisTime(+e.target.value); };
$('an-time').onchange = (e) => setAnalysisTime(+e.target.value, true);
for (const b of document.querySelectorAll('#analysis [data-fold]')) b.onclick = () => toggleAnalysisPanel(b.dataset.fold);
for (const cb of document.querySelectorAll('#analysis [data-show]')) {
  cb.onchange = () => analysis.setShow(cb.dataset.show, cb.checked);
}
$('btn-menu').onclick = showMenu;
$('menu-fold').onclick = leaveMenu;
$('menu-quick').onclick = () => {
  const box = $('menu-presets');
  box.innerHTML = '';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.textContent = p.name;
    b.onclick = () => { loadPresetInstant(p); leaveMenu(); openBrief(); };
    box.append(b);
  }
  box.hidden = !box.hidden;
};
$('menu-ranking').onclick = () => toggleRanking(true);
$('menu-howto').onclick = () => { $('howto').hidden = false; };
$('howto-close').onclick = () => { $('howto').hidden = true; };
$('menu-wind').onclick = () => { course.setWindEnabled(!course.windEnabled); updateMenu(); };
$('brief-go').onclick = goCourse;
$('ld-start').onclick = finishLoading;
$('tip-next').onclick = () => showTip(loading.i + 1);
$('tip-prev').onclick = () => showTip(loading.i - 1);
$('brief-back').onclick = closeBrief;
loop();
showMenu();

// デバッグ・テスト用
window.__origami = {
  get state() { return state; },
  get busy() { return busy; },
  get aero() { return lastAero; },
  get mode() { return mode; },
  records,
  course,
  enterFly,
  exitFly,
  showMenu,
  openBrief,
  goCourse,
  get loading() { return loading; },
  enterAnalysis,
  get analysis() { return analysis; },
  playPreset: (id) => playPreset(PRESETS.find((p) => p.id === id)),
  bgm,
  setView,
  camera,
  controls,
};
