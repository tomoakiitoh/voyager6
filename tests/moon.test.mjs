/**
 * 月の位置 (ELP2000-82B 主要項, astro.js moonPositionELP) を検証する。
 *
 *   node --test tests/moon.test.mjs
 *
 * なぜ既存の moonPosition (Schlyter) では足りないか:
 * 食の幾何は「月の影が地表のどこに落ちるか」なので、角度誤差がそのまま地表の距離になる。
 * 1″ ≒ 1.86km (月までの距離 384,400km)。本影の幅は 100〜270km しかないので、
 * Schlyter の 1′ 級 (=約110km) では影ひとつぶんずれる。実測 (下のテスト) では
 * Schlyter は最大163″=約300km ずれており、皆既帯を描く用途には使えない。
 *
 * 基準値は2つ:
 *   1. Meeus 第47章の検証例 47.a (級数の転記ミスを直接に検出する)
 *   2. JPL Horizons の地心ベクトル (光行時補正なし・黄道J2000)。1969〜2035年の7日付で、
 *      小さな項の取りこぼしを検出する
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const astro = readFileSync(path.join(ROOT, "src", "astro.js"), "utf8");
const A = new Function(
  `${astro}\nreturn { moonPositionELP, moonPosition, precessionMatrix };`
)();

const D2R = Math.PI / 180;
const jdOf = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  const a = Math.floor((14 - m) / 12), y2 = y + 4800 - a, m2 = m + 12 * a - 3;
  return d + Math.floor((153 * m2 + 2) / 5) + 365 * y2 + Math.floor(y2 / 4)
    - Math.floor(y2 / 100) + Math.floor(y2 / 400) - 32045 - 0.5;
};

/** 日付の分点の黄道座標 → 黄道 J2000 の単位ベクトル (Horizons と比べるため)。 */
function toJ2000Ecl(lon, lat, jd) {
  const eps0 = 23.4392911 * D2R;
  const T = (jd - 2451545) / 36525;
  const eps = (23.4392911 - (46.8150 * T + 0.00059 * T * T - 0.001813 * T ** 3) / 3600) * D2R;
  const l = lon * D2R, b = lat * D2R;
  const x = Math.cos(b) * Math.cos(l), y = Math.cos(b) * Math.sin(l), z = Math.sin(b);
  const xe = x, ye = y * Math.cos(eps) - z * Math.sin(eps), ze = y * Math.sin(eps) + z * Math.cos(eps);
  const P = A.precessionMatrix(jd);                       // J2000 → 日付。戻すので転置を使う
  const X = P[0][0] * xe + P[1][0] * ye + P[2][0] * ze;
  const Y = P[0][1] * xe + P[1][1] * ye + P[2][1] * ze;
  const Z = P[0][2] * xe + P[1][2] * ye + P[2][2] * ze;
  return [X, Y * Math.cos(eps0) + Z * Math.sin(eps0), -Y * Math.sin(eps0) + Z * Math.cos(eps0)];
}
const sepArcsec = (a, b) => {
  const na = Math.hypot(...a), nb = Math.hypot(...b);
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
  return Math.acos(Math.max(-1, Math.min(1, c))) / D2R * 3600;
};

test("Meeus 例47.a (1992-04-12 0h TD) と一致する", () => {
  const m = A.moonPositionELP(2448724.5);
  assert.ok(Math.abs(m.lon - 133.162655) * 3600 < 0.5, `λ=${m.lon}`);
  assert.ok(Math.abs(m.lat - (-3.229126)) * 3600 < 0.5, `β=${m.lat}`);
  assert.ok(Math.abs(m.dist - 368409.7) < 0.5, `Δ=${m.dist}`);
});

// JPL Horizons: 地心・黄道J2000・VEC_CORR=NONE。0h TT (TDB との差は無視できる)
const HORIZONS = {
  "1992-04-12": [-252118.7123185933, 267821.4160399647, -20748.20363281926],
  "2024-04-08": [355766.3896596306, 47183.41033419119, -4479.216006509294],   // 北米皆既日食
  "2009-07-22": [-165968.9564735608, 316621.0658222582, 1388.324908856623],   // トカラ皆既日食
  "2035-09-02": [-343124.1987084147, 140140.0551469326, 1664.345285705407],   // 北関東皆既日食
  "2000-01-01": [-317650.2412950324, -241883.1762389348, 36555.82307692753],
  "2030-06-01": [156971.2702696196, 374687.3456521075, 5613.504374191252],  // 北海道金環日食
  "1969-07-20": [-392973.8081447611, 16192.55384145962, -2917.033896120265],  // アポロ11号着陸
};

test("JPL Horizons と 5″ / 20km 以内で一致する (1969〜2035年)", () => {
  for (const [date, v] of Object.entries(HORIZONS)) {
    const jd = jdOf(date);
    const m = A.moonPositionELP(jd);
    const sep = sepArcsec(toJ2000Ecl(m.lon, m.lat, jd), v);
    const dd = m.dist - Math.hypot(...v);
    assert.ok(sep < 5, `${date}: 角度差 ${sep.toFixed(1)}″`);
    assert.ok(Math.abs(dd) < 20, `${date}: 距離差 ${dd.toFixed(0)}km`);
  }
});

test("既存の Schlyter 系列では食の幾何に足りないこと自体を記録する", () => {
  // この差 (1′ 級 = 地表で約110km) が ELP を足した理由。回帰で気づけるよう明示しておく
  let worst = 0;
  for (const [date, v] of Object.entries(HORIZONS)) {
    const jd = jdOf(date);
    const o = A.moonPosition(jd);
    worst = Math.max(worst, sepArcsec(toJ2000Ecl(o.lon, o.lat, jd), v));
  }
  assert.ok(worst > 10, `Schlyter の最大誤差が ${worst.toFixed(0)}″ しかない`);
});
