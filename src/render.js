"use strict";

/**
 * 正距方位図法。天頂が中心・地平線 (高度0°) が外周の真円。
 * 見上げた空なので地図とは鏡像になる: 北を上にすると東は「左」。
 *   画面x = cx − r sin(az),  画面y = cy − r cos(az)
 * 高度成分を使えば三角関数なしで同じことができる (e が東、n が北)。
 */
function project(h, cx, cy, R) {
  const alt = Math.asin(Math.max(-1, Math.min(1, h.u))) * RAD;
  const r = R * (90 - alt) / 90;
  const horiz = Math.hypot(h.e, h.n);
  if (horiz < 1e-9) return { x: cx, y: cy, alt, r }; // 天頂・天底
  return {
    x: cx - r * (h.e / horiz),   // 東は左
    y: cy - r * (h.n / horiz),   // 北は上
    alt, r,
  };
}

// ---------------- 一般化投影 (ズーム・パン・反転) ----------------
// project() は天頂中心・全天固定の正距方位図法。望遠鏡モード (F1) では視野中心を
// 任意方向へ移し、倍率を上げ、鏡像・倒立に切り替えたい。projectView() はその一般形で、
// 既定ビュー (天頂中心・正立・pxPerDeg = R/90) では project() と画素まで一致する。

