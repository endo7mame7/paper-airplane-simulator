// 飛ばすコース：人が紙飛行機を投げて、飛ぶ様子を 3D で見せる
//
// 座標は地面に固定（flight.js と同じ）：x 前（投げる方向）、y 左、z 上。単位は m。
// 紙飛行機の形は、折る画面と同じジオメトリ（折った姿勢の面）をそのまま使い、
// 機体の向き（aero.js が判定した前・右・上）に合わせて回してから、飛行中の姿勢をかける。

import * as THREE from 'three';
import { simulateThrow } from './flight.js';
import { THROW_LIMITS, SWING, speedFromPower, swingResult } from './swing.js';
import { randomWind, windVector, windField, CALM } from './wind.js';

const RAD = Math.PI / 180;
const HAND = new THREE.Vector3(0, 0, 1.6); // 手を離す位置（flight.js の height と合わせる）
// 腕（肩から手まで 0.6m、肩の高さ 1.38m）を前に振り上げて、手が HAND の高さになる角度
const RELEASE_ARM = Math.PI - Math.acos((HAND.z - 1.38) / 0.6);
const RELEASE_REACH = 0.6 * Math.sin(RELEASE_ARM); // そのときの手の前への距離

export { THROW_LIMITS, SWING, speedFromPower, swingResult };

// 記録した道すじを時刻 t で補間する
export function samplePath(path, t) {
  if (!path.length) return null;
  if (t <= path[0].t) return path[0];
  const last = path[path.length - 1];
  if (t >= last.t) return last;
  let lo = 0, hi = path.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = path[lo], b = path[hi];
  const k = (t - a.t) / Math.max(1e-9, b.t - a.t);
  const mix = (x, y) => x + (y - x) * k;
  const mixAngle = (x, y) => x + Math.atan2(Math.sin(y - x), Math.cos(y - x)) * k;
  return {
    t,
    pos: [mix(a.pos[0], b.pos[0]), mix(a.pos[1], b.pos[1]), mix(a.pos[2], b.pos[2])],
    theta: mixAngle(a.theta, b.theta),
    phi: mixAngle(a.phi, b.phi),
    psi: mixAngle(a.psi, b.psi),
    V: mix(a.V, b.V),
  };
}

// 文字を描いたキャンバス
function textCanvas(text, color, bg) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = '700 64px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 32;
  c.width = w;
  c.height = 88;
  ctx.font = font;
  if (bg) { ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(0, 0, w, 88, 20); ctx.fill(); }
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, 46);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, aspect: w / 88 };
}

// 地面に寝かせた文字（投げる人から読める向き）
function groundText(text, size, color) {
  const { tex, aspect } = textCanvas(text, color);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(size * aspect, size),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  m.rotation.z = -Math.PI / 2; // 文字の上が +x（コースの先）、左から右へ読める
  return m;
}

