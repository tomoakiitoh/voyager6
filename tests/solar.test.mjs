/**
 * 太陽・月・惑星の位置を JPL Horizons の値と突き合わせる。
 *
 *   node --test tests/solar.test.mjs
 *
 * 基準値: JPL Horizons (ssd.jpl.nasa.gov/api/horizons.api)
 *   観測地  東京 (139.77°E, 35.68°N, 標高0m)
 *   時刻    2026-07-13 12:00 UT (= 21:00 JST)
 *   量      見かけの赤道座標 (QUANTITIES=2) と 方位・高度 (QUANTITIES=4, 大気差なし)
 * 許容誤差は PLAN.md 3章の精度目標 (惑星 < 0.5°、月 < 0.5°) に合わせた。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const astro = readFileSync(path.join(ROOT, "src", "astro.js"), "utf8");
const A = new Function(
  `${astro}\nreturn {julianDay, eqToHorizon, sunPosition, moonPosition,
   moonTopocentric, planetPosition, moonPhase, norm360,
   heliocentric, schlyterDay, PLANET_ELEMENTS};`
)();

const LAT = 35.68, LON = 139.77;
const JD = A.julianDay(2026, 7, 13, 12); // 2026-07-13 12:00 UT

/** 時分秒 → 度 / 度分秒 → 度。 */
const hms = (h, m, s) => (h + m / 60 + s / 3600) * 15;
const dms = (d, m, s) => Math.sign(d || 1) * (Math.abs(d) + m / 60 + s / 3600);

// Horizons の出力 (見かけ RA/Dec, 方位/高度)
const REF = {
  Sun:     { ra: hms(7, 31, 19.84),  dec: dms(21, 46, 39.1), az: 318.823210, alt: -20.304746 },
  Moon:    { ra: hms(6, 35, 42.38),  dec: dms(26, 23, 16.9), az: 333.117156, alt: -22.619612 },
  Mercury: { ra: hms(7, 25, 17.51),  dec: dms(17, 4, 9.9),   az: 317.141151, alt: -24.972043 },
  Venus:   { ra: hms(10, 26, 8.85),  dec: dms(11, 8, 54.6),  az: 281.734759, alt: 2.785430 },
  Mars:    { ra: hms(4, 35, 5.71),   dec: dms(21, 51, 15.1), az: 2.619287,   alt: -32.421584 },
  Jupiter: { ra: hms(8, 21, 5.20),   dec: dms(19, 57, 21.2), az: 308.167218, alt: -14.386947 },
  Saturn:  { ra: hms(0, 57, 32.49),  dec: dms(3, 30, 11.4),  az: 66.176182,  alt: -24.120524 },
};

/** 2 つの赤道座標の離角 [度]。 */
function sep(ra1, dec1, ra2, dec2) {
  const D = Math.PI / 180;
  const c = Math.sin(dec1 * D) * Math.sin(dec2 * D)
    + Math.cos(dec1 * D) * Math.cos(dec2 * D) * Math.cos((ra1 - ra2) * D);
  return Math.acos(Math.max(-1, Math.min(1, c))) / D;
}

/** 天体を地平座標に落とす (太陽系天体は日付の分点なので歳差は掛けない)。 */
const horizon = (o) => A.eqToHorizon(o.ra, o.dec, JD, LAT, LON, false);

function check(name, obj, tolDeg) {
  const ref = REF[name];
  const d = sep(obj.ra, obj.dec, ref.ra, ref.dec);
  assert.ok(d < tolDeg, `${name}: 赤道座標が ${d.toFixed(3)}° ずれている (許容 ${tolDeg}°)`);

  const h = horizon(obj);
  const dAlt = Math.abs(h.alt - ref.alt);
  const dAz = Math.abs(((h.az - ref.az + 540) % 360) - 180)
    * Math.cos(ref.alt * Math.PI / 180); // 方位のずれは高度で縮む
  assert.ok(dAlt < tolDeg, `${name}: 高度が ${dAlt.toFixed(3)}° ずれている`);
  assert.ok(dAz < tolDeg, `${name}: 方位が ${dAz.toFixed(3)}° ずれている`);
}

test("太陽: Horizons と 0.3° 以内", () => {
  check("Sun", A.sunPosition(JD), 0.3);
});

test("月: 地平視差を補正して Horizons と 0.5° 以内", () => {
  const moon = A.moonTopocentric(A.moonPosition(JD), JD, LAT, LON);
  check("Moon", moon, 0.5);
});

test("月: 視差補正を省くと 0.5° を超える (補正が効いている)", () => {
  const geo = A.moonPosition(JD);
  const topo = A.moonTopocentric(geo, JD, LAT, LON);
  const d = sep(geo.ra, geo.dec, topo.ra, topo.dec);
  assert.ok(d > 0.5, `視差補正の効果が小さすぎる: ${d.toFixed(3)}°`);
  assert.ok(d < 1.2, `視差補正が大きすぎる: ${d.toFixed(3)}°`);
});

