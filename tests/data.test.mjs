/**
 * 星表データ (src/data.js) の健全性チェック。
 * build_data.py で作り直したときに、黙って壊れていないかを見る。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = (name) => readFileSync(path.join(ROOT, "src", name), "utf8");
const D = new Function(
  `${src("data.js")}\nreturn {STARS, STAR_NAMES, CONST_LINES, CONST_NAMES, MILKYWAY, MESSIER};`
)();

/** 2天体の離角 [度]。 */
function sep(ra1, dec1, ra2, dec2) {
  const R = Math.PI / 180;
  const c = Math.sin(dec1 * R) * Math.sin(dec2 * R)
    + Math.cos(dec1 * R) * Math.cos(dec2 * R) * Math.cos((ra1 - ra2) * R);
  return Math.acos(Math.max(-1, Math.min(1, c))) / R;
}

test("恒星: 等級5.0以下がそろい、明るい順に並んでいる", () => {
  assert.ok(D.STARS.length > 1500 && D.STARS.length < 1800, `${D.STARS.length} 個`);
  for (const [ra, dec, mag] of D.STARS) {
    assert.ok(ra >= 0 && ra < 360, `赤経が範囲外: ${ra}`);
    assert.ok(dec >= -90 && dec <= 90, `赤緯が範囲外: ${dec}`);
    assert.ok(mag <= 5.0, `等級 ${mag} が上限を超えている`);
  }
  for (let i = 1; i < D.STARS.length; i++) {
    assert.ok(D.STARS[i][2] >= D.STARS[i - 1][2], "明るい順に並んでいない");
  }
  // いちばん明るいのはシリウス
  assert.ok(sep(D.STARS[0][0], D.STARS[0][1], 101.287, -16.716) < 0.1, "先頭がシリウスでない");
});

test("星名: 添字が STARS を指していて、よく知られた星が入っている", () => {
  const byName = new Map(D.STAR_NAMES.map(([i, ja]) => [ja, i]));
  for (const [i] of D.STAR_NAMES) {
    assert.ok(i >= 0 && i < D.STARS.length, `添字が範囲外: ${i}`);
  }
  const vega = D.STARS[byName.get("ベガ")];
  assert.ok(sep(vega[0], vega[1], 279.234, 38.784) < 0.1, "ベガの位置がずれている");
  const antares = D.STARS[byName.get("アンタレス")];
  assert.ok(sep(antares[0], antares[1], 247.352, -26.432) < 0.1, "アンタレスの位置がずれている");
});

test("星座: 88星座 + へび座の分割で 89件、線と名前が対応する", () => {
  assert.equal(D.CONST_NAMES.length, 89);
  assert.equal(D.CONST_LINES.length, 89);
  const names = new Set(D.CONST_NAMES.map((c) => c[0]));
  for (const [abbr] of D.CONST_LINES) {
    assert.ok(names.has(abbr), `${abbr} に対応する星座名がない`);
  }
  const ja = new Map(D.CONST_NAMES.map((c) => [c[0], c[1]]));
  assert.equal(ja.get("Ori"), "オリオン座");
  assert.equal(ja.get("Sco"), "さそり座");
});

test("メシエ天体: 110個そろい、種類分けと有名な天体の位置が正しい", () => {
  assert.equal(D.MESSIER.length, 110);
  const byId = new Map(D.MESSIER.map((m) => [m[0], m]));

  const m31 = byId.get("M31");
  assert.ok(sep(m31[1], m31[2], 10.684, 41.269) < 0.2, "M31 の位置がずれている");
  assert.equal(m31[4], "galaxy");
  assert.equal(m31[6], "アンドロメダ銀河");

  const m42 = byId.get("M42");
  assert.ok(sep(m42[1], m42[2], 83.822, -5.391) < 0.2, "M42 の位置がずれている");
  assert.equal(m42[4], "nebula");

  const m45 = byId.get("M45");  // すばる
  assert.ok(sep(m45[1], m45[2], 56.75, 24.117) < 0.5, "M45 の位置がずれている");
  assert.equal(m45[4], "cluster");

  const kinds = new Set(D.MESSIER.map((m) => m[4]));
  assert.deepEqual([...kinds].sort(), ["cluster", "galaxy", "nebula", "other"]);
});

test("天の川: 5段階の濃度レベルが入っている", () => {
  assert.equal(D.MILKYWAY.length, 5);
  for (const level of D.MILKYWAY) {
    assert.ok(level.length > 0);
    for (const ring of level) {
      assert.ok(ring.length >= 4, "リングの頂点が少なすぎる");
    }
  }
});
