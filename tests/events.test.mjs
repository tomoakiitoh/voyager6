/**
 * 天文現象 (月相・惑星現象・流星群・月食) のテスト。
 *
 * 月相の検証には NASA の食のカタログ (src/events.js) を使う。
 * 日食は必ず新月の瞬間に、月食は必ず満月の瞬間に起きるので、
 * カタログの「最大食の時刻」と自前の月相計算がずれていないかを突き合わせられる。
 * 独立した基準と照らす形になっていて、しかもテーブルは NASA の確定値。
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
  `return {meteorPeaks, moonPhaseEvents, planetEvents, lunarEclipseLocal,
           sunLongitudeJ2000, ECLIPSES_SOLAR, ECLIPSES_LUNAR, METEOR_SHOWERS};`
)();

const TZ = 9 * 3600000;
const jstDate = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);
const utc = (iso, hhmmss) => {
  const [y, mo, d] = iso.split("-").map(Number);
  const [h, m, s] = hhmmss.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, m, s);
};

test("新月の時刻が日食の最大食の時刻と 1時間以内で一致する (2026〜2030)", () => {
  const from = Date.UTC(2026, 0, 1), to = Date.UTC(2031, 0, 1);
  const newMoons = S.moonPhaseEvents(from, to).filter((p) => p.name === "新月");
  const eclipses = S.ECLIPSES_SOLAR.filter((e) => {
    const y = Number(e[0].slice(0, 4));
    return y >= 2026 && y <= 2030;
  });
  assert.ok(eclipses.length >= 10, `日食が少なすぎる: ${eclipses.length}`);

  for (const e of eclipses) {
    const maxMs = utc(e[0], e[1]);
    const nearest = newMoons.reduce((a, b) =>
      Math.abs(b.ms - maxMs) < Math.abs(a.ms - maxMs) ? b : a);
    const diffMin = Math.abs(nearest.ms - maxMs) / 60000;
    assert.ok(diffMin < 60,
      `${e[0]} の日食 (${e[2]}) と新月が ${diffMin.toFixed(0)}分 ずれている`);
  }
});

test("満月の時刻が月食の最大食の時刻と 1時間以内で一致する (2026〜2030)", () => {
  const from = Date.UTC(2026, 0, 1), to = Date.UTC(2031, 0, 1);
  const fullMoons = S.moonPhaseEvents(from, to).filter((p) => p.name === "満月");
  const eclipses = S.ECLIPSES_LUNAR.filter((e) => {
    const y = Number(e[0].slice(0, 4));
    return y >= 2026 && y <= 2030;
  });
  assert.ok(eclipses.length >= 10, `月食が少なすぎる: ${eclipses.length}`);

  for (const e of eclipses) {
    const maxMs = utc(e[0], e[1]);
    const nearest = fullMoons.reduce((a, b) =>
      Math.abs(b.ms - maxMs) < Math.abs(a.ms - maxMs) ? b : a);
    const diffMin = Math.abs(nearest.ms - maxMs) / 60000;
    assert.ok(diffMin < 60,
      `${e[0]} の月食 (${e[2]}) と満月が ${diffMin.toFixed(0)}分 ずれている`);
  }
});

test("月相は 新月 → 上弦 → 満月 → 下弦 の順に並ぶ", () => {
  const ev = S.moonPhaseEvents(Date.UTC(2026, 0, 1), Date.UTC(2026, 3, 1));
  const order = ["新月", "上弦", "満月", "下弦"];
  for (let i = 1; i < ev.length; i++) {
    assert.ok(ev[i].ms > ev[i - 1].ms, "時刻が並んでいない");
    const expected = order[(order.indexOf(ev[i - 1].name) + 1) % 4];
    assert.equal(ev[i].name, expected, `${ev[i - 1].name} の次が ${ev[i].name}`);
  }
});

test("2026年の惑星現象: 木星の衝は 1月10日ごろ、火星に衝はない", () => {
  const ev = S.planetEvents(Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1));

  const jupiter = ev.find((e) => e.ja === "木星" && e.label.startsWith("衝"));
  assert.ok(jupiter, "木星の衝が見つからない");
  assert.equal(jstDate(jupiter.ms).slice(0, 7), "2026-01");
  assert.ok(Math.abs(new Date(jstDate(jupiter.ms)) - new Date("2026-01-10")) < 2 * 86400e3,
    `木星の衝が ${jstDate(jupiter.ms)}`);

  // 火星の衝は 2027年2月。2026年には来ない (会合周期 780日)
  assert.ok(!ev.some((e) => e.ja === "火星" && e.label.startsWith("衝")),
    "2026年に火星の衝が出てしまっている");

  // 水星の最大離角は年に 6回前後 (東方・西方が交互)
  const merc = ev.filter((e) => e.ja === "水星" && e.label.includes("最大離角"));
  assert.ok(merc.length >= 5 && merc.length <= 7, `水星の最大離角が ${merc.length} 回`);
  for (const m of merc) {
    assert.ok(m.elong > 17 && m.elong < 29, `水星の離角 ${m.elong.toFixed(0)}°`);
  }
});

test("内惑星の最大離角は東方と西方が交互に来る", () => {
  const ev = S.planetEvents(Date.UTC(2026, 0, 1), Date.UTC(2028, 0, 1))
    .filter((e) => e.ja === "水星" && e.label.includes("最大離角"));
  for (let i = 1; i < ev.length; i++) {
    const prevEast = ev[i - 1].label.startsWith("東方");
    const east = ev[i].label.startsWith("東方");
    assert.notEqual(east, prevEast, `${jstDate(ev[i].ms)} で東西が連続している`);
  }
});

test("流星群: 主要3群の極大が正しい時期に来る (2026年)", () => {
  const peaks = S.meteorPeaks(2026);
  const at = (name) => peaks.find((p) => p.name === name);

  // IMO の λ☉ から計算した極大。日付が例年どおりの範囲に収まるか
  assert.match(jstDate(at("ペルセウス座流星群").peakMs), /^2026-08-1[23]$/);
  assert.match(jstDate(at("ふたご座流星群").peakMs), /^2026-12-1[45]$/);
  assert.match(jstDate(at("しぶんぎ座流星群").peakMs), /^2026-01-0[34]$/);
  assert.equal(peaks.length, S.METEOR_SHOWERS.length, "極大を計算できない群がある");

  // 極大は λ☉ の順に並ぶ = 1年を通して日付順になる
  for (let i = 1; i < peaks.length; i++) {
    assert.ok(peaks[i].peakMs > peaks[i - 1].peakMs);
  }
});

test("太陽黄経 (J2000): 春分点で 0°、夏至で 90° になる", () => {
  // 2026年の春分は 3月20日ごろ、夏至は 6月21日ごろ
  const equinox = S.meteorPeaks(2026); // (関数を通さず直接確かめる)
  const lam = (y, mo, d, h) => S.sunLongitudeJ2000(
    2440587.5 + Date.UTC(y, mo - 1, d, h) / 86400000);
  assert.ok(Math.abs(lam(2026, 3, 20, 14) - 0) < 1 || Math.abs(lam(2026, 3, 20, 14) - 360) < 1,
    `春分の λ☉ = ${lam(2026, 3, 20, 14).toFixed(2)}°`);
  assert.ok(Math.abs(lam(2026, 6, 21, 8) - 90) < 1,
    `夏至の λ☉ = ${lam(2026, 6, 21, 8).toFixed(2)}°`);
  assert.ok(equinox.length > 0);
});

test("月食の見え方: 2026-03-03 の皆既月食は日本から見える", () => {
  const e = S.ECLIPSES_LUNAR.find((x) => x[0] === "2026-03-03");
  assert.ok(e, "2026-03-03 の月食がカタログにない");
  assert.equal(e[2], "皆既");

  const tokyo = S.lunarEclipseLocal(e, 35.68, 139.77);
  assert.ok(tokyo.visible, `東京で月が地平線下 (高度 ${tokyo.alt.toFixed(1)}°)`);
  assert.ok(tokyo.alt > 20, `東京での高度 ${tokyo.alt.toFixed(1)}° が低すぎる`);
  assert.ok(!tokyo.daylight, "空が明るいと判定されている");

  // 同じ月食はヨーロッパ (ロンドン) では月が沈んでいて見えない
  const london = S.lunarEclipseLocal(e, 51.5, -0.13);
  assert.ok(!london.visible, `ロンドンで見えることになっている (高度 ${london.alt.toFixed(1)}°)`);
});
