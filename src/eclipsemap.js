"use strict";

/* ------------------------------------------------------------------
 * 食の地図 (日食の等食分線・皆既帯 / 月食の見える範囲)
 *
 * 目的は**「自分のところで見られるのか」に答えること**であって、観測計画の資料ではない。
 * 接触時刻・食分の数値・中心線の座標は出さない (それは国立天文台 暦計算室の領分)。
 * ここで描くのは「どのあたりで、どのくらい欠けるか」の**概略図**。
 *
 * 精度: 影の中心が NASA の「食の最大」から実測 35〜80km ずれる (ΔT・地球を球で扱っている
 * ぶん・太陽位置の残差)。世界地図の縮尺では1〜2画素なので図としては足りるが、
 * **皆既帯の縁でどちらに入るかの判断には使えない**。ページにそう明記すること。
 *
 * 食の知識は入っていない。各地点で「太陽が月にどれだけ隠されるか」(日食) と
 * 「月が地球の影のどこにいるか」(月食) を幾何で出しているだけ。
 * 依存: astro.js (moonPositionELP / sunPosition / jdTT / gmst / eclipticToEquatorial ほか)
 * ------------------------------------------------------------------ */

const EM_RE = 6371;              // 地球半径 [km] (球で近似。楕円体は使わない)
const EM_RS = 696000;            // 太陽半径 [km]
const EM_RM = 1737.4;            // 月半径 [km]
const EM_AU = 149597870.7;

/** 地心の太陽・月ベクトル [km] (ECI, 日付の分点)。位置は地球時で計算する。 */
function emBodies(jdUT) {
  const jd = jdTT(jdUT);
  const m = moonPositionELP(jd);
  const eqm = eclipticToEquatorial(m.lon, m.lat, schlyterDay(jd));
  const vm = raDecToVec(eqm.ra, eqm.dec);
  const s = sunPosition(jd);
  const vs = raDecToVec(s.ra, s.dec);
  const ds = s.r * EM_AU;
  return {
    M: [vm[0] * m.dist, vm[1] * m.dist, vm[2] * m.dist],
    S: [vs[0] * ds, vs[1] * ds, vs[2] * ds],
    gmstRad: gmst(jdUT) * Math.PI / 180,
  };
}

/** 経度緯度 [度] → ECI の地表点 [km]。 */
function emSurface(latDeg, lonDeg, gmstRad) {
  const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180 + gmstRad;
  const cl = Math.cos(la);
  return [EM_RE * cl * Math.cos(lo), EM_RE * cl * Math.sin(lo), EM_RE * Math.sin(la)];
}

const emDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const emLen = (a) => Math.sqrt(emDot(a, a));

/**
 * 地表の1点で太陽面がどれだけ隠れているか (0=食なし, 1=皆既)。
 * 2つの円板 (太陽・月) の重なり面積の比。太陽が地平線下なら 0 を返す。
 */
function emObscuration(P, M, S) {
  if (emDot(P, S) <= 0) return 0;                       // 太陽が地平線の下
  const tm = [M[0] - P[0], M[1] - P[1], M[2] - P[2]];
  const ts = [S[0] - P[0], S[1] - P[1], S[2] - P[2]];
  const dm = emLen(tm), ds = emLen(ts);
  const am = Math.asin(EM_RM / dm);                     // 月の視半径
  const as = Math.asin(EM_RS / ds);                     // 太陽の視半径
  const th = Math.acos(Math.max(-1, Math.min(1, emDot(tm, ts) / (dm * ds))));
  if (th >= as + am) return 0;
  if (th <= am - as) return 1;                          // 皆既
  if (th <= as - am) return (am * am) / (as * as);      // 金環 (最大でも 1 にならない)
  const d = th;
  const a1 = Math.acos(Math.max(-1, Math.min(1, (d * d + as * as - am * am) / (2 * d * as))));
  const a2 = Math.acos(Math.max(-1, Math.min(1, (d * d + am * am - as * as) / (2 * d * am))));
  const tri = 0.5 * Math.sqrt(Math.max(0,
    (-d + as + am) * (d + as - am) * (d - as + am) * (d + as + am)));
  return (as * as * a1 + am * am * a2 - tri) / (Math.PI * as * as);
}

/**
 * 日食: 緯度経度の格子で「その食のあいだの最大の食分(面積比)」を出す。
 * 「自分のところで何割欠けるか」に直接答える量で、天文年鑑の等食分線と同じ考え方。
 * @returns {{grid: Float32Array, nx, ny, path: Array, maxObs: number}}
 */
