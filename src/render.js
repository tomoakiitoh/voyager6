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
