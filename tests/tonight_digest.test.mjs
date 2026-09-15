/**
 * 今夜の空の要約 (tools/tonight_digest.mjs / src/tonight.js) のテスト。
 *
 * 見たいのは二つ:
 *   1. 「/tonight/ と同じ数字になっているか」 — 同じ関数を呼んでいても、どの戻り値をどの欄に
 *      入れるか (日の出は当日か翌朝か・薄明の始まりは翌日か) と、分の丸め方で簡単にずれる。
 *      そこで tonight.html の書式関数 hhmm をここに**そのまま写して**突き合わせる。
 *   2. **外の基準と合っているか** — sky.test.mjs が使っている JPL Horizons の値
 *      (2026-07-13 東京 日の入 18:58:02) で、要約経由でも同じ分になることを見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { T, buildDigest } from "../tools/tonight_digest.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = (name) => readFileSync(path.join(ROOT, "src", name), "utf8");
// /tonight/ と同じ読み込み方 (astro.js + sky.js のグローバル)
const S = new Function(
  `${src("astro.js")}\n${src("sky.js")}\n` +
  "return {riseSet, twilightTimes, moonAge, moonPhaseName, planetWindows};",
)();

const TOKYO = { name: "東京", lat: 35.68, lon: 139.77 };
const TZ_MIN = 9 * 60;
const p2 = (n) => String(n).padStart(2, "0");

/** tonight.html の hhmm を写したもの (分は切り捨て・翌日は「翌 」)。 */
function hhmmTonightPage(ms, base) {
  if (ms === null || ms === undefined) return "—";
  const d = new Date(ms + TZ_MIN * 60000);
  const s = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return ms >= base + 86400000 ? `翌 ${s}` : s;
}

/** /tonight/ の画面に出る値を、tonight.html と同じ呼び方で作る。 */
function tonightPage(ymd, site) {
  const day = T.tonightDayStart(ymd);
  const sun = S.riseSet("sun", day, site.lat, site.lon);
  const tw = S.twilightTimes(day, site.lat, site.lon);
  const nextTw = S.twilightTimes(day + 86400000, site.lat, site.lon);
  const moon = S.riseSet("moon", day, site.lat, site.lon);
  const age = S.moonAge(day + 21 * 3600e3);
  const h = (ms) => hhmmTonightPage(ms, day);
  return {
    日の入り: h(sun.set),
    天文薄明の終わり: h(tw.astronomical.dusk),
    天文薄明の始まり: h(nextTw.astronomical.dawn),
    翌朝の日の出: h(S.riseSet("sun", day + 86400000, site.lat, site.lon).rise),
    月の出: h(moon.rise),
    月の入り: h(moon.set),
    月齢: age.age.toFixed(1),
    月相: S.moonPhaseName(age),
    惑星: S.planetWindows(day, site.lat, site.lon, 15).planets.map((p) => p.ja),
  };
}

for (const ymd of ["2026-09-15", "2026-07-13", "2026-12-21", "2026-06-21"]) {
  test(`${ymd} 東京: 要約の値が /tonight/ の表示と分単位で一致する`, () => {
    const d = buildDigest(ymd, TOKYO);
    const page = tonightPage(ymd, TOKYO);
    const hm = (iso) => T.tonightHM(iso, ymd);
    assert.equal(hm(d.sunset), page.日の入り);
    assert.equal(hm(d.astroTwilightEnd), page.天文薄明の終わり);
    assert.equal(hm(d.astroTwilightBegin), page.天文薄明の始まり);
    assert.equal(hm(d.sunrise), page.翌朝の日の出);
    assert.equal(hm(d.moonrise), page.月の出);
    assert.equal(hm(d.moonset), page.月の入り);
    assert.equal(d.moonAge.toFixed(1), page.月齢);
    assert.equal(d.moonPhaseName, page.月相);
    assert.deepEqual(d.planets.map((p) => p.name), page.惑星);
  });
}

test("外部基準: 2026-07-13 東京の日の入りは Horizons の 18:58:02 と同じ分 (18:58)", () => {
  const d = buildDigest("2026-07-13", TOKYO);
  assert.equal(T.tonightHM(d.sunset, d.date), "18:58");
  // <time datetime> に入る形も確認 (+09:00 付き・分まで)
  assert.equal(d.sunset, "2026-07-13T18:58+09:00");
});

test("週の現象は [当日, 7日後) の範囲に収まり、日時順で /calendar/ へリンクする", () => {
  const d = buildDigest("2026-09-15", TOKYO);
  const from = "2026-09-15T00:00+09:00", to = "2026-09-22T00:00+09:00";
  for (const e of d.weekEvents) {
    assert.ok(e.date >= from && e.date < to, `範囲外: ${e.date} ${e.text}`);
    assert.equal(e.href, "/calendar/");
  }
  const dates = d.weekEvents.map((e) => e.date);
  assert.deepEqual(dates, [...dates].sort());
});