for (const name of ["Mercury", "Venus", "Mars", "Jupiter", "Saturn"]) {
  test(`${name}: Horizons と 0.5° 以内`, () => {
    check(name, A.planetPosition(name, JD), 0.5);
  });
}

test("惑星の等級がそれらしい値になる", () => {
  const venus = A.planetPosition("Venus", JD);
  const jupiter = A.planetPosition("Jupiter", JD);
  const mars = A.planetPosition("Mars", JD);
  assert.ok(venus.mag < -3.5 && venus.mag > -4.9, `金星 ${venus.mag}`);
  assert.ok(jupiter.mag < -1.5 && jupiter.mag > -2.6, `木星 ${jupiter.mag}`);
  assert.ok(mars.mag > 0.5 && mars.mag < 2.0, `火星 ${mars.mag}`);
});

// ---- 太陽系3D: 回転座標系 (木星固定) ----
// solar.html は orbitingGroup.rotation.y = -atan2(hj.y, hj.x) でグループごと逆回転させる。
// three 座標は toV(h)=(h.x, h.z, -h.y) なので木星の水平面方位角は φ=atan2(-h.y, h.x)。
// rotation.y=θ は方位角を φ-θ に変えるため、θ=-atan2(h.y,h.x)=φ を入れると φ-θ=0 で常に固定。
// ここでは astro.js 側だけで完結する不変量 (回転後の木星方位角が時刻に依らない) を確かめる。
test("回転座標系: 木星の方位角が時刻に依らず一定になる", () => {
  const jupAngle = (jd) => {
    const h = A.heliocentric(A.PLANET_ELEMENTS.Jupiter(A.schlyterDay(jd)));
    const phi = Math.atan2(-h.y, h.x);          // toV 適用後の方位角
    const theta = -Math.atan2(h.y, h.x);        // solar.html の rotation.y
    return Math.atan2(Math.sin(phi - theta), Math.cos(phi - theta)); // 正規化した回転後角
  };
  const base = jupAngle(A.julianDay(2000, 1, 1, 12));
  // 木星は約11.9年周期。半周期ぶん (6年) 進めても方位角が動かないことを見る。
  for (const dj of [365, 365 * 3, 365 * 6, 365 * 11]) {
    const a = jupAngle(A.julianDay(2000, 1, 1, 12) + dj);
    const diff = Math.abs(Math.atan2(Math.sin(a - base), Math.cos(a - base)));
    assert.ok(diff < 1e-9, `+${dj}日で木星の方位角が ${(diff * 180 / Math.PI).toFixed(4)}° 動いた`);
  }
});

test("非回転系なら木星は半周期で反対側へ回る (回転補正が効いている確認)", () => {
  const jd0 = A.julianDay(2000, 1, 1, 12);
  const raw = (jd) => {
    const h = A.heliocentric(A.PLANET_ELEMENTS.Jupiter(A.schlyterDay(jd)));
    return Math.atan2(-h.y, h.x);
  };
  const a0 = raw(jd0), a1 = raw(jd0 + 365.25 * 5.93); // 約半周期
  const diff = Math.abs(Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0)));
  assert.ok(diff > Math.PI * 0.8, `半周期で方位角が ${(diff * 180 / Math.PI).toFixed(1)}° しか動いていない`);
});

test("月相: 2026-07-14 ごろが新月 (前後で輝面比が底を打つ)", () => {
  const at = (dj) => A.moonPhase(A.moonPosition(JD + dj));
  const before = at(-2);  // 07-11
  const now = at(0);      // 07-13 新月の直前
  const after = at(+4);   // 07-17 新月を過ぎて太くなる
  assert.ok(now.illum < 0.05, `新月直前の輝面比 ${now.illum.toFixed(3)}`);
  assert.ok(before.illum > now.illum, "新月に向かって細くなる");
  assert.ok(after.illum > now.illum, "新月を過ぎたら太くなる");
  assert.ok(now.elong < 20, `新月直前の離角 ${now.elong.toFixed(1)}°`);
});

test("満月・新月で輝面比が 1 / 0 に近づく", () => {
  // 2026-08-28 前後が満月 (離角180°) — 離角と輝面比の整合を確認する
  let best = { illum: -1 }, worst = { illum: 2 };
  for (let k = 0; k < 40; k++) {
    const jd = A.julianDay(2026, 7, 20) + k;
    const p = A.moonPhase(A.moonPosition(jd));
    if (p.illum > best.illum) best = p;
    if (p.illum < worst.illum) worst = p;
  }
  assert.ok(best.illum > 0.97, `満月の輝面比 ${best.illum.toFixed(3)}`);
  assert.ok(best.elong > 170, `満月の離角 ${best.elong.toFixed(1)}°`);
  assert.ok(worst.illum < 0.03, `新月の輝面比 ${worst.illum.toFixed(3)}`);
  assert.ok(worst.elong < 10, `新月の離角 ${worst.elong.toFixed(1)}°`);
});
