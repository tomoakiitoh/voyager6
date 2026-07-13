/**
 * 天文計算のユニットテスト。
 *
 *   node --test tests/*.mjs
 *
 * src/astro.js / src/render.js は配布物 (dist/) がそのまま読むファイルなので、
 * テスト対象と本番のコードがずれない。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = (name) => readFileSync(path.join(ROOT, "src", name), "utf8");

const EXPORTS = [
  "norm360", "julianDay", "jdFromDate", "gmst", "lst",
  "raDecToVec", "vecToRaDec", "precessionMatrix", "skyMatrix",
  "skyMatrixNoPrecession", "applySky", "horizonAngles", "eqToHorizon",
  "project", "bvColor", "starRadius",
];
const A = new Function(
  `${src("astro.js")}\n${src("render.js")}\nreturn {${EXPORTS.join(",")}};`
)();

/** 度分秒 → 度。 */
const dms = (d, m, s) => Math.sign(d || 1) * (Math.abs(d) + m / 60 + s / 3600);
/** 時分秒 → 度。 */
const hms = (h, m, s) => (h + m / 60 + s / 3600) * 15;

test("julianDay: 既知の日付", () => {
  assert.equal(A.julianDay(2000, 1, 1, 12), 2451545.0);       // J2000.0 元期
  assert.equal(A.julianDay(1987, 4, 10), 2446895.5);          // Meeus 例7.a
  assert.equal(A.julianDay(1987, 1, 27), 2446822.5);
  assert.equal(A.julianDay(1957, 10, 4, 19, 26, 24), 2436116.31); // スプートニク1号
  assert.equal(A.julianDay(2026, 7, 13, 12), 2461235.0);
});

test("jdFromDate: Date 経由でも同じ JD になる", () => {
  const jd = A.jdFromDate(new Date(Date.UTC(1987, 3, 10, 19, 21, 0)));
  assert.ok(Math.abs(jd - A.julianDay(1987, 4, 10, 19, 21, 0)) < 1e-9);
  // 2026-07-13 21:00 JST = 12:00 UT
  const jst = A.jdFromDate(new Date(Date.UTC(2026, 6, 13, 12, 0, 0)));
  assert.ok(Math.abs(jst - 2461235.0) < 1e-9);
});

test("gmst: Meeus 例12.a / 12.b と一致する", () => {
  // 1987-04-10 0h UT -> 13h10m46.3668s
  const g1 = A.gmst(2446895.5);
  assert.ok(Math.abs(g1 - hms(13, 10, 46.3668)) < 1e-5, `got ${g1}`);
  // 1987-04-10 19:21:00 UT -> 8h34m57.0896s
  const g2 = A.gmst(A.julianDay(1987, 4, 10, 19, 21, 0));
  assert.ok(Math.abs(g2 - hms(8, 34, 57.0896)) < 1e-4, `got ${g2}`);
});

test("lst: 恒星時は経度ぶんだけ進む", () => {
  const jd = 2446895.5;
  assert.ok(Math.abs(A.lst(jd, 139.77) - A.norm360(A.gmst(jd) + 139.77)) < 1e-9);
});

test("eqToHorizon: Meeus 例13.b (ワシントンでの金星)", () => {
  // 見かけの赤道座標 (分点は当日) なので歳差は掛けない
  const ra = hms(23, 9, 16.641);
  const dec = -dms(6, 43, 11.61);
  const H = 64.352133;                 // Meeus が求めた時角
  const lat = 38.921389;
  const lonDeg = -77.065556;           // 西経
  const jd = 2446896.30625;            // 1987-04-10 19:21 UT
  // その JD の地方恒星時から時角を作ると Meeus と一致するはず
  const hourAngle = A.norm360(A.lst(jd, lonDeg) - ra);
  assert.ok(Math.abs(hourAngle - H) < 0.001, `時角 ${hourAngle} != ${H}`);

  const { alt, az } = A.eqToHorizon(ra, dec, jd, lat, lonDeg, false);
  // Meeus: 方位角 A = 68.0337° (南から西回り), 高度 h = 15.1249°
  const azFromNorth = A.norm360(68.0337 + 180);
  assert.ok(Math.abs(alt - 15.1249) < 0.001, `高度 ${alt}`);
  assert.ok(Math.abs(az - azFromNorth) < 0.001, `方位 ${az} != ${azFromNorth}`);
});

test("precessionMatrix: Meeus 例21.b (ペルセウス座θ星)", () => {
  // 固有運動を先に適用した 2028-11-13.19 の平均位置を歳差させる
  const jd = 2462088.69;
  const ra0 = 41.054063;   // 固有運動込み (Meeus)
  const dec0 = 49.227750;
  const P = A.precessionMatrix(jd);
  const v = A.raDecToVec(ra0, dec0);
  const w = [0, 1, 2].map((i) => P[i][0] * v[0] + P[i][1] * v[1] + P[i][2] * v[2]);
  const [ra, dec] = A.vecToRaDec(w);
  // Meeus: α = 2h46m11.331s, δ = +49°20'54.54"
  assert.ok(Math.abs(ra - hms(2, 46, 11.331)) < 0.0002, `RA ${ra}`);
  assert.ok(Math.abs(dec - dms(49, 20, 54.54)) < 0.0002, `Dec ${dec}`);
});

