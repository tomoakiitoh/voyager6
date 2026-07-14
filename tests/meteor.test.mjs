/**
 * 流星群まわりのテスト (src/sky.js の meteorRate / radiantTrack / meteorPeaks)。
 *
 * 基準値:
 *  - 極大時刻: in-the-sky.org「Perseid meteor shower 2026」の
 *    "peak activity at around 11:00 JST on 13 August 2026"
 *    https://in-the-sky.org/news.php?id=20260813_10_100
 *    λ☉ = 140.0° (J2000.0, IMO) から計算した値がこれと一致すること。
 *  - 輻射点の高度: このファイル内で独立に組んだ球面三角の式 (Meeus 12章の GMST) と照合する。
 *    sky.js 側は行列 (歳差込み) で解いているので、実装は別物になっている。
 *  - 出現数 HR: IMO の標準式そのものなので、式の恒等式が成り立つことを確かめる。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = (name) => readFileSync(path.join(ROOT, "src", name), "utf8");
const S = new Function(
  `${src("astro.js")}\n${src("events.js")}\n${src("sky.js")}\n` +
  `return {meteorRate, meteorZhrAt, radiantTrack, meteorPeaks, moonPhaseEvents, moonAge};`
)();

const TZ = 9 * 3600e3;
const jst = (ms) => new Date(ms + TZ).toISOString().slice(0, 16).replace("T", " ");
const dayStart = (y, m, d) => Date.UTC(y, m - 1, d) - TZ;

const TOKYO = { lat: 35.68, lon: 139.77 };
const PERSEID = { ra: 48.0, dec: 58.0, zhr: 100 };

// ---- 出現数の式 ----

test("HR: 輻射点が天頂・極限等級 6.5 等なら ZHR そのもの", () => {
  assert.equal(S.meteorRate(100, 90, 6.5), 100);
});

test("HR: 輻射点高度 30° なら sin30° = 1/2 で半分になる", () => {
  assert.ok(Math.abs(S.meteorRate(100, 30, 6.5) - 50) < 1e-9);
});

test("HR: 極限等級が 1 等悪くなると r 分の 1 になる", () => {
  const r = 2.2;
  const good = S.meteorRate(100, 90, 6.5, r);
  const bad = S.meteorRate(100, 90, 5.5, r);
  assert.ok(Math.abs(good / bad - r) < 1e-9, `比 ${(good / bad).toFixed(3)} が r=${r} にならない`);
});

test("HR: 輻射点が地平線下なら 0", () => {
  assert.equal(S.meteorRate(100, -1, 6.5), 0);
  assert.equal(S.meteorRate(100, 0, 6.5), 0);
});

test("HR: 市街地 (4等) では理想の空の 1/7 以下しか見えない", () => {
  const dark = S.meteorRate(100, 50, 6.5, 2.2);
  const city = S.meteorRate(100, 50, 4.0, 2.2);
  assert.ok(city < dark / 7, `市街地 ${city.toFixed(1)} 個/時 が暗い空 ${dark.toFixed(1)} の 1/7 未満でない`);
});

// ---- 極大からの離れによる減衰 ----

test("ZHR: 極大の瞬間は減衰なし", () => {
  assert.equal(S.meteorZhrAt(100, 0), 100);
});

test("ZHR: 極大の1日前は 0.65 倍、1日後は 0.52 倍 (後ろのほうが速く落ちる)", () => {
  const before = S.meteorZhrAt(100, -86400e3);
  const after = S.meteorZhrAt(100, +86400e3);
  assert.ok(Math.abs(before - 65) < 1.5, `1日前が ${before.toFixed(1)} (期待 65 前後)`);
  assert.ok(Math.abs(after - 52) < 1.5, `1日後が ${after.toFixed(1)} (期待 52 前後)`);
  assert.ok(after < before, "極大後のほうが速く減衰する");
});

test("ZHR: 極大から離れるほど単調に減る", () => {
  const days = [0, 1, 2, 3].map((d) => S.meteorZhrAt(100, d * 86400e3));
  for (let i = 1; i < days.length; i++) assert.ok(days[i] < days[i - 1]);
});

test("見込みは夜ごとに差がつく (極大に最も近い夜が最良)", () => {
  // 2026年の極大 8/13 11:01 JST に対し、8/12 の夜と 8/10 の夜を比べる
  const p = S.meteorPeaks(2026).find((m) => m.name === "ペルセウス座流星群");
  const rateOn = (d) => {
    const track = S.radiantTrack(PERSEID.ra, PERSEID.dec, dayStart(2026, 8, d),
      TOKYO.lat, TOKYO.lon, 19, 29);
    return Math.max(...track.map((t) =>
      S.meteorRate(S.meteorZhrAt(p.zhr, t.ms - p.peakMs), t.alt, 5.0, 2.2)));
  };
  const best = rateOn(12), early = rateOn(10);
  assert.ok(best > early * 1.4,
    `8/12 の夜 ${best.toFixed(0)} 個/時 が 8/10 の夜 ${early.toFixed(0)} 個/時 と大差ない`);
});

// ---- 極大時刻 (外部基準との照合) ----

test("2026年ペルセウス座流星群の極大が in-the-sky.org の 11:00 JST と 30分以内で一致", () => {
  const p = S.meteorPeaks(2026).find((m) => m.name === "ペルセウス座流星群");
  const expected = Date.UTC(2026, 7, 13, 2, 0);   // 11:00 JST = 02:00 UT
  const diffMin = Math.abs(p.peakMs - expected) / 60000;
  assert.ok(diffMin < 30, `極大 ${jst(p.peakMs)} JST が基準 (8/13 11:00) と ${diffMin.toFixed(0)} 分ずれている`);
});

test("2026年は極大と新月がほぼ重なる (月明かりがない当たり年)", () => {
  const p = S.meteorPeaks(2026).find((m) => m.name === "ペルセウス座流星群");
  const newMoon = S.moonPhaseEvents(dayStart(2026, 8, 1), dayStart(2026, 8, 31))
    .find((e) => e.name === "新月");
  const diffHours = Math.abs(p.peakMs - newMoon.ms) / 3600e3;
  assert.ok(diffHours < 12, `極大 ${jst(p.peakMs)} と新月 ${jst(newMoon.ms)} が ${diffHours.toFixed(1)} 時間離れている`);

  // 見頃の夜 (8/12 夜半) に月がほぼ光っていないこと
  const illum = S.moonAge(dayStart(2026, 8, 12) + 26 * 3600e3).illum;
  assert.ok(illum < 0.02, `8/13 未明の輝面比が ${(illum * 100).toFixed(1)}% もある`);
});

// ---- 輻射点の高度 (独立実装との照合) ----

/** 独立実装: Meeus 12.4 の GMST から高度を出す (歳差なし・J2000 のまま)。 */
function altitudeIndependent(raDeg, decDeg, ms, latDeg, lonDeg) {
  const jd = ms / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
    + 0.000387933 * T * T - T * T * T / 38710000;
  const lst = ((gmst + lonDeg) % 360 + 360) % 360;
  const H = (lst - raDeg) * Math.PI / 180;          // 時角
  const dec = decDeg * Math.PI / 180, lat = latDeg * Math.PI / 180;
  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(H);
  return Math.asin(sinAlt) * 180 / Math.PI;
}

