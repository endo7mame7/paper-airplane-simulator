// 分析モード：風洞の中に紙飛行機を置き、空気の流れ・翼の圧力・力を 3D で見せる
//
// 座標は機体座標（x 前、y 右、z 上、重心が原点）を、見やすい大きさに拡大して表示する。
// 流れの計算は airflow.js（揚力線理論による近似）。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { poseFaces } from './paper.js';
import { buildVortexModel, surfaceCp, traceStreamlines } from './airflow.js';

const RAD = Math.PI / 180;

// 速さの比（周りの流れに対して）→ 色。遅い：青、同じ：白っぽい水色、速い：黄〜赤
export function speedColor(ratio, out = new THREE.Color()) {
  const t = Math.max(0, Math.min(1, (ratio - 0.94) / 0.12)); // 0.94〜1.06（翼のまわりの速さの違いは数 % ほど）
  const stops = [[0, 0x2f6fd6], [0.35, 0x5fd3f3], [0.5, 0xe8f6ff], [0.7, 0xffd54a], [1, 0xff5a3c]];
  return lerpStops(stops, t, out);
}

// 圧力係数 Cp → 色。負圧（吸い上げ）：青、ゼロ：白、正圧：赤
export function pressureColor(cp, out = new THREE.Color()) {
  const t = Math.max(0, Math.min(1, (cp + 0.8) / 1.3)); // -0.8〜+0.5（0 が白）
  const stops = [[0, 0x1d4ed8], [0.3, 0x3b82f6], [0.615, 0xf5f5f4], [0.8, 0xfb923c], [1, 0xdc2626]];
  return lerpStops(stops, t, out);
}

function lerpStops(stops, t, out) {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0);
      return out.set(c0).lerp(new THREE.Color(c1), k);
    }
  }
  return out.set(stops[stops.length - 1][1]);
}

function arrow(color) {
  const a = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, color, 0.12, 0.07);
  a.traverse((o) => { if (o.material) { o.material.depthTest = false; o.material.transparent = true; o.renderOrder = 20; } });
  return a;
}

function label(text, color = '#ffffff') {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = '700 44px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif';
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(text).width) + 24;
  c.height = 60;
  ctx.font = font;
  ctx.fillStyle = 'rgba(10,20,35,.7)';
  ctx.beginPath(); ctx.roundRect(0, 0, c.width, 60, 14); ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.renderOrder = 30;
  sp.scale.set((0.09 * c.width) / 60, 0.09, 1);
  sp.userData.base = sp.scale.clone();
  return sp;
}