test("precession: J2000 では恒等変換", () => {
  const P = A.precessionMatrix(2451545.0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      assert.ok(Math.abs(P[i][j] - (i === j ? 1 : 0)) < 1e-12);
    }
  }
});

test("skyMatrix: 天の北極は高度 = 緯度、方位 = 真北", () => {
  const jd = A.julianDay(2026, 7, 13, 12);
  // J2000 の北極 (赤緯+90) ではなく「日付の分点の北極」を見たいので歳差なしで
  const { alt, az } = A.eqToHorizon(0, 90, jd, 35.68, 139.77, false);
  assert.ok(Math.abs(alt - 35.68) < 1e-6, `高度 ${alt}`);
  assert.ok(Math.abs(az) < 1e-6 || Math.abs(az - 360) < 1e-6, `方位 ${az}`);
});

test("skyMatrix: 子午線上の天体は真南 (北半球で赤緯 < 緯度)", () => {
  const jd = A.julianDay(2026, 7, 13, 12);
  const theta = A.lst(jd, 139.77);      // 時角 0 = 南中
  const { alt, az } = A.eqToHorizon(theta, 0, jd, 35.68, 139.77, false);
  assert.ok(Math.abs(az - 180) < 1e-6, `方位 ${az}`);
  assert.ok(Math.abs(alt - (90 - 35.68)) < 1e-6, `高度 ${alt}`);
});

test("project: 天頂が中心、地平線が外周、東が左・北が上", () => {
  const cx = 200, cy = 200, R = 180;
  const at = (az, alt) => {
    const a = az * Math.PI / 180, h = alt * Math.PI / 180;
    return A.project(
      { e: Math.cos(h) * Math.sin(a), n: Math.cos(h) * Math.cos(a), u: Math.sin(h) },
      cx, cy, R
    );
  };
  const zenith = at(0, 90);
  assert.ok(Math.hypot(zenith.x - cx, zenith.y - cy) < 1e-6, "天頂は中心");

  const north = at(0, 0);
  assert.ok(Math.abs(north.x - cx) < 1e-6 && north.y < cy, "北は上");
  assert.ok(Math.abs(Math.hypot(north.x - cx, north.y - cy) - R) < 1e-6, "地平線は外周");

  const east = at(90, 0);      // ここを間違えると全部破綻する
  assert.ok(east.x < cx, "東は左 (見上げた空は地図と鏡像)");
  assert.ok(Math.abs(east.y - cy) < 1e-6);

  const south = at(180, 0);
  assert.ok(south.y > cy, "南は下");
  const west = at(270, 0);
  assert.ok(west.x > cx, "西は右");

  const alt45 = at(0, 45);
  assert.ok(Math.abs(Math.hypot(alt45.x - cx, alt45.y - cy) - R / 2) < 1e-6,
    "正距方位図法: 高度45° は半径の 1/2");
});

test("Phase 1 完了条件: 2026-07-13 21:00 JST 東京の空", () => {
  const jd = A.julianDay(2026, 7, 13, 12); // 21:00 JST = 12:00 UT
  const lat = 35.68, lon = 139.77;
  const pos = (ra, dec) => A.eqToHorizon(ra, dec, jd, lat, lon);

  // 夏の大三角は東の空に高く
  const vega = pos(279.2347, 38.7837);
  const deneb = pos(310.3580, 45.2803);
  const altair = pos(297.6958, 8.8683);
  for (const [name, s] of [["ベガ", vega], ["デネブ", deneb], ["アルタイル", altair]]) {
    assert.ok(s.alt > 30, `${name} の高度 ${s.alt.toFixed(1)}° が低すぎる`);
    assert.ok(s.az > 45 && s.az < 135, `${name} の方位 ${s.az.toFixed(1)}° が東寄りでない`);
  }
  assert.ok(vega.alt > 60, `ベガはほぼ天頂近く: ${vega.alt.toFixed(1)}°`);

  // さそり座アンタレスは南の低空
  const antares = pos(247.3519, -26.4320);
  assert.ok(antares.alt > 5 && antares.alt < 30,
    `アンタレスの高度 ${antares.alt.toFixed(1)}°`);
  assert.ok(Math.abs(antares.az - 180) < 35,
    `アンタレスの方位 ${antares.az.toFixed(1)}° が南でない`);

  // 北斗七星 (ドゥーベ・アルカイド) は北西の空
  const dubhe = pos(165.9319, 61.7510);
  const alkaid = pos(206.8852, 49.3133);
  for (const [name, s] of [["ドゥーベ", dubhe], ["アルカイド", alkaid]]) {
    assert.ok(s.az > 250 && s.az < 340, `${name} の方位 ${s.az.toFixed(1)}° が北西でない`);
    assert.ok(s.alt > 10, `${name} が地平線下: ${s.alt.toFixed(1)}°`);
  }

  // 北極星は常に高度 ≒ 緯度、真北
  const polaris = pos(37.9529, 89.2641);
  assert.ok(Math.abs(polaris.alt - lat) < 1.0, `ポラリスの高度 ${polaris.alt.toFixed(2)}°`);
});