function solarEclipseGrid(jdMaxUT, opts = {}) {
  const step = opts.step || 1.0;   // 格子 [度]。粗いと縁が階段に見える
  const minutes = opts.minutes || 150;                  // 最大の前後 [分]
  const dt = opts.dt || 4;                              // 時間刻み [分]
  const nx = Math.round(360 / step), ny = Math.round(180 / step) + 1;
  const grid = new Float32Array(nx * ny);
  const path = [];                                      // 中心食線 [{lat,lon,total}]
  let maxObs = 0;
  // 地球固定系の地表点を一度だけ作る (経度0 = グリニッジ)
  const surf = new Float64Array(nx * ny * 3);
  for (let iy = 0; iy < ny; iy++) {
    const la = (90 - iy * step) * Math.PI / 180, cl = Math.cos(la), sl = Math.sin(la);
    for (let ix = 0; ix < nx; ix++) {
      const lo = (-180 + ix * step) * Math.PI / 180, k = (iy * nx + ix) * 3;
      surf[k] = EM_RE * cl * Math.cos(lo);
      surf[k + 1] = EM_RE * cl * Math.sin(lo);
      surf[k + 2] = EM_RE * sl;
    }
  }
  for (let t = -minutes; t <= minutes; t += dt) {
    const jd = jdMaxUT + t / 1440;
    const { M, S, gmstRad } = emBodies(jd);
    // 影の軸と地表の交点 (中心食線)
    const sd = [S[0] / emLen(S), S[1] / emLen(S), S[2] / emLen(S)];
    const b = emDot(M, sd), c = emDot(M, M) - EM_RE * EM_RE;
    const disc = b * b - c;
    if (disc > 0) {
      const k = b - Math.sqrt(disc);
      const P = [M[0] - sd[0] * k, M[1] - sd[1] * k, M[2] - sd[2] * k];
      const lat = Math.asin(P[2] / emLen(P)) * 180 / Math.PI;
      let lon = (Math.atan2(P[1], P[0]) - gmstRad) * 180 / Math.PI;
      lon = ((lon % 360) + 540) % 360 - 180;
      const tm = [M[0] - P[0], M[1] - P[1], M[2] - P[2]];
      const ts = [S[0] - P[0], S[1] - P[1], S[2] - P[2]];
      const am = Math.asin(EM_RM / emLen(tm)), as = Math.asin(EM_RS / emLen(ts));
      path.push({ lat, lon, total: am > as });
    }
    /* 格子を掃く。地表の点は自転で動くので、素直に書くと毎ステップ全点の三角関数を
       計算し直すことになり、実測3秒かかった。**太陽と月のほうを地球固定系へ回す**と
       地表の点は不変になり、一度作った配列を使い回せる (下の SURF)。 */
    const cg = Math.cos(-gmstRad), sg = Math.sin(-gmstRad);
    const Mf = [M[0] * cg - M[1] * sg, M[0] * sg + M[1] * cg, M[2]];
    const Sf = [S[0] * cg - S[1] * sg, S[0] * sg + S[1] * cg, S[2]];
    for (let i = 0, n = surf.length / 3; i < n; i++) {
      const P0 = surf[i * 3], P1 = surf[i * 3 + 1], P2 = surf[i * 3 + 2];
      if (P0 * Sf[0] + P1 * Sf[1] + P2 * Sf[2] <= 0) continue;   // 太陽が地平線下
      const o = emObscuration([P0, P1, P2], Mf, Sf);
      if (o > grid[i]) { grid[i] = o; if (o > maxObs) maxObs = o; }
    }
  }
  return { grid, nx, ny, step, path, maxObs };
}

/**
 * 月食: 「最大食のとき月が地平線より上か」の格子。月食は月が見えていれば
 * どこからでも同じように見えるので、可視域＝月が空にある範囲。
 */
function lunarEclipseGrid(jdMaxUT, opts = {}) {
  const step = opts.step || 1.0;
  const nx = Math.round(360 / step), ny = Math.round(180 / step) + 1;
  const grid = new Float32Array(nx * ny);
  const { M, gmstRad } = emBodies(jdMaxUT);
  const mh = [M[0] / emLen(M), M[1] / emLen(M), M[2] / emLen(M)];
  let sub = null;
  for (let iy = 0; iy < ny; iy++) {
    const lat = 90 - iy * step;
    for (let ix = 0; ix < nx; ix++) {
      const lon = -180 + ix * step;
      const P = emSurface(lat, lon, gmstRad);
      // 月の高度 (地平視差ぶんは無視できる大きさではないが、可視域の縁の話なので概略で足りる)
      const alt = Math.asin(emDot(P, mh) / EM_RE) * 180 / Math.PI;
      grid[iy * nx + ix] = alt > 0 ? Math.min(1, alt / 60) : 0;
    }
  }
  // 月直下点 (真上に月が見える場所)
  {
    const lat = Math.asin(mh[2]) * 180 / Math.PI;
    let lon = (Math.atan2(mh[1], mh[0]) - gmstRad) * 180 / Math.PI;
    lon = ((lon % 360) + 540) % 360 - 180;
    sub = { lat, lon };
  }
  return { grid, nx, ny, step, sub };
}

