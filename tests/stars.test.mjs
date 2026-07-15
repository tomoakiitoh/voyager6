/**
 * F2: 深い星表のクライアント側 (src/stars.js) のユニットテスト。
 *
 *   node --test tests/*.mjs
 *
 * build_stars.py と同じグリッド・レコード形式を扱えることを確認する。
 * タイル取り違え (Python との丸め差) を防ぐため、帯セル数 nRa は manifest から読む
 * 設計になっている。ここではそのデコードと視野→タイル算出を検証する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = (name) => readFileSync(path.join(ROOT, "src", name), "utf8");

const S = new Function(
  `${src("stars.js")}\nreturn {decodeStarTile, bandOfDec, cellOfRa, tileKeyOf, tileKeysForRegion};`
)();

// build_stars.py と同じ式で作った小さな manifest (bandH=10, 18帯)。
function makeManifest() {
  const bandH = 10, nBands = 18;
  const nRa = [];
  for (let b = 0; b < nBands; b++) {
    const mid = -90 + (b + 0.5) * bandH;
    nRa.push(Math.max(1, Math.round(360 * Math.cos(mid * Math.PI / 180) / bandH)));
  }
  return {
    recordBytes: 10, magRange: [5, 10], bvRange: [-0.5, 2.5],
    bandH, nBands, nRa,
  };
}

/** テスト用に 1 タイル分のバイナリを作る。 */
function packTile(stars, m) {
  const buf = new ArrayBuffer(stars.length * 10);
  const dv = new DataView(buf);
  const [mlo, mhi] = m.magRange, [blo, bhi] = m.bvRange;
  stars.forEach((s, i) => {
    const o = i * 10;
    dv.setFloat32(o, s.ra, true);
    dv.setFloat32(o + 4, s.dec, true);
    dv.setUint8(o + 8, Math.round((s.mag - mlo) / (mhi - mlo) * 255));
    dv.setUint8(o + 9, Math.round((s.bv - blo) / (bhi - blo) * 255));
  });
  return buf;
}

test("decodeStarTile: pack→decode で ra/dec/mag/bv が復元する", () => {
  const m = makeManifest();
  const stars = [
    { ra: 10.5, dec: 41.3, mag: 8.24, bv: 0.7 },
    { ra: 359.9, dec: -12.0, mag: 5.1, bv: -0.2 },
    { ra: 180.0, dec: 0.0, mag: 9.98, bv: 1.6 },
  ];
  const d = S.decodeStarTile(packTile(stars, m), m);
  assert.equal(d.n, 3);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(d.ra[i] - stars[i].ra) < 1e-3, `ra[${i}]`);
    assert.ok(Math.abs(d.dec[i] - stars[i].dec) < 1e-3, `dec[${i}]`);
    assert.ok(Math.abs(d.mag[i] - stars[i].mag) < 0.02, `mag[${i}]`); // 量子化分解能
    assert.ok(Math.abs(d.bv[i] - stars[i].bv) < 0.02, `bv[${i}]`);
  }
});

test("tileKeyOf: 帯・セルの割り当て (境界と極)", () => {
  const m = makeManifest();
  // 赤緯 0° は帯 9 (0-based, -90+9*10=0 の帯), 赤経 0 はセル 0
  assert.equal(S.bandOfDec(0.0, m), 9);
  assert.equal(S.bandOfDec(-90, m), 0);
  assert.equal(S.bandOfDec(90, m), 17);   // 上端はクランプ
  assert.equal(S.cellOfRa(0, 9, m), 0);
  // 赤経のセルは 0..nRa-1 にクランプ (境界と範囲外)
  const b = 9, n = m.nRa[b];
  assert.equal(S.cellOfRa(359.999, b, m), n - 1);
  assert.equal(S.cellOfRa(360, b, m), 0);       // ちょうど360は0へ折り返す
  assert.equal(S.cellOfRa(-0.001, b, m), n - 1); // 負値も正規化
});

test("tileKeysForRegion: 中心点自身のタイルを必ず含む", () => {
  const m = makeManifest();
  for (const [ra, dec] of [[10, 41], [0.2, -5], [359.8, 20], [200, -70], [45, 0]]) {
    const keys = S.tileKeysForRegion(ra, dec, 3, m);
    assert.ok(keys.includes(S.tileKeyOf(ra, dec, m)),
      `(${ra},${dec}) 自身のタイル ${S.tileKeyOf(ra, dec, m)} が含まれない`);
  }
});

test("tileKeysForRegion: 赤経0をまたぐ円は両側のセルを拾う", () => {
  const m = makeManifest();
  const keys = S.tileKeysForRegion(0.5, 0, 5, m); // RA≈0付近, 赤道
  const b = S.bandOfDec(0, m), n = m.nRa[b];
  // 0付近と 359付近 (= 最後のセル) の両方が入る
  assert.ok(keys.includes(`${b}_0`), "セル0");
  assert.ok(keys.includes(`${b}_${n - 1}`), `折り返しの最後のセル ${n - 1}`);
});

test("tileKeysForRegion: 極帯は全周セル(=1つ)、広半径でも破綻しない", () => {
  const m = makeManifest();
  const keys = S.tileKeysForRegion(123, 89, 5, m);
  const bTop = S.bandOfDec(89, m);
  assert.ok(keys.includes(`${bTop}_0`));
  // 重複を含めても妥当な数 (無限ループしない)
  assert.ok(keys.length < 100);
});