// --- PLAN.md 8章「検証方法(全体)」---

test("既知イベント: 2月20時にオリオン座が南中する (東京)", () => {
  const jd = A.julianDay(2027, 2, 15, 11); // 20:00 JST = 11:00 UT
  const alnilam = A.eqToHorizon(84.0534, -1.2019, jd, 35.68, 139.77); // オリオンの三つ星の中央
  assert.ok(Math.abs(alnilam.az - 180) < 20,
    `オリオンの方位 ${alnilam.az.toFixed(1)}° が南でない`);
  assert.ok(alnilam.alt > 40, `オリオンの高度 ${alnilam.alt.toFixed(1)}° が低い`);
});

test("既知イベント: さそり座の南中は7月中旬21時ごろ、8月中旬21時には南西へ移る", () => {
  // PLAN.md は「夏(8月21時)にさそり座が南中」としているが、実際にアンタレスが
  // 21時に南中するのは7月中旬。8月中旬の21時にはもう南西に傾いている。
  const at = (mo, d) => A.eqToHorizon(247.3519, -26.4320,
    A.julianDay(2026, mo, d, 12), 35.68, 139.77); // 21:00 JST
  const july = at(7, 13);
  assert.ok(Math.abs(july.az - 180) < 10, `7月中旬の方位 ${july.az.toFixed(1)}°`);
  assert.ok(july.alt > 20 && july.alt < 32, `7月中旬の高度 ${july.alt.toFixed(1)}°`);

  const aug = at(8, 15);
  assert.ok(aug.az > 200 && aug.az < 230, `8月中旬の方位 ${aug.az.toFixed(1)}°`);
  assert.ok(aug.alt > 12 && aug.alt < 25, `8月中旬の高度 ${aug.alt.toFixed(1)}°`);
  assert.ok(aug.az > july.az, "1ヶ月で西へ移っていない");
});

test("極端ケース: 緯度65° では周極星が沈まず、南天の星は昇らない", () => {
  const lat = 65, lon = 139.77;
  const base = A.julianDay(2026, 7, 13);
  let dubheMin = 90, antaresMax = -90;
  for (let h = 0; h < 24; h++) {           // 1日ぶん回してみる
    const jd = base + h / 24;
    dubheMin = Math.min(dubheMin, A.eqToHorizon(165.9319, 61.7510, jd, lat, lon).alt);
    antaresMax = Math.max(antaresMax, A.eqToHorizon(247.3519, -26.4320, jd, lat, lon).alt);
  }
  assert.ok(dubheMin > 0, `北斗七星のドゥーベが沈んだ: 最低高度 ${dubheMin.toFixed(1)}°`);
  assert.ok(antaresMax < 0, `アンタレスが昇った: 最高高度 ${antaresMax.toFixed(1)}°`);
});

test("極端ケース: 日付をまたぐ時刻送りでも恒星時が連続している", () => {
  const lat = 35.68, lon = 139.77;
  const prev = A.eqToHorizon(279.2347, 38.7837,
    A.julianDay(2026, 7, 13, 14, 59), lat, lon);          // 23:59 JST
  const next = A.eqToHorizon(279.2347, 38.7837,
    A.julianDay(2026, 7, 13, 15, 1), lat, lon);           // 翌 00:01 JST
  assert.ok(Math.abs(next.alt - prev.alt) < 0.5, "日付の変わり目で高度が飛んでいる");
  const dAz = Math.abs(((next.az - prev.az + 540) % 360) - 180);
  assert.ok(dAz < 1.0, `日付の変わり目で方位が飛んでいる: ${dAz.toFixed(2)}°`);
});

test("歳差: J2000 のままだと 2026 年で 0.2° 以上ずれる (補正が効いている)", () => {
  const jd = A.julianDay(2026, 7, 13, 12);
  const ra = 247.3519, dec = -26.4320; // アンタレス
  const withP = A.eqToHorizon(ra, dec, jd, 35.68, 139.77, true);
  const noP = A.eqToHorizon(ra, dec, jd, 35.68, 139.77, false);
  const d = Math.hypot(
    (withP.az - noP.az) * Math.cos(withP.alt * Math.PI / 180),
    withP.alt - noP.alt
  );
  assert.ok(d > 0.2, `歳差の効果が小さすぎる: ${d.toFixed(3)}°`);
  assert.ok(d < 0.6, `歳差の効果が大きすぎる: ${d.toFixed(3)}°`);
});