/** coastlines.bin を緯度経度の折れ線に復号する (地球周回3Dと同じファイル)。 */
function decodeCoastlines(buf) {
  const dv = new DataView(buf);
  let o = 0;
  const n = dv.getUint32(o, true); o += 4;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const m = dv.getUint16(o, true); o += 2;
    const pts = new Float32Array(m * 2);
    for (let k = 0; k < m; k++) {
      pts[k * 2] = (dv.getUint16(o, true) / 65535) * 360 - 180; o += 2;
      pts[k * 2 + 1] = (dv.getUint16(o, true) / 65535) * 180 - 90; o += 2;
    }
    lines.push(pts);
  }
  return lines;
}

/* ---- 描画 (正距円筒。緯度経度をそのまま置く) ---- */

/** 等食分の塗り分け。天文年鑑の等食分線と同じ考えで、帯で示す。 */
const EM_BANDS = [
  { v: 0.20, c: "rgba(90,130,200,0.16)" },
  { v: 0.40, c: "rgba(90,130,200,0.26)" },
  { v: 0.60, c: "rgba(95,120,190,0.38)" },
  { v: 0.80, c: "rgba(80,100,175,0.52)" },
  { v: 0.95, c: "rgba(60,75,150,0.68)" },
];

/**
 * 食の地図を描く。
 * @param {HTMLCanvasElement} cv
 * @param {object} o  {kind:"solar"|"lunar", jdMaxUT, coast, label}
 */
function drawEclipseMap(cv, o) {
  const W = cv.width, H = cv.height;
  const g = cv.getContext("2d");
  const X = (lon) => (lon + 180) / 360 * W;
  const Y = (lat) => (90 - lat) / 180 * H;

  g.fillStyle = "#080d18"; g.fillRect(0, 0, W, H);

  const data = o.kind === "solar"
    ? solarEclipseGrid(o.jdMaxUT, o.opts) : lunarEclipseGrid(o.jdMaxUT, o.opts);
  const { grid, nx, ny, step } = data;

  // 食分 (または月の高度) の帯。格子のセルをそのまま塗る = 等値線を引かずに済む
  const cw = W / nx + 1, ch = H / (ny - 1) + 1;
  const bands = o.kind === "solar" ? EM_BANDS
    : [{ v: 0.001, c: "rgba(120,150,220,0.22)" }];      // 月食は「月が空にある範囲」だけ
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const v = grid[iy * nx + ix];
      if (v <= 0) continue;
      let col = null;
      for (const b of bands) if (v >= b.v) col = b.c;
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect(X(-180 + ix * step) - 0.5, Y(90 - iy * step) - ch / 2, cw, ch);
    }
  }

  // 海岸線
  if (o.coast) {
    g.strokeStyle = "rgba(150,175,215,0.75)"; g.lineWidth = 0.7;
    g.beginPath();
    for (const pts of o.coast) {
      let px = null;
      for (let k = 0; k < pts.length; k += 2) {
        const x = X(pts[k]), y = Y(pts[k + 1]);
        // 日付変更線をまたぐ線は切る (でないと地図を横断する線が引かれる)
        if (px !== null && Math.abs(x - px) > W / 2) { g.moveTo(x, y); } 
        else if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
        px = x;
      }
    }
    g.stroke();
  }

  // 赤道・経緯線
  g.strokeStyle = "rgba(120,140,180,0.18)"; g.lineWidth = 0.6;
  g.beginPath();
  for (let la = -60; la <= 60; la += 30) { g.moveTo(0, Y(la)); g.lineTo(W, Y(la)); }
  for (let lo = -120; lo <= 120; lo += 60) { g.moveTo(X(lo), 0); g.lineTo(X(lo), H); }
  g.stroke();

  if (o.kind === "solar") {
    // 中心食線。皆既/金環の帯そのものは幅が細く、世界地図では線で足りる
    g.strokeStyle = "#ff9a3c"; g.lineWidth = 2;
    g.beginPath();
    let px = null;
    for (const p of data.path) {
      const x = X(p.lon), y = Y(p.lat);
      if (px === null || Math.abs(x - px) > W / 2) g.moveTo(x, y); else g.lineTo(x, y);
      px = x;
    }
    g.stroke();
  } else if (data.sub) {
    // 月が真上に来る場所
    g.strokeStyle = "#ff9a3c"; g.lineWidth = 1.6;
    g.beginPath(); g.arc(X(data.sub.lon), Y(data.sub.lat), 5, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(X(data.sub.lon) - 9, Y(data.sub.lat));
    g.lineTo(X(data.sub.lon) + 9, Y(data.sub.lat));
    g.moveTo(X(data.sub.lon), Y(data.sub.lat) - 9);
    g.lineTo(X(data.sub.lon), Y(data.sub.lat) + 9); g.stroke();
  }
  return data;
}