const ZENITH = [0, 0, 1]; // 地平成分 e,n,u での天頂方向
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
function norm3(a) {
  const l = len3(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

// 反転モード → 画面オフセットの符号 [横, 縦]。
// 正立=そのまま (東が左・北が上)、鏡像=左右反転 (天頂ミラー)、倒立=180°回転 (ニュートン)。
const FLIP = { upright: [1, 1], mirror: [-1, 1], inverted: [-1, -1] };

/**
 * 視野中心 c における画面のタンジェント基底を作る。
 *   upRef … 「画面の上」に置きたい基準方向 (地平成分の配列)。全天図は天頂、
 *           望遠鏡モードは天の北極を渡す。中心が動いても基準が同じなのでパンで回転しない。
 *   roll  … さらに視野中心まわりに回す角 [ラジアン] (回転モード用)。
 *   right … c × up。天頂中心・天頂基準では西 (−東) になり「東が左」を再現する。
 */
function viewBasis(c, upRef, roll) {
  const cv = [c.e, c.n, c.u];
  const ur = upRef || ZENITH;
  const d = dot3(ur, cv);
  let up = [ur[0] - cv[0] * d, ur[1] - cv[1] * d, ur[2] - cv[2] * d];
  if (len3(up) < 1e-6) up = [0, 1, 0];               // 基準が中心と重なる (極を向く) → 北で代用
  if (len3(cross3(cv, up)) < 1e-9) up = [1, 0, 0];   // それも平行なら東
  up = norm3(up);
  let right = cross3(cv, up);
  if (roll) {                                        // 視野中心を軸に回す
    const cs = Math.cos(roll), sn = Math.sin(roll);
    const u2 = [up[0] * cs - right[0] * sn, up[1] * cs - right[1] * sn, up[2] * cs - right[2] * sn];
    right = [up[0] * sn + right[0] * cs, up[1] * sn + right[1] * cs, up[2] * sn + right[2] * cs];
    up = u2;
  }
  return { c: cv, up, right };
}

/**
 * ビュー記述子を作る。draw 側はこれ一つを持ち回り、全描画関数に渡す。
 *   cx, cy    … 画面中心 [px]
 *   center    … 視野中心が向く地平方向 {e,n,u} (既定は天頂)
 *   pxPerDeg  … 中心での拡大率 [px/度]。全天図では R/90
 *   flip      … 'upright' | 'mirror' | 'inverted'
 */
function makeView(cx, cy, opts = {}) {
  const center = opts.center || { e: 0, n: 0, u: 1 };
  const upRef = opts.upRef ? [opts.upRef.e, opts.upRef.n, opts.upRef.u] : ZENITH;
  const roll = opts.roll || 0;
  return {
    cx, cy, center,
    pxPerDeg: opts.pxPerDeg,
    flip: opts.flip || "upright",
    roll,
    basis: viewBasis(center, upRef, roll),
  };
}

/**
 * 地平成分 h をビューに従って画面座標へ投影する (正距方位図法)。
 * 返り値: x, y, theta(中心からの角距離[度]), behind(中心の裏側=視野外)。
 */
function projectView(h, view) {
  const p = [h.e, h.n, h.u];
  const { c, up, right } = view.basis;
  const cd = Math.max(-1, Math.min(1, dot3(c, p)));
  const theta = Math.acos(cd) * RAD;      // 中心からの角距離 [度]
  const tx = dot3(p, right);              // 接平面の右成分
  const ty = dot3(p, up);                 // 接平面の上成分
  const tlen = Math.hypot(tx, ty);
  const r = view.pxPerDeg * theta;
  let ox = 0, oy = 0;
  if (tlen > 1e-12) { ox = r * (tx / tlen); oy = r * (ty / tlen); }
  const [sx, sy] = FLIP[view.flip] || FLIP.upright;
  return {
    x: view.cx + sx * ox,
    y: view.cy - sy * oy, // 画面の y は下向き
    theta,
    behind: cd < 0,
  };
}

/**
 * projectView の逆。画面座標 → 地平方向の単位ベクトル {e,n,u}。
 * ズームやパンで「カーソル下の空」を掴んで動かすのに使う。
 */
function unprojectView(x, y, view) {
  const [sx, sy] = FLIP[view.flip] || FLIP.upright;
  const ox = (x - view.cx) / sx;
  const oy = -(y - view.cy) / sy;
  const r = Math.hypot(ox, oy);
  const { c, up, right } = view.basis;
  if (r < 1e-9) return { e: c[0], n: c[1], u: c[2] };
  const theta = (r / view.pxPerDeg) * DEG; // ラジアン
  const tx = ox / r, ty = oy / r;
  const T = [
    tx * right[0] + ty * up[0],
    tx * right[1] + ty * up[1],
    tx * right[2] + ty * up[2],
  ];
  const ct = Math.cos(theta), st = Math.sin(theta);
  return {
    e: ct * c[0] + st * T[0],
    n: ct * c[1] + st * T[1],
    u: ct * c[2] + st * T[2],
  };
}

/**
 * 単位ベクトル a を b に重ねる回転を v に適用する (Rodrigues の公式)。
 * パン/ズームで「掴んだ空の点」をカーソルに追従させる再センタリングに使う。
 */
function rotateAToB(v, a, b) {
  const av = [a.e, a.n, a.u], bv = [b.e, b.n, b.u], vv = [v.e, v.n, v.u];
  const cosA = Math.max(-1, Math.min(1, dot3(av, bv)));
  let axis = cross3(av, bv);
  if (len3(axis) < 1e-12) {
    if (cosA > 0) return { e: v.e, n: v.n, u: v.u };         // 同方向: 無回転
    axis = Math.abs(av[0]) < 0.9 ? cross3(av, [1, 0, 0]) : cross3(av, [0, 1, 0]);
  }
  const k = norm3(axis);
  const ang = Math.acos(cosA), c = Math.cos(ang), s = Math.sin(ang);
  const kv = cross3(k, vv), kd = dot3(k, vv);
  const r = norm3([
    vv[0] * c + kv[0] * s + k[0] * kd * (1 - c),
    vv[1] * c + kv[1] * s + k[1] * kd * (1 - c),
    vv[2] * c + kv[2] * s + k[2] * kd * (1 - c),
  ]);
  return { e: r[0], n: r[1], u: r[2] };
}

/** B−V 色指数 → 星の色 (青白〜オレンジ)。彩度は控えめにする。 */
function bvColor(bv) {
  const t = Math.max(-0.3, Math.min(1.8, bv));
  let r, g, b;
  if (t < 0.0) { r = 0.72 + t * 0.15; g = 0.82; b = 1.0; }
  else if (t < 0.6) { r = 0.72 + t * 0.42; g = 0.82 + t * 0.22; b = 1.0 - t * 0.15; }
  else if (t < 1.2) { r = 1.0; g = 0.95 - (t - 0.6) * 0.22; b = 0.91 - (t - 0.6) * 0.35; }
  else { r = 1.0; g = 0.82 - (t - 1.2) * 0.18; b = 0.70 - (t - 1.2) * 0.28; }
  const to = (v) => Math.round(255 * Math.max(0, Math.min(1, v)));
  return `rgb(${to(r)},${to(g)},${to(b)})`;
}

/**
 * アイピースの倍率と実視界を求める。
 *   倍率     = 望遠鏡の焦点距離 / アイピースの焦点距離
 *   実視界°  = アイピースの見かけ視界° / 倍率
 * (簡略式。厳密には見かけ視界に tan 補正が要るが、観望の目安としてはこれで十分。)
 */
function eyepieceFov(scopeFL, epFL, apparentFov) {
  const mag = scopeFL / epFL;
  return { mag, trueFov: apparentFov / mag };
}

/** 等級 → 描画半径 [px]。R は盤面半径 (画面の大きさに合わせて少しスケールする)。 */
function starRadius(mag, R) {
  const s = R / 320;
  return Math.max(0.55, (4.6 - 0.78 * mag) * s);
}

/**
 * 地平線をまたぐ線分を、地平線 (u=0) のところで切る。
 * 地平成分は元のベクトルの線形変換なので、u は弦の上で線形補間できる。
 * 返り値は「地平線上にある側の端点」の地平成分。
 */
function clipToHorizon(inside, outside) {
  const t = inside.u / (inside.u - outside.u); // u=0 になる内分比
  const e = inside.e + (outside.e - inside.e) * t;
  const n = inside.n + (outside.n - inside.n) * t;
  const len = Math.hypot(e, n) || 1;
  return { e: e / len, n: n / len, u: 0 }; // 単位ベクトルに戻す (高度0なので水平成分だけ)
}

/** #rrggbb を t で混ぜる。 */
function mixColor(c1, c2, t) {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.substr(i, 2), 16));
  const [a, b] = [p(c1), p(c2)];
  const v = a.map((x, i) => Math.round(x + (b[i] - x) * Math.max(0, Math.min(1, t))));
  return `rgb(${v[0]},${v[1]},${v[2]})`;
}

