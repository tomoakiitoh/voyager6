/**
 * 出没・薄明・月齢のテスト (src/sky.js)。
 *
 * 基準値: JPL Horizons の 1分刻み暦 (東京 139.77°E / 35.68°N / 標高0m, 大気差なし) から
 * 高度が閾値を横切る瞬間を線形補間で求めたもの。2026-07-13 (JST) の一日ぶん。
 *   太陽 -0.833° : 出 04:34:58 / 入 18:58:02
 *   月   +0.125° : 出 02:40:52 / 入 18:05:55
 *   薄明 -6/-12/-18° : 朝 04:05:31 / 03:29:13 / 02:49:24
 *                      夕 19:27:27 / 20:03:38 / 20:43:18
 *
 * 許容誤差は SITE_PLAN.md 5章の目標 (太陽1分・月3分) に合わせている。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = (name) => readFileSync(path.join(ROOT, "src", name), "utf8");
const S = new Function(
  `${src("astro.js")}\n${src("sky.js")}\n` +
  `return {riseSet, twilightTimes, moonAge, planetWindows, findCrossings, altitudeFn};`
)();

const LAT = 35.68, LON = 139.77, TZ = 9 * 60;

/** JST の日付 → その日の 0:00 の絶対時刻。 */
const dayStart = (y, mo, d) => Date.UTC(y, mo - 1, d) - TZ * 60000;
/** 絶対時刻 → JST の "HH:MM:SS"。 */
function jst(ms) {
  const d = new Date(ms + TZ * 60000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
/** "HH:MM:SS" 同士の差 [秒]。 */
function diffSec(ms, hhmmss) {
  const [h, m, s] = hhmmss.split(":").map(Number);
  const d = new Date(ms + TZ * 60000);
  const got = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  return Math.abs(got - (h * 3600 + m * 60 + s));
}

const DAY = dayStart(2026, 7, 13);

test("日の出・日の入り: Horizons と 1分以内", () => {
  const sun = S.riseSet("sun", DAY, LAT, LON);
  assert.ok(diffSec(sun.rise, "04:34:58") < 60, `日の出 ${jst(sun.rise)}`);
  assert.ok(diffSec(sun.set, "18:58:02") < 60, `日の入り ${jst(sun.set)}`);
  assert.ok(sun.transitAlt > 74 && sun.transitAlt < 78,
    `南中高度 ${sun.transitAlt.toFixed(1)}°`); // 夏至すぎの東京は 77° 前後
});

test("月の出・月の入り: Horizons と 3分以内 (地平視差の補正込み)", () => {
  const moon = S.riseSet("moon", DAY, LAT, LON);
  assert.ok(diffSec(moon.rise, "02:40:52") < 180, `月の出 ${jst(moon.rise)}`);
  assert.ok(diffSec(moon.set, "18:05:55") < 180, `月の入り ${jst(moon.set)}`);
});

test("薄明: 市民・航海・天文の各段階が Horizons と 90秒以内", () => {
  const tw = S.twilightTimes(DAY, LAT, LON);
  const REF = {
    civil: ["04:05:31", "19:27:27"],
    nautical: ["03:29:13", "20:03:38"],
    astronomical: ["02:49:24", "20:43:18"],
  };
  for (const [name, [dawn, dusk]] of Object.entries(REF)) {
    assert.ok(diffSec(tw[name].dawn, dawn) < 90, `${name} 朝 ${jst(tw[name].dawn)}`);
    assert.ok(diffSec(tw[name].dusk, dusk) < 90, `${name} 夕 ${jst(tw[name].dusk)}`);
  }
});

test("薄明の順序: 天文 → 航海 → 市民 → 日の出 の順に明るくなる", () => {
  const tw = S.twilightTimes(DAY, LAT, LON);
  const sun = S.riseSet("sun", DAY, LAT, LON);
  assert.ok(tw.astronomical.dawn < tw.nautical.dawn);
  assert.ok(tw.nautical.dawn < tw.civil.dawn);
  assert.ok(tw.civil.dawn < sun.rise);
  assert.ok(sun.set < tw.civil.dusk);
  assert.ok(tw.civil.dusk < tw.nautical.dusk);
  assert.ok(tw.nautical.dusk < tw.astronomical.dusk);
});

test("高緯度: 白夜では日が沈まず、alwaysUp が立つ", () => {
  // 夏至ごろの北緯70° (ノルウェー北部あたり) は太陽が沈まない
  const sun = S.riseSet("sun", dayStart(2026, 6, 21), 70, 25);
  assert.equal(sun.rise, null);
  assert.equal(sun.set, null);
  assert.ok(sun.alwaysUp, "白夜にならない");
  assert.ok(!sun.alwaysDown);
});

test("高緯度: 極夜では日が昇らず、alwaysDown が立つ", () => {
  const sun = S.riseSet("sun", dayStart(2026, 12, 21), 70, 25);
  assert.equal(sun.rise, null);
  assert.ok(sun.alwaysDown, "極夜にならない");
});

test("月齢: 2026-07-14 の新月の前後で 0 に戻る", () => {
  const before = S.moonAge(dayStart(2026, 7, 13) + 12 * 3600e3); // 新月の直前
  const after = S.moonAge(dayStart(2026, 7, 16) + 12 * 3600e3);  // 新月の2日後
  assert.ok(before.age > 27, `新月直前の月齢 ${before.age.toFixed(1)}`);
  assert.ok(after.age > 1 && after.age < 3, `新月2日後の月齢 ${after.age.toFixed(1)}`);
  assert.ok(after.illum > before.illum, "新月を過ぎたら太っていく");
  assert.ok(after.waxing, "満ちていく途中と判定されない");
});

test("惑星の見ごろ: 2026-07-20 の金星は宵の口だけ (すぐ沈む)", () => {
  const w = S.planetWindows(dayStart(2026, 7, 20), LAT, LON, 15);
  assert.ok(w.nightFrom < w.nightTo, "夜の範囲が逆転している");

  const venus = w.planets.find((p) => p.name === "Venus");
  assert.ok(venus, "金星の見ごろが見つからない");
  // 薄明の終わりに西の低空にいて、30分ほどで 15° を切って沈んでいく
  const [from, to] = venus.spans[0];
  assert.ok(from - w.nightFrom < 5 * 60000, "日没直後から見えているはず");
  assert.ok(to - from < 60 * 60000, `金星の見ごろが長すぎる: ${(to - from) / 60000} 分`);
  assert.ok(venus.bestAlt < 20, `金星の最高高度 ${venus.bestAlt.toFixed(1)}°`);
  assert.ok(venus.mag < -3.5, `金星の等級 ${venus.mag.toFixed(1)}`);

  // 同じ夜、土星は深夜に高く昇る (夜半以降が本番)
  const saturn = w.planets.find((p) => p.name === "Saturn");
  assert.ok(saturn && saturn.bestAlt > 35, "土星の見ごろが出ていない");
});

test("惑星の見ごろ: 2026-10-15 の宵には土星が高く昇る", () => {
  const w = S.planetWindows(dayStart(2026, 10, 15), LAT, LON, 15);
  const saturn = w.planets.find((p) => p.name === "Saturn");
  assert.ok(saturn, "土星の見ごろが見つからない");
  assert.ok(saturn.bestAlt > 40, `土星の最高高度 ${saturn.bestAlt.toFixed(1)}°`);
  assert.ok(saturn.spans.length >= 1);
  // 見ごろの中心は夜のあいだにある
  assert.ok(saturn.bestMs >= w.nightFrom && saturn.bestMs <= w.nightTo);
});