// 文字を貼った板（常にカメラを向く）
function textSprite(text, { size = 0.6, color = '#2b2622', bg = null, bold = true } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `${bold ? '700 ' : ''}64px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 32;
  c.width = w;
  c.height = 88;
  ctx.font = font;
  if (bg) {
    ctx.fillStyle = bg;
    const r = 20;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, 88, r);
    ctx.fill();
  }
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, 46);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  sp.scale.set((size * w) / 88, size, 1);
  return sp;
}

export class Course {
  /**
   * @param {object} o
   *   renderer: THREE.WebGLRenderer
   *   paperGeom, edgeGeom: 折る画面の紙のジオメトリ（共有）
   *   frontMat, backMat: 紙の表と裏のマテリアル（共有）
   *   onLanded(result): 地面に落ちたときに呼ばれる
   *   onUpdate(info): HUD の更新用（毎フレーム）
   */
  constructor(o) {
    this.o = o;
    this.renderer = o.renderer;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xcfe5f3);
    this.scene.fog = new THREE.Fog(0xcfe5f3, 30, 90);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.03, 200);
    this.camera.up.set(0, 0, 1);

    this.phase = 'ready'; // 'ready' | 'power' | 'impact' | 'throwing' | 'flying' | 'landed'
    this.angle = 5;
    this.yaw = 0;
    this.cursor = 0;      // スイングメーターのカーソル
    this.power = null;    // 決めた強さ
    this.swing = null;    // swingResult の結果
    this.throwAnim = 0;
    this.flight = null;
    this.flightT = 0;
    this.view = 'chase'; // 'chase' | 'side'
    this.aero = null;
    this.markers = [];
    this.windEnabled = true;
    this.wind = CALM;
    this.clock = 0;

    this.buildWorld();
    this.buildWind();
    this.buildThrower();
    this.buildPlane();
    this.resetCamera(true);
  }

  // ---------------------------------------------------------------- 世界

  buildWorld() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0xffffff, 0x7a9a5a, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const sc = sun.shadow.camera;
    sc.left = -3; sc.right = 3; sc.top = 3; sc.bottom = -3; sc.near = 0.5; sc.far = 30;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    s.add(sun, sun.target);
    this.sun = sun;

    // 芝生
    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0x8dbb6a, roughness: 1 }),
    );
    grass.receiveShadow = true;
    s.add(grass);

    // コース（幅 4m、60m）と距離の線
    const lane = new THREE.Mesh(
      new THREE.PlaneGeometry(62, 4),
      new THREE.MeshStandardMaterial({ color: 0xc9d9a8, roughness: 1 }),
    );
    lane.position.set(30, 0, 0.002);
    lane.receiveShadow = true;
    s.add(lane);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    for (let m = 0; m <= 60; m++) {
      const major = m % 5 === 0;
      const w = m === 0 ? 0.08 : major ? 0.05 : 0.02;
      const len = major ? 4 : 1.2;
      const l = new THREE.Mesh(new THREE.PlaneGeometry(w, len), lineMat);
      l.position.set(m, major ? 0 : 0, 0.004);
      s.add(l);
      if (major && m > 0) {
        for (const side of [-1, 1]) {
          const t = groundText(`${m}m`, 0.5, '#ffffff');
          t.position.set(m + 0.35, side * 2.6, 0.006);
          s.add(t);
        }
      }
    }
    // 投げる位置
    const start = groundText('START', 0.4, '#ffffff');
    start.position.set(-0.35, 1.3, 0.006);
    s.add(start);

    // 飛んだ跡
    this.trailGeom = new THREE.BufferGeometry();
    this.trail = new THREE.Line(this.trailGeom, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 }));
    this.trail.frustumCulled = false;
    s.add(this.trail);

    // 着地点の目印（毎回置く）
    this.markerGroup = new THREE.Group();
    s.add(this.markerGroup);

    // ベスト記録の線
    this.bestGroup = new THREE.Group();
    this.bestGroup.visible = false;
    const bestLine = new THREE.Mesh(
      new THREE.PlaneGeometry(0.06, 4.4),
      new THREE.MeshBasicMaterial({ color: 0xffc107 }),
    );
    bestLine.position.z = 0.008;
    this.bestGroup.add(bestLine);
    s.add(this.bestGroup);
  }

  // 吹き流しと、風に流れる綿毛
  buildWind() {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.025, 2.2, 10),
      new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.3, roughness: 0.5 }),
    );
    pole.rotation.x = Math.PI / 2;
    pole.position.z = 1.1;
    pole.castShadow = true;
    g.add(pole);
    // 吹き流し：風下へ向く円すい（赤白のしま）。付け根を軸に回す
    const sock = new THREE.Group();
    sock.position.z = 2.15;
    const len = 0.7;
    for (let i = 0; i < 4; i++) {
      const r0 = 0.12 - i * 0.02, r1 = 0.12 - (i + 1) * 0.02;
      const seg = new THREE.Mesh(
        new THREE.CylinderGeometry(r1, r0, len / 4, 16, 1, true),
        new THREE.MeshStandardMaterial({ color: i % 2 ? 0xffffff : 0xe53935, side: THREE.DoubleSide, roughness: 0.8 }),
      );
      seg.rotation.z = -Math.PI / 2; // 円すいの軸を +x に
      seg.position.x = (i + 0.5) * (len / 4);
      seg.castShadow = true;
      sock.add(seg);
    }
    g.add(sock);
    g.position.set(4, -2.8, 0);
    this.scene.add(g);
    this.sock = sock;

    // 綿毛（風で流れる点）
    const N = 260;
    this.fluffBox = { x: 16, y: 10, z: 4 };
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * this.fluffBox.x;
      pos[i * 3 + 1] = (Math.random() - 0.5) * this.fluffBox.y;
      pos[i * 3 + 2] = Math.random() * this.fluffBox.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // 丸くぼかした点
    const dotCanvas = document.createElement('canvas');
    dotCanvas.width = dotCanvas.height = 32;
    const dc = dotCanvas.getContext('2d');
    const grd = dc.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.5, 'rgba(255,255,255,.7)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    dc.fillStyle = grd;
    dc.fillRect(0, 0, 32, 32);
    this.fluff = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffffff, size: 0.05, map: new THREE.CanvasTexture(dotCanvas),
      transparent: true, opacity: 0.85, depthWrite: false,
    }));
    this.fluff.frustumCulled = false;
    this.scene.add(this.fluff);
    this.fluffCenter = new THREE.Vector3(4, 0, 0);
  }

  // 新しい風にする（風なしのときは無風）
  newWind(seed) {
    this.wind = this.windEnabled ? randomWind(seed) : CALM;
    this.o.onWind?.(this.wind);
    return this.wind;
  }

  // 決めておいた風にする（準備画面で見せた風）
  setWind(w) {
    this.wind = this.windEnabled ? w : CALM;
    this.o.onWind?.(this.wind);
  }

  setWindEnabled(on) {
    this.windEnabled = on;
    if (this.phase === 'ready' || this.phase === 'landed') this.newWind();
  }

  updateWind(dt) {
    this.clock += dt;
    // 飛んでいる間は、飛行計算と同じ時刻の風
    const t = this.phase === 'flying' || this.phase === 'landed' ? this.flightT : this.clock;
    const v = windVector(this.wind, t);
    const sp = Math.hypot(v[0], v[1]);
    // 吹き流し：風下を向き、弱い風ではだらりと下がる
    const droop = (Math.PI / 2) * (1 - Math.min(1, sp / 2.2)) * 0.9;
    this.sock.rotation.set(0, droop, sp > 0.02 ? Math.atan2(v[1], v[0]) : this.sock.rotation.z, 'ZYX');
    // 綿毛：カメラの見ている辺りの箱の中を流れる（はみ出したら反対側へ）
    const c = this.fluffCenter.lerp(this.camLook ?? this.fluffCenter, 0.05);
    const arr = this.fluff.geometry.attributes.position.array;
    const B = this.fluffBox;
    const wobble = Math.sin(this.clock * 1.3);
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] += (v[0] + 0.05 * Math.sin(this.clock + i)) * dt;
      arr[i + 1] += (v[1] + 0.05 * Math.cos(this.clock * 0.7 + i)) * dt;
      arr[i + 2] += 0.04 * wobble * Math.sin(i) * dt;
      const wrap = (k, half, center) => {
        const d = arr[i + k] - center;
        if (d > half) arr[i + k] -= half * 2; else if (d < -half) arr[i + k] += half * 2;
      };
      wrap(0, B.x / 2, c.x);
      wrap(1, B.y / 2, c.y);
      if (arr[i + 2] < 0.05) arr[i + 2] += B.z - 0.1; else if (arr[i + 2] > B.z) arr[i + 2] -= B.z - 0.1;
    }
    this.fluff.geometry.attributes.position.needsUpdate = true;
  }

  buildThrower() {
    const g = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0xf0c7a0, roughness: 0.8 });
    const shirt = new THREE.MeshStandardMaterial({ color: 0x3a6fb5, roughness: 0.8 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x3b3f4a, roughness: 0.9 });
    const add = (mesh, x, y, z) => { mesh.position.set(x, y, z); mesh.castShadow = true; g.add(mesh); return mesh; };
    const cyl = (r, h, mat) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 14), mat);
      m.rotation.x = Math.PI / 2; // 縦向き（z）に
      return m;
    };
    add(cyl(0.07, 0.85, pants), 0, 0.1, 0.425);
    add(cyl(0.07, 0.85, pants), 0, -0.1, 0.425);
    add(new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.4, 6, 14), shirt), 0, 0, 1.15).rotation.x = Math.PI / 2;
    add(new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 14), skin), 0, 0, 1.62);
    // 左腕（下ろしたまま）
    const la = add(cyl(0.045, 0.55, shirt), 0, 0.23, 1.12);
    la.rotation.y = 0.15;
    // 右腕：肩を中心に回す
    const shoulder = new THREE.Group();
    shoulder.position.set(0, -0.23, 1.38);
    const arm = cyl(0.045, 0.58, shirt);
    arm.position.set(0, 0, -0.29);
    arm.castShadow = true;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), skin);
    hand.position.set(0, 0, -0.6);
    shoulder.add(arm, hand);
    g.add(shoulder);
    this.shoulder = shoulder;
    this.handMesh = hand;
    this.thrower = g;
    this.scene.add(g);
  }

  buildPlane() {
    const { paperGeom, edgeGeom, frontMat, backMat } = this.o;
    this.planeOuter = new THREE.Group();
    this.planeInner = new THREE.Group();
    this.planeInner.matrixAutoUpdate = false;
    const f = new THREE.Mesh(paperGeom, frontMat);
    const b = new THREE.Mesh(paperGeom, backMat);
    f.castShadow = b.castShadow = true;
    const e = new THREE.LineSegments(edgeGeom, new THREE.LineBasicMaterial({ color: 0x3a2a20, transparent: true, opacity: 0.4 }));
    this.planeInner.add(f, b, e);
    this.planeOuter.add(this.planeInner);
    this.planeOuter.rotation.order = 'ZYX';
    this.scene.add(this.planeOuter);
  }

  // 折った紙飛行機を設定する（aero は analyzeAirplane の結果）
  setAirplane(aero, metersPerUnit) {
    this.aero = aero;
    this.metersPerUnit = metersPerUnit;
    const m = metersPerUnit;
    const { forward: f, right: r, up: u } = aero.axes;
    const cg = aero.cg.map((v) => v / m); // シミュレーターの単位に戻す
    // 機体座標（前 x・左 y・上 z）へ回して、実寸にする
    const R = new THREE.Matrix4().set(
      f[0], f[1], f[2], 0,
      -r[0], -r[1], -r[2], 0,
      u[0], u[1], u[2], 0,
      0, 0, 0, 1,
    );
    const M = new THREE.Matrix4().makeScale(m, m, m)
      .multiply(R)
      .multiply(new THREE.Matrix4().makeTranslation(-cg[0], -cg[1], -cg[2]));
    this.planeInner.matrix.copy(M);
    this.planeInner.matrixWorldNeedsUpdate = true;
    this.clearMarkers();
    this.reset();
  }

  // ベスト記録の線を引く（distance が null なら消す）
  setBest(distance, label = 'BEST') {
    const g = this.bestGroup;
    if (g.userData.label) { g.remove(g.userData.label); g.userData.label = null; }
    if (distance === null || distance === undefined) { g.visible = false; return; }
    const t = groundText(`${label} ${distance.toFixed(2)}m`, 0.32, '#ffc107');
    t.position.set(0.25, -2.9, 0);
    g.add(t);
    g.userData.label = t;
    g.position.set(distance, 0, 0);
    g.visible = true;
  }

  clearMarkers() {
    for (const mk of this.markers) this.markerGroup.remove(mk);
    this.markers = [];
  }

  // ---------------------------------------------------------------- 操作

  reset() {
    this.newWind();
    this.phase = 'ready';
    this.flight = null;
    this.flightT = 0;
    this.cursor = 0;
    this.power = null;
    this.swing = null;
    this.throwAnim = 0;
    this.resetCamera(true);
  }

  setAngle(deg) {
    const { minAngle, maxAngle } = THROW_LIMITS;
    this.angle = Math.max(minAngle, Math.min(maxAngle, Math.round(deg)));
  }

  setYaw(deg) {
    const { maxYaw } = THROW_LIMITS;
    this.yaw = Math.max(-maxYaw, Math.min(maxYaw, Math.round(deg)));
  }

  // スイングメーターのカーソルを、押した時刻 now [ms] から求める（画面の更新の速さに左右されない）
  cursorAt(now) {
    const sec = (now - this.phaseStart) / 1000;
    if (this.phase === 'power') return Math.min(1, sec / SWING.powerTime);
    if (this.phase === 'impact') return Math.max(SWING.min, this.power - sec * SWING.impactSpeed);
    return this.cursor;
  }

  // ボタンを押した（スイングメーターを進める）
  press(now = performance.now()) {
    if (this.phase === 'landed') { this.reset(); return; }
    if (!this.aero) return;
    if (this.phase === 'ready') {
      this.phase = 'power';
      this.phaseStart = now;
      this.cursor = 0;
    } else if (this.phase === 'power') {
      this.power = this.cursorAt(now);
      this.cursor = this.power;
      this.phase = 'impact';
      this.phaseStart = now;
    } else if (this.phase === 'impact') {
      this.cursor = this.cursorAt(now);
      this.throwNow(this.cursor);
    } else if (this.phase === 'flying' || this.phase === 'throwing') {
      this.skip();
    }
  }

  // タイミング timing（3 回目のカーソル。押さなかったら null）で投げる
  throwNow(timing) {
    const sw = swingResult(this.power, timing);
    this.swing = { ...sw, power: this.power, timing };
    const angle = this.angle + sw.angleErr;
    const yaw = this.yaw + sw.yawErr;
    this.flight = simulateThrow(this.aero, {
      speed: sw.speed, angle, yaw, bank: sw.bankErr, height: HAND.z,
    }, { wind: windField(this.wind) });
    Object.assign(this.flight, { speed: sw.speed, angle, yaw, swing: this.swing, wind: this.wind });
    this.phase = 'throwing';
    this.throwAnim = 0;
    this.o.onSwing?.(this.swing);
  }

  // 飛んでいる途中を飛ばして、着地させる
  skip() {
    if (this.phase === 'flying' || this.phase === 'throwing') {
      this.flightT = this.flight.time;
      this.phase = 'flying';
    }
  }

  setView(v) { this.view = v; }

  // ---------------------------------------------------------------- 毎フレーム

  update(dt) {
    dt = Math.min(dt, 0.1);
    // 腕の角度（肩まわり。0 で真下、正で前に振り上げる）
    let armAngle = 0.4;
    // カーソル 1（強さ 100%）で腕をいちばん後ろへ、0 で手を離す位置
    const armFor = (v) => RELEASE_ARM - (RELEASE_ARM + 1.8) * Math.max(0, Math.min(1, v));
    const now = performance.now();
    if (this.phase === 'power') {
      this.cursor = this.cursorAt(now);
      if (this.cursor >= 1) {
        // 押さないまま 100% に着いたら、強さ 100% で折り返す
        this.power = 1;
        this.phase = 'impact';
        this.phaseStart = now - ((now - this.phaseStart) / 1000 - SWING.powerTime) * 1000;
      }
      armAngle = armFor(this.cursor); // 振りかぶる
    } else if (this.phase === 'impact') {
      this.cursor = this.cursorAt(now);
      armAngle = armFor(this.cursor); // 前へ振る
      if (this.cursor <= SWING.min) { this.cursor = SWING.min; this.throwNow(null); }
    } else if (this.phase === 'throwing') {
      this.throwAnim += dt;
      const from = armFor(this.cursor);
      const k = Math.min(1, this.throwAnim / 0.08);
      armAngle = from + (RELEASE_ARM - from) * k;
      if (k >= 1) { this.phase = 'flying'; this.flightT = 0; }
    } else if (this.phase === 'flying' || this.phase === 'landed') {
      armAngle = 1.4;
    } else {
      armAngle = RELEASE_ARM; // 構え：腕を前に出して紙飛行機を持つ
    }
    // 肩の回転（y 軸まわり。正で腕が前へ）
    this.shoulder.rotation.y = -armAngle;
    // 腕を振り切った手の位置が、手を離す位置（HAND）にくるよう立たせる
    const yw = this.yaw * RAD;
    this.thrower.rotation.z = yw;
    this.thrower.position.set(
      HAND.x - (RELEASE_REACH * Math.cos(yw) + 0.23 * Math.sin(yw)),
      HAND.y - (RELEASE_REACH * Math.sin(yw) - 0.23 * Math.cos(yw)),
      0,
    );

    // 紙飛行機
    if (this.phase === 'flying') {
      this.flightT += dt;
      if (this.flightT >= this.flight.time) {
        this.flightT = this.flight.time;
        this.phase = 'landed';
        this.placeMarker(this.flight);
        this.o.onLanded?.(this.flight);
      }
    }
    let pose;
    if ((this.phase === 'flying' || this.phase === 'landed') && this.flight) {
      pose = samplePath(this.flight.path, this.flightT);
    } else {
      // 手に持っている
      this.handMesh.updateWorldMatrix(true, false);
      const hp = new THREE.Vector3().setFromMatrixPosition(this.handMesh.matrixWorld);
      const yaw = this.yaw * RAD;
      // 手の少し前に機体の重心
      hp.x += Math.cos(yaw) * 0.04;
      hp.y += Math.sin(yaw) * 0.04;
      pose = { pos: [hp.x, hp.y, hp.z], theta: this.angle * RAD, phi: 0, psi: yaw };
    }
    this.updateTrail();
    if (pose) {
      this.planeOuter.position.set(...pose.pos);
      // ヨー（z）→ ピッチ（機首上げは y 軸まわりに負）→ バンク（右が下がるのは x 軸まわりに正）
      this.planeOuter.rotation.set(pose.phi, -pose.theta, pose.psi);
      this.pose = pose;
    }
    this.updateCamera(dt);
    this.updateWind(dt);
    // 影を紙飛行機の近くに落とす
    const p = this.planeOuter.position;
    this.sun.position.set(p.x - 3, p.y - 4, 10);
    this.sun.target.position.set(p.x, p.y, 0);

    this.o.onUpdate?.({
      phase: this.phase,
      cursor: this.cursor,
      power: this.power,
      swing: this.swing,
      angle: this.angle,
      yaw: this.yaw,
      distance: pose ? Math.hypot(pose.pos[0], pose.pos[1]) : 0,
      height: pose ? pose.pos[2] : 0,
      t: this.flightT,
      flight: this.flight,
    });
  }

  updateTrail() {
    const pts = [];
    if (this.flight && (this.phase === 'flying' || this.phase === 'landed')) {
      for (const p of this.flight.path) {
        if (p.t > this.flightT) break;
        pts.push(...p.pos);
      }
      const cur = samplePath(this.flight.path, this.flightT);
      pts.push(...cur.pos);
    }
    this.trailGeom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  }

  placeMarker(flight) {
    const [x, y] = flight.landing;
    const g = new THREE.Group();
    const pin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006, 0.006, 0.3, 8),
      new THREE.MeshStandardMaterial({ color: 0x6b5a4e }),
    );
    pin.rotation.x = Math.PI / 2;
    pin.position.z = 0.15;
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(0.12, 0.08),
      new THREE.MeshStandardMaterial({ color: 0xc8402f, side: THREE.DoubleSide }),
    );
    flag.rotation.x = Math.PI / 2;
    flag.position.set(0.06, 0, 0.26);
    const label = textSprite(`${flight.distance.toFixed(2)} m`, { size: 0.07, color: '#ffffff', bg: 'rgba(43,38,34,.82)' });
    label.position.z = 0.36;
    g.add(pin, flag, label);
    g.position.set(x, y, 0);
    this.markerGroup.add(g);
    // 前の目印は文字を小さく薄く
    for (const mk of this.markers) {
      const l = mk.children[2];
      l.material.opacity = 0.55;
      l.scale.multiplyScalar(0.75);
    }
    this.markers.push(g);
  }

  // ---------------------------------------------------------------- カメラ

  resetCamera(snap) {
    const yaw = this.yaw * RAD;
    // 投げる人の右うしろ、少し高い所から、コースの先を見る
    const back = 3.0, side = 1.5;
    const pos = new THREE.Vector3(-back * Math.cos(yaw) + side * Math.sin(yaw), -back * Math.sin(yaw) - side * Math.cos(yaw), 2.2);
    const look = new THREE.Vector3(5 * Math.cos(yaw), 5 * Math.sin(yaw), 0.9);
    if (snap) {
      this.camera.position.copy(pos);
      this.camLook = look.clone();
      this.camera.lookAt(look);
    }
    return { pos, look };
  }

  // メインメニューの背景：コースの上をゆっくり回るカメラ（紙飛行機は出さない）
  setAttract(on) {
    this.attract = on;
    this.planeOuter.visible = !on;
    this.trail.visible = !on;
    this.markerGroup.visible = !on;
  }

  // コースに出たときの演出：空の高い所から、投げる人の後ろへ降りてくる
  playIntro() {
    this.camera.position.set(22, -16, 16);
    this.camLook = new THREE.Vector3(12, 0, 0);
    this.camera.lookAt(this.camLook);
    this.introT = 0;
  }

  updateCamera(dt) {
    let goal;
    if (this.attract) {
      const a = this.clock * 0.08;
      goal = {
        pos: new THREE.Vector3(14 + Math.cos(a) * 16, Math.sin(a) * 16, 5 + Math.sin(a * 0.7) * 1.5),
        look: new THREE.Vector3(14, 0, 0.5),
      };
      this.camera.position.copy(goal.pos);
      this.camLook = goal.look;
      this.camera.lookAt(goal.look);
      return;
    }
    if (this.introT !== undefined && this.introT < 2.5) this.introT += dt;
    if (['ready', 'power', 'impact', 'throwing'].includes(this.phase)) {
      goal = this.resetCamera(false);
    } else {
      const p = this.planeOuter.position;
      if (this.view === 'side') {
        goal = {
          pos: new THREE.Vector3(p.x - 0.3, p.y - 2.4, Math.max(0.5, p.z + 0.35)),
          look: new THREE.Vector3(p.x + 0.3, p.y, p.z),
        };
      } else {
        const psi = this.pose?.psi ?? 0;
        const landed = this.phase === 'landed';
        const back = landed ? 1.4 : 0.9;
        const side = landed ? 0.8 : 0.25;
        goal = {
          pos: new THREE.Vector3(p.x - back * Math.cos(psi) + side * Math.sin(psi), p.y - back * Math.sin(psi) - side * Math.cos(psi), Math.max(0.3, p.z + (landed ? 0.7 : 0.28))),
          look: new THREE.Vector3(p.x + 0.4 * Math.cos(psi), p.y + 0.4 * Math.sin(psi), p.z),
        };
      }
    }
    // 演出中はゆっくり、そのあとは速く追う
    const intro = this.introT !== undefined && this.introT < 2.5;
    const k = 1 - Math.exp(-dt * (this.phase === 'flying' ? 7 : intro ? 1.8 : 3));
    this.camera.position.lerp(goal.pos, k);
    this.camLook = (this.camLook ?? goal.look.clone()).lerp(goal.look, k);
    this.camera.lookAt(this.camLook);
  }

  resize(w, h) {
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