/**
 * 太陽高度から盤面の地色を決める (薄明)。
 * 天文薄明 (−18°) より下は夜の色、−6°〜0° で一気に明るくなる。
 */
function skyColor(sunAlt) {
  const NIGHT = "#0a1226", ASTRO_TW = "#0e1a35", NAUT_TW = "#16305c";
  const CIVIL_TW = "#2d5c96", DAY = "#4d84c4";
  if (sunAlt <= -18) return NIGHT;
  if (sunAlt <= -12) return mixColor(NIGHT, ASTRO_TW, (sunAlt + 18) / 6);
  if (sunAlt <= -6) return mixColor(ASTRO_TW, NAUT_TW, (sunAlt + 12) / 6);
  if (sunAlt <= 0) return mixColor(NAUT_TW, CIVIL_TW, (sunAlt + 6) / 6);
  return mixColor(CIVIL_TW, DAY, sunAlt / 10);
}

/**
 * 月を月齢どおりの欠け方で描く。
 * 明るい側は必ず太陽の方を向くので、画面上の太陽方向を角度で渡して回転させる。
 */
function drawMoon(x, y, r, illum, angleToSun) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angleToSun);

  // 影の側 (地球照ぶんだけ薄く見せる)
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(120,130,155,0.30)";
  ctx.fill();

  // 明るい側: 太陽を向いた半円 + 明暗境界の楕円
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
  ctx.ellipse(0, 0, Math.abs(2 * illum - 1) * r, r, 0,
    Math.PI / 2, -Math.PI / 2, illum < 0.5); // 三日月なら境界が太陽側に膨らむ
  ctx.closePath();
  ctx.fillStyle = "#f2efe2";
  ctx.fill();

  ctx.restore();
}

/**
 * 地平座標の多角形を地平線 (u >= 0) で切り取る (Sutherland-Hodgman)。
 * 地平線下の点は図法上は円の外に出るので、そのまま塗ると形が崩れる。
 */
function clipPolygon(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const aIn = a.u >= 0, bIn = b.u >= 0;
    if (aIn) out.push(a);
    if (aIn !== bIn) out.push(clipToHorizon(aIn ? a : b, aIn ? b : a));
  }
  return out;
}

/**
 * ラベルの重なり避け。追加できたら true。
 * 呼び出し側は「見せたい順」(明るい順・高い順) に呼ぶこと。
 */
function makeLabelPlacer(pad = 2) {
  const boxes = [];
  return function place(x, y, w, h) {
    const box = [x - pad, y - pad, x + w + pad, y + h + pad];
    for (const b of boxes) {
      if (box[0] < b[2] && b[0] < box[2] && box[1] < b[3] && b[1] < box[3]) return false;
    }
    boxes.push(box);
    return true;
  };
}