export class Analysis {
  constructor({ renderer, canvas }) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1626);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 50);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(-1.6, -2.2, 1.2);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 8;
    this.controls.enabled = false;
    this.show = { flow: true, pressure: true, forces: true, vortex: true };

    this.scene.add(new THREE.HemisphereLight(0xdbeafe, 0x0b1626, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(-1, -2, 3);
    this.scene.add(sun);
    // 風洞の床と壁の目盛り
    const grid = new THREE.GridHelper(6, 30, 0x2a4566, 0x1a2c44);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.7;
    this.scene.add(grid);

    this.root = new THREE.Group(); // 機体座標（拡大したもの）
    this.scene.add(this.root);
    this.flowGroup = new THREE.Group();
    this.vortexGroup = new THREE.Group();
    this.forceGroup = new THREE.Group();
    this.root.add(this.flowGroup, this.vortexGroup, this.forceGroup);

    // 紙飛行機（表と裏で別の色を塗るため 2 枚）
    this.planeGeomF = new THREE.BufferGeometry();
    this.planeGeomB = new THREE.BufferGeometry();
    const matF = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.FrontSide, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const matB = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.BackSide, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.planeF = new THREE.Mesh(this.planeGeomF, matF);
    this.planeB = new THREE.Mesh(this.planeGeomB, matB);
    this.edgeGeom = new THREE.BufferGeometry();
    this.edges = new THREE.LineSegments(this.edgeGeom, new THREE.LineBasicMaterial({ color: 0x0b1626, transparent: true, opacity: 0.5 }));
    this.root.add(this.planeF, this.planeB, this.edges);

    // 重心・空力中心
    const ball = (color, r) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      m.renderOrder = 25;
      return m;
    };
    this.cgBall = ball(0x38bdf8, 0.028);
    this.acBall = ball(0xf97316, 0.022);
    this.cgLabel = label('重心', '#7dd3fc');
    this.acLabel = label('空力中心', '#fdba74');
    this.root.add(this.cgBall, this.acBall, this.cgLabel, this.acLabel);

    this.liftArrow = arrow(0x4ade80);
    this.dragArrow = arrow(0xf87171);
    this.weightArrow = arrow(0xe5e7eb);
    this.windArrow = arrow(0x93c5fd);
    this.forceGroup.add(this.liftArrow, this.dragArrow, this.weightArrow);
    this.root.add(this.windArrow);
    this.liftLabel = label('揚力', '#86efac');
    this.dragLabel = label('抗力', '#fca5a5');
    this.weightLabel = label('重さ', '#e5e7eb');
    this.windLabel = label('風（相対風）', '#bfdbfe');
    this.forceGroup.add(this.liftLabel, this.dragLabel, this.weightLabel);
    this.root.add(this.windLabel);

    this.particles = null;
    this.clock = 0;
  }

  // 投げた結果を読み込む
  setup({ state, aero, flight, metersPerUnit }) {
    this.state = state;
    this.aero = aero;
    this.flight = flight;
    this.m = metersPerUnit;
    // 全長がおよそ 1.6 になるように拡大
    this.k = 1.6 / Math.max(aero.length, 0.02);
    this.root.scale.setScalar(this.k);
    this.buildPlane();
    // 球は、拡大しても画面上の大きさが変わらないように縮める
    this.cgBall.scale.setScalar(1 / this.k);
    this.acBall.scale.setScalar(1 / this.k);
    this.cgBall.position.set(0, 0, 0);
    this.acBall.position.set(-aero.staticMargin * aero.mac, 0, 0);
    // ラベルは拡大の影響を打ち消して、画面上でいつも同じくらいの大きさに
    for (const l of [this.cgLabel, this.acLabel, this.liftLabel, this.dragLabel, this.weightLabel, this.windLabel]) {
      l.scale.copy(l.userData.base).multiplyScalar(1 / this.k);
    }
    this.cgLabel.position.set(0, 0, -0.07 / this.k);
    this.acLabel.position.set(-aero.staticMargin * aero.mac, 0, 0.07 / this.k);
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(-1.4, -2.3, 1.1);
    this.lastKey = null;
  }

  // 折った形を、機体座標に直してから表示する
  buildPlane() {
    const { forward: f, right: r, up: u } = this.aero.axes;
    const cg = this.aero.cg.map((v) => v / this.m);
    const m = this.m;
    this.posed = poseFaces(this.state).map(({ face, pts }) => ({
      face,
      pts: pts.map((P) => {
        const d = [P[0] - cg[0], P[1] - cg[1], P[2] - cg[2]];
        return [
          (d[0] * f[0] + d[1] * f[1] + d[2] * f[2]) * m,
          (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) * m,
          (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) * m,
        ];
      }),
    }));
    // 三角形の位置（表も裏も同じ）。three.js の座標では y を左に（x 前・y 左・z 上）。
    // 圧力の色を細かく塗れるよう、三角形を小さく分ける
    const pos = [];
    const ep = [];
    this.verts = []; // { P: 機体座標の点, f: 面の番号 }
    const N = 10;
    const mix = (a, b, c, u, v) => {
      const w = 1 - u - v;
      return [a[0] * w + b[0] * u + c[0] * v, a[1] * w + b[1] * u + c[1] * v, a[2] * w + b[2] * u + c[2] * v];
    };
    this.posed.forEach(({ pts }, fi) => {
      for (let i = 1; i + 1 < pts.length; i++) {
        const A = pts[0], B = pts[i], C = pts[i + 1];
        for (let r = 0; r < N; r++) {
          for (let q = 0; q < N - r; q++) {
            const tris = [[[r, q], [r + 1, q], [r, q + 1]]];
            if (q + r + 2 <= N) tris.push([[r + 1, q], [r + 1, q + 1], [r, q + 1]]);
            for (const tri of tris) {
              for (const [ru, qv] of tri) {
                const P = mix(A, B, C, ru / N, qv / N);
                pos.push(P[0], -P[1], P[2]);
                this.verts.push({ P, f: fi });
              }
            }
          }
        }
      }
    });
    for (const { pts } of this.posed) {
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        ep.push(a[0], -a[1], a[2], b[0], -b[1], b[2]);
      }
    }
    for (const g of [this.planeGeomF, this.planeGeomB]) {
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
      g.computeVertexNormals();
      g.computeBoundingSphere();
    }
    this.edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
  }

  // 飛行中の時刻 t の状態（速さ・迎え角）で、流れと圧力を計算し直す
  setTime(t, force = false) {
    const path = this.flight.path;
    let p = path[0];
    for (const q of path) { if (q.t > t) break; p = q; }
    this.sample = p;
    const V = Math.max(1, p.V);
    const alpha = p.alpha;
    const key = `${V.toFixed(1)}|${(alpha / RAD).toFixed(1)}`;
    if (force || key !== this.lastKey) {
      this.lastKey = key;
      this.model = buildVortexModel(this.aero, { V, alpha, panels: 12 });
      this.paintPressure();
      this.buildFlow();
    }
    this.updateForces(p);
  }

  // 翼の表と裏に、圧力の色を塗る（上を向いた面は上面の圧力、下を向いた面は下面の圧力）
  paintPressure() {
    const colF = this.planeGeomF.attributes.color;
    const colB = this.planeGeomB.attributes.color;
    const plain = new THREE.Color(0xd6d3d1);
    const c = new THREE.Color();
    // 色の強さは、翼でいちばん圧力差の大きい所を基準にする（紙飛行機の圧力差は小さいので）。
    // ただし揚力がほとんどない瞬間まで濃く見えないよう、基準には下限をつける
    let maxCp = 0.08;
    for (const p of this.model.panels) {
      const cp = surfaceCp(this.model, p.lead - 0.05 * (p.lead - p.trail), p.ym);
      maxCp = Math.max(maxCp, Math.abs(cp.upper));
    }
    const gain = 0.75 / maxCp;
    this.cpScale = maxCp;
    // 面ごとの向き
    const faceInfo = this.posed.map(({ pts }) => {
      const a = pts[0], b = pts[1], d = pts[2];
      const nx = (b[1] - a[1]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[1] - a[1]);
      const ny = (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]);
      const nz = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
      const nn = Math.hypot(nx, ny, nz) || 1;
      // 画面の三角形は y を反転しているので、表の向きも反転する
      return { w: Math.max(0, (Math.abs(nz / nn) - 0.5) / 0.5), frontUp: nz < 0 };
    });
    this.verts.forEach(({ P, f }, vi) => {
      const { w, frontUp } = faceInfo[f]; // w：水平な面（翼）ほど 1、縦の面（キール）は 0
      const raw = surfaceCp(this.model, P[0], P[1]);
      const up = this.show.pressure ? pressureColor(raw.upper * gain, c).clone().lerp(plain, 1 - w) : plain;
      const lo = this.show.pressure ? pressureColor(raw.lower * gain, c).clone().lerp(plain, 1 - w) : plain;
      const [cf, cb] = frontUp ? [up, lo] : [lo, up];
      colF.setXYZ(vi, cf.r, cf.g, cf.b);
      colB.setXYZ(vi, cb.r, cb.g, cb.b);
    });
    colF.needsUpdate = true;
    colB.needsUpdate = true;
  }

  // 流線（色つきの線）と、その上を流れる粒
  buildFlow() {
    for (const g of [this.flowGroup, this.vortexGroup]) {
      for (const o of [...g.children]) { g.remove(o); o.geometry?.dispose(); }
    }
    const a = this.aero;
    const L = a.length;
    const b = Math.max(a.span, L * 0.3);
    const seeds = [];
    const x0 = L * 0.9;
    for (let i = 0; i <= 10; i++) {
      for (const zf of [-0.1, 0.02, 0.12]) {
        seeds.push([x0, -0.7 * b + (1.4 * b * i) / 10, zf * b]);
      }
    }
    // 翼端うず：翼端のすぐ外側から流す
    const tipSeeds = [];
    for (const side of [-1, 1]) {
      for (const dz of [-0.02, 0.02]) for (const dy of [0.94, 1.06]) tipSeeds.push([x0, side * (a.span / 2) * dy, dz * b]);
    }
    const step = L / 70;
    this.lines = [
      ...traceStreamlines(this.model, seeds, { step, length: L * 2.6 }).map((l) => ({ ...l, tip: false })),
      ...traceStreamlines(this.model, tipSeeds, { step: step * 0.6, length: L * 2.6 }).map((l) => ({ ...l, tip: true })),
    ];
    const c = new THREE.Color();
    for (const l of this.lines) {
      const pos = [];
      const col = [];
      l.pts.forEach((P, i) => {
        pos.push(P[0], -P[1], P[2]);
        speedColor(l.speed[i], c);
        col.push(c.r, c.g, c.b);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: l.tip ? 0.95 : 0.55 }));
      (l.tip ? this.vortexGroup : this.flowGroup).add(line);
    }
    // 流れる粒（流線にそって動く）
    const N = this.lines.length * 6;
    this.parts = [];
    for (let i = 0; i < N; i++) this.parts.push({ line: i % this.lines.length, u: Math.random() });
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3));
    pg.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(N * 3), 3));
    this.particles = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.022 / this.k, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
    this.flowGroup.add(this.particles);
    this.applyVisibility();
  }

  updateForces(p) {
    const a = this.aero;
    const W = a.mass * 9.81;
    const qS = 0.5 * 1.2 * p.V * p.V * a.wingArea;
    const model = this.model ?? buildVortexModel(a, { V: Math.max(1, p.V), alpha: p.alpha });
    const L = qS * model.CL;
    const D = qS * model.CD;
    const unit = (0.55 / this.k) / Math.max(W, 1e-6); // 重さの矢印の長さ = 0.55（画面の大きさ）
    // 相対風は (-cos α, 0, sin α)。揚力はそれに垂直で上向き、抗力は相対風の向き
    const wind = new THREE.Vector3(-Math.cos(p.alpha), 0, Math.sin(p.alpha));
    const lift = new THREE.Vector3(Math.sin(p.alpha), 0, Math.cos(p.alpha));
    const setA = (ar, lab, dir, len, from = new THREE.Vector3()) => {
      const l = Math.max(Math.abs(len), 1e-6);
      ar.position.copy(from);
      ar.setDirection(dir.clone().multiplyScalar(Math.sign(len) || 1).normalize());
      ar.setLength(l, Math.min(0.12 / this.k, l * 0.35), Math.min(0.07 / this.k, l * 0.25));
      lab.position.copy(from).add(dir.clone().multiplyScalar((Math.sign(len) || 1) * (l + 0.06 / this.k)));
    };
    const acPos = new THREE.Vector3(-a.staticMargin * a.mac, 0, 0);
    setA(this.liftArrow, this.liftLabel, lift, L * unit, acPos);
    setA(this.dragArrow, this.dragLabel, wind, D * unit, acPos);
    // 重さは真下（機体はピッチ角 θ だけ傾いているので、機体座標では θ だけ回る）
    const th = p.theta;
    const down = new THREE.Vector3(Math.sin(th), 0, -Math.cos(th));
    setA(this.weightArrow, this.weightLabel, down, W * unit);
    // 相対風（機首の前から流れてくる）
    const len = 0.45 / this.k;
    const start = new THREE.Vector3(a.length * 0.95, 0, 0).sub(wind.clone().multiplyScalar(len));
    setA(this.windArrow, this.windLabel, wind, len, start);
    this.forces = { L, D, W, LD: D > 0 ? L / D : 0, CL: model.CL, CD: model.CD };
  }

  setShow(key, on) {
    this.show[key] = on;
    if (key === 'pressure') this.paintPressure();
    this.applyVisibility();
  }

  applyVisibility() {
    this.flowGroup.visible = this.show.flow;
    this.vortexGroup.visible = this.show.vortex;
    this.forceGroup.visible = this.show.forces;
  }

  update(dt) {
    this.clock += dt;
    this.controls.update();
    if (!this.particles || !this.lines.length) return;
    // 粒を流線にそって進める（周りより速い所は速く）
    const pos = this.particles.geometry.attributes.position;
    const col = this.particles.geometry.attributes.color;
    const c = new THREE.Color();
    const rate = 0.35; // 1 秒に流線の何割進むか
    this.parts.forEach((pt, i) => {
      const l = this.lines[pt.line];
      const n = l.pts.length - 1;
      const idx = Math.min(n - 1, Math.floor(pt.u * n));
      pt.u += dt * rate * (l.speed[idx] ?? 1);
      if (pt.u >= 1) pt.u -= 1;
      const f = pt.u * n;
      const i0 = Math.min(n - 1, Math.floor(f));
      const k = f - i0;
      const A = l.pts[i0], B = l.pts[i0 + 1];
      pos.setXYZ(i, A[0] + (B[0] - A[0]) * k, -(A[1] + (B[1] - A[1]) * k), A[2] + (B[2] - A[2]) * k);
      speedColor(l.speed[i0], c).lerp(new THREE.Color(0xffffff), 0.35);
      col.setXYZ(i, c.r, c.g, c.b);
    });
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  resize(w, h) {
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

export const ANALYSIS_NOTE = '簡易モデル（揚力線理論）による可視化です。実際の流体計算（CFD）ではありません。';