test("彗星: 8等より明るいものが無い日は空配列で、節ごと出さない", () => {
  // **実データ (comets.json) に依存させない。** CI はテストが通らないとデプロイしないので、
  // MPC の要素が更新されて明るい彗星が入っただけで日次の配信が止まってしまう。合成の暗い彗星で見る。
  const ms = T.tonightDayStart("2026-09-15") + 21 * 3600e3;
  const dim = [["C/2099 Z1 (暗い)", 0.53, 1.42, 12.0, 117.8, 195.0, 2461200.5, 20, 10]];
  assert.deepEqual(T.tonightComets(dim, ms), []);
  assert.deepEqual(T.tonightComets([], ms), []);
  assert.deepEqual(T.tonightComets(undefined, ms), [], "ファイルが読めなくても落ちない");
  assert.equal(T.tonightCometsHtml([]), "", "0件なら見出しごと出さない");
});

test("彗星: 8.0等以下だけを明るい順に最大3件、観測星図への URL つきで返す", () => {
  // 実データの明るさは日々変わるので、10P の軌道要素で M1 だけ変えた合成の彗星で確かめる
  const tp = 2461200.5;
  const base = ["", 0.53, 1.42, 12.0, 117.8, 195.0, tp];
  const ms = T.tonightDayStart("2026-09-15") + 21 * 3600e3;
  const probe = T.tonightComets([[ "10P/Tempel", ...base.slice(1), 0, 10 ]], ms);
  assert.equal(probe.length, 1, "M1=0 なら明るく出るはず");
  const m0 = probe[0].mag;                          // M1=0 のときの等級 = 距離の項だけ
  const list = [
    ["C/2099 A1 (明るい)", ...base.slice(1), 6.5 - m0, 10],   // → 6.5等
    ["C/2099 B1 (境目)", ...base.slice(1), 8.0 - m0, 10],     // → 8.0等 (含む)
    ["C/2099 C1 (暗い)", ...base.slice(1), 8.2 - m0, 10],     // → 8.2等 (除く)
    ["12P/Pons-Brooks", ...base.slice(1), 7.0 - m0, 10],      // → 7.0等
    ["C/2099 D1 (最明)", ...base.slice(1), 5.0 - m0, 10],     // → 5.0等
  ];
  const got = T.tonightComets(list, ms);
  assert.deepEqual(got.map((c) => c.mag), [5.0, 6.5, 7.0], "明るい順・8.2等は除外・最大3件");
  assert.equal(got[0].href, "/?target=C%2F2099%20D1&labels=mag&fov=5");
  assert.equal(got[2].desig, "12P", "周期彗星は番号だけを符号にする");
  assert.match(T.tonightCometsHtml(got), /<h2>いま見える彗星<\/h2>/);
});

test("description は「日付(曜)の東京: 日の入り…、月齢…、今夜は…が見ごろ。」の型", () => {
  const d = buildDigest("2026-09-15", TOKYO);
  const s = T.tonightDescription(d);
  assert.match(s, /^9月15日\(火\)の東京: 日の入り\d\d:\d\d、月齢\d+、今夜は.+が見ごろ。/);
  assert.ok(s.endsWith("開いた瞬間に今の空が出る星座早見"));
  // 夜に見えている時間がいちばん長い惑星を選ぶ。明るさで選ぶと夜明け前に昇るだけの木星 (-1.6等) に
  // なってしまう。指示書の例文「今夜は土星が見ごろ」も 9/15 はこちら
  assert.equal(T.tonightBestPlanet(d).name, "土星");
  assert.match(s, /今夜は土星が見ごろ/);
});

test("CLI: --date で任意の日を出せる", () => {
  const out = execFileSync("node", [path.join(ROOT, "tools/tonight_digest.mjs"), "--date", "2026-09-15"],
    { encoding: "utf8" });
  const d = JSON.parse(out);
  assert.equal(d.date, "2026-09-15");
  assert.equal(d.weekday, "火");
  assert.equal(d.site.name, "東京");
  for (const k of ["sunset", "astroTwilightEnd", "astroTwilightBegin", "sunrise", "moonrise",
    "moonset", "moonAge", "moonPhaseName", "planets", "weekEvents", "comets"]) {
    assert.ok(k in d, `${k} が無い`);
  }
});

test("CLI: 日付の書式が違えば止まる (黙って今日を出さない)", () => {
  assert.throws(() => execFileSync("node",
    [path.join(ROOT, "tools/tonight_digest.mjs"), "--date", "2026/9/15"], { stdio: "pipe" }));
});
