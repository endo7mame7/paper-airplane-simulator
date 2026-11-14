// 飛距離の記録とランキング（描画ライブラリに依存しない純粋なロジック）
//
// ブラウザの localStorage に保存する（このブラウザだけの記録。サーバーには送らない）。
//   ranking: 飛距離の長い順。上位 RANK_SIZE 件だけ、その紙飛行機の折り方（state）も保存して、あとで呼び出せる
//   history: 新しい順の投げた記録（折り方は保存しない）
//   name:    プレイヤーの名前（最後に使ったもの）

export const RANK_SIZE = 10;
export const HISTORY_SIZE = 100;
export const STORAGE_KEY = 'paper-airplane-simulator/records/v1';

// 折り方から、紙飛行機を見分ける短い ID を作る（同じ折り方・同じ開き具合なら同じ ID）
export function planeId(state) {
  const r = (v) => Math.round(v * 1000) / 1000;
  const sig = JSON.stringify({
    w: r(state.width), h: r(state.height),
    s: state.steps.map((s) => [s.kind, s.type, s.mode ?? '', r(s.p?.x ?? s.c?.x ?? 0), r(s.p?.y ?? s.c?.y ?? 0),
      r(s.d?.x ?? 0), r(s.d?.y ?? 0), Math.round(s.angle)]),
  });
  // FNV-1a（32 bit）
  let h = 0x811c9dc5;
  for (let i = 0; i < sig.length; i++) {
    h ^= sig.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function emptyData() {
  return { ranking: [], history: [], name: '', throws: 0 };
}

// localStorage が使えない環境（プライベートモードなど）でも動くよう、メモリに置き換える
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

export class Records {
  constructor(storage, key = STORAGE_KEY) {
    try {
      this.storage = storage ?? globalThis.localStorage ?? memoryStorage();
      this.storage.getItem(key);
    } catch {
      this.storage = memoryStorage();
    }
    this.key = key;
    this.data = this.load();
  }

  load() {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return emptyData();
      const d = JSON.parse(raw);
      return { ...emptyData(), ...d };
    } catch {
      return emptyData();
    }
  }

  save() {
    try {
      this.storage.setItem(this.key, JSON.stringify(this.data));
      return true;
    } catch {
      // 容量がいっぱいなど：折り方を消してでも記録は残す
      try {
        const slim = { ...this.data, ranking: this.data.ranking.map(({ state, ...r }) => r) };
        this.storage.setItem(this.key, JSON.stringify(slim));
      } catch { /* あきらめる */ }
      return false;
    }
  }

  get name() { return this.data.name; }
  set name(v) { this.data.name = String(v ?? '').slice(0, 16); this.save(); }

  get ranking() { return this.data.ranking; }
  get history() { return this.data.history; }
  get throws() { return this.data.throws; }
  get best() { return this.data.ranking[0] ?? null; }

  // その紙飛行機の、これまでの一番の記録
  bestFor(id) {
    let best = null;
    for (const r of [...this.data.ranking, ...this.data.history]) {
      if (r.plane === id && (!best || r.distance > best.distance)) best = r;
    }
    return best;
  }

  /**
   * 1 投の記録を追加する
   * @param {object} e { distance, lateral, time, speed, angle, grade, power, plane, planeName, state, paper }
   *   state / paper（紙の形と色）はランキングに入ったときだけ保存する
   * @returns {{ record, rank, isBest, isPlaneBest, prevBest }} rank はランキングの順位（入らなかったら null）
   */
  add(e) {
    const prevBest = this.best;
    const prevPlaneBest = e.plane ? this.bestFor(e.plane) : null;
    this.data.throws += 1;
    const record = {
      id: `${Date.now().toString(36)}-${this.data.throws}`,
      date: new Date().toISOString(),
      name: e.name ?? this.data.name ?? '',
      distance: Math.round(e.distance * 100) / 100,
      lateral: Math.round((e.lateral ?? 0) * 100) / 100,
      time: Math.round((e.time ?? 0) * 100) / 100,
      speed: Math.round((e.speed ?? 0) * 10) / 10,
      angle: Math.round(e.angle ?? 0),
      grade: e.grade ?? null,
      power: e.power ?? null,
      plane: e.plane ?? null,
      planeName: e.planeName ?? '',
      wind: e.wind ?? null,
    };
    this.data.history.unshift(record);
    this.data.history.length = Math.min(this.data.history.length, HISTORY_SIZE);

    // ランキング（同じ距離なら先に出した方が上）
    const list = this.data.ranking;
    let rank = list.findIndex((r) => record.distance > r.distance);
    if (rank < 0) rank = list.length;
    if (rank < RANK_SIZE) {
      list.splice(rank, 0, { ...record, state: e.state ?? null, paper: e.paper ?? null });
      list.length = Math.min(list.length, RANK_SIZE);
    } else {
      rank = null;
    }
    this.save();
    return {
      record,
      rank: rank === null ? null : rank + 1,
      isBest: !prevBest || record.distance > prevBest.distance,
      isPlaneBest: !prevPlaneBest || record.distance > prevPlaneBest.distance,
      prevBest,
    };
  }

  // 記録の名前を変える（投げたあとに名前を入れたとき）
  rename(id, name) {
    const n = String(name ?? '').slice(0, 16);
    for (const r of [...this.data.ranking, ...this.data.history]) if (r.id === id) r.name = n;
    this.save();
  }

  clear() {
    const name = this.data.name;
    this.data = { ...emptyData(), name };
    this.save();
  }
}