test("輻射点の高度が独立実装と 0.5° 以内で一致 (2026-08-12 の夜, 東京)", () => {
  const track = S.radiantTrack(PERSEID.ra, PERSEID.dec, dayStart(2026, 8, 12),
    TOKYO.lat, TOKYO.lon, 19, 29);
  assert.equal(track.length, 11);
  for (const t of track) {
    const ref = altitudeIndependent(PERSEID.ra, PERSEID.dec, t.ms, TOKYO.lat, TOKYO.lon);
    const diff = Math.abs(t.alt - ref);
    // sky.js 側は J2000 → 2026 の歳差を効かせているので、その分 (0.3° 程度) はずれてよい
    assert.ok(diff < 0.5,
      `${jst(t.ms)} の高度 ${t.alt.toFixed(2)}° が独立計算 ${ref.toFixed(2)}° と ${diff.toFixed(2)}° 違う`);
  }
});

test("輻射点は夜半から明け方にかけて上がり続ける (ペルセウス座は周極に近い)", () => {
  const track = S.radiantTrack(PERSEID.ra, PERSEID.dec, dayStart(2026, 8, 12),
    TOKYO.lat, TOKYO.lon, 19, 29);
  for (let i = 1; i < track.length; i++) {
    assert.ok(track[i].alt > track[i - 1].alt,
      `${track[i].hour}時 の高度 ${track[i].alt.toFixed(1)}° が前の時刻より低い`);
  }
  // 明け方 (5時) には 60° を超える
  assert.ok(track[track.length - 1].alt > 60, `明け方の高度が ${track[track.length - 1].alt.toFixed(0)}° しかない`);
});

test("那覇より札幌のほうが輻射点が高い (北の輻射点なので緯度が高いほど有利)", () => {
  const at = (lat, lon) => S.radiantTrack(PERSEID.ra, PERSEID.dec, dayStart(2026, 8, 12),
    lat, lon, 26, 26)[0].alt;
  const sapporo = at(43.06, 141.35), naha = at(26.21, 127.68);
  assert.ok(sapporo > naha + 10, `札幌 ${sapporo.toFixed(0)}° と那覇 ${naha.toFixed(0)}° の差が小さい`);
});
