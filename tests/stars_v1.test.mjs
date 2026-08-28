/**
 * 20等星図の v1 深層 (HEALPix タイル) のテスト。
 *
 *   node --test tests/*.test.mjs
 *
 * **ここで守りたいのは「Python が書いた場所を JS が読みに行けること」**。
 * 現行の自前グリッドでは、Python と JS が別々にセル番号を計算していて
 * 丸め差でタイルを取り違えた前例がある。v1 では
 *   - 索引を HEALPix にして、両実装を**第三者の基準値** (astropy-healpix) に固定する
 *   - 層・nside・タイル一覧は manifest からしか読まない (JS で再計算しない)
 * の二段で防いでいる。前者をここで担保する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = (name) => readFileSync(path.join(ROOT, "src", name), "utf8");

const EXPORTS = ["ang2pixNest", "decodeStarTileV1", "pixelsForRegionV1", "hpxInterleave"];
const V = new Function(src("stars.js") + `; return {${EXPORTS.join(",")}};`)();

const FX = JSON.parse(
  readFileSync(path.join(ROOT, "tests", "fixtures", "healpix_ang2pix.json"), "utf8"));
const TIES = new Set(FX.ties);

test("ang2pixNest: astropy-healpix の基準値と全件一致 (nside 16/64/128/256)", () => {
  let checked = 0;
  for (const [nsideStr, ref] of Object.entries(FX.pix)) {
    const nside = Number(nsideStr);
    for (let i = 0; i < ref.length; i++) {
      if (TIES.has(i)) continue;              // 面の角ちょうどは4画素の同点 (fixture の ties_note)
      const got = V.ang2pixNest(nside, FX.lon[i], FX.lat[i]);
      assert.equal(got, ref[i],
        `nside=${nside} lon=${FX.lon[i]} lat=${FX.lat[i]}: ${got} != ${ref[i]}`);
      checked++;
    }
  }
  assert.ok(checked > 7000, `検証点が少なすぎる: ${checked}`);
});

test("ang2pixNest: 極と RA=0/360 の境界でも基準値と一致", () => {
  // fixture には |dec|>89° と RA=0/360 近傍を明示的に入れてある。そこだけ抜いて再確認する。
  const idx = [];
  for (let i = 0; i < FX.lat.length; i++) {
    if (TIES.has(i)) continue;
    const nearPole = Math.abs(FX.lat[i]) > 89;
    const nearRa0 = FX.lon[i] < 1e-3 || FX.lon[i] > 360 - 1e-3;
    if (nearPole || nearRa0) idx.push(i);
  }
  assert.ok(idx.length >= 8, `端の点が足りない: ${idx.length}`);
  for (const nsideStr of Object.keys(FX.pix)) {
    const nside = Number(nsideStr);
    for (const i of idx) {
      assert.equal(V.ang2pixNest(nside, FX.lon[i], FX.lat[i]), FX.pix[nsideStr][i],
        `端 nside=${nside} lon=${FX.lon[i]} lat=${FX.lat[i]}`);
    }
  }
});

test("ang2pixNest: pix は 0..12*nside^2-1 に収まる", () => {
  for (const nside of [16, 64, 128, 256]) {
    const max = 12 * nside * nside;
    for (let i = 0; i < FX.lon.length; i++) {
      const p = V.ang2pixNest(nside, FX.lon[i], FX.lat[i]);
      assert.ok(Number.isInteger(p) && p >= 0 && p < max, `nside=${nside} pix=${p}`);
    }
  }
});

/* ---- 実ビルドがあるときだけ動く突合 ----
   dist/stars_v1/ は git に入れない (全天で10GB級) ので、無ければ飛ばす。 */
const DIST = path.join(ROOT, "dist", "stars_v1");
const hasBuild = existsSync(path.join(DIST, "manifest.json"));

test("復号往復: Python が書いたタイルを JS が読み、位置と等級が量子化誤差内", { skip: !hasBuild }, () => {
  const m = JSON.parse(readFileSync(path.join(DIST, "manifest.json"), "utf8"));
  assert.equal(m.scheme, "healpix-nested");
  assert.equal(m.recordBytes, 6);
  assert.equal(m.headerBytes, 16);

  let tested = 0;
  for (const layer of m.layers) {
    const pixes = m.tiles[layer.id] || [];
    for (const pix of pixes.slice(0, 3)) {
      const f = path.join(DIST, layer.id, `${pix}.bin`);
      if (!existsSync(f)) continue;
      const b = readFileSync(f);
      const d = V.decodeStarTileV1(
        b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), layer, m);
      assert.ok(d.n > 0, `${layer.id}/${pix} が空`);

      for (let i = 0; i < d.n; i++) {
        // 等級は層の範囲に収まる (量子化の丸めぶんだけ緩める)
        assert.ok(d.mag[i] >= layer.magMin - 0.02 && d.mag[i] <= layer.magMax + 0.02,
          `${layer.id} mag=${d.mag[i]} が層 (${layer.magMin}, ${layer.magMax}] の外`);
        assert.ok(d.dec[i] >= -90.01 && d.dec[i] <= 90.01, `dec=${d.dec[i]}`);
        assert.ok(d.ra[i] >= -0.01 && d.ra[i] < 360.01, `ra=${d.ra[i]}`);
        assert.ok(d.col[i] >= m.colRange[0] - 0.03 && d.col[i] <= m.colRange[1] + 0.03);
      }
      // **タイルの中身がそのタイルの pix に属している** = Python の割り当てと JS の
      // ang2pix が一致している。これが崩れると星が「隣のタイル」に隠れる。
      for (let i = 0; i < Math.min(d.n, 500); i++) {
        assert.equal(V.ang2pixNest(layer.nside, d.ra[i], d.dec[i]), pix,
          `${layer.id}/${pix}: 星 ${i} (${d.ra[i]}, ${d.dec[i]}) が別の pix に落ちる`);
      }
      // 明るい順に並んでいる (クライアントが前から切るため)
      for (let i = 1; i < d.n; i++) {
        assert.ok(d.mag[i] >= d.mag[i - 1] - 1e-6, `${layer.id}/${pix} が明るい順でない`);
      }
      tested++;
    }
  }
  assert.ok(tested > 0, "検証できたタイルが無い");
});

test("被覆: pixelsForRegionV1 が円内の星の pix をすべて含む", { skip: !hasBuild }, () => {
  const m = JSON.parse(readFileSync(path.join(DIST, "manifest.json"), "utf8"));
  // 実データのある層で、タイル内の星を「円の中身」として使う
  const layer = m.layers.find((l) => (m.tiles[l.id] || []).length > 0);
  assert.ok(layer, "星のある層が無い");
  const pix = m.tiles[layer.id][0];
  const b = readFileSync(path.join(DIST, layer.id, `${pix}.bin`));
  const d = V.decodeStarTileV1(
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), layer, m);

  // タイルの中心付近から半径を変えて円を取り、円内の星が必ず拾えることを見る
  let rng = 12345;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < 200; t++) {
    const i = Math.floor(rand() * d.n);
    const cra = d.ra[i], cdec = d.dec[i];
    const radius = 0.02 + rand() * 0.3;
    const set = V.pixelsForRegionV1(layer.nside, cra, cdec, radius);
    // 円内にある星をすべて拾えているか
    const cosd = Math.cos(cdec * Math.PI / 180);
    for (let j = 0; j < d.n; j++) {
      let dra = ((d.ra[j] - cra + 540) % 360) - 180;
      const dd = d.dec[j] - cdec;
      if (Math.hypot(dra * cosd, dd) > radius) continue;
      assert.ok(set.has(V.ang2pixNest(layer.nside, d.ra[j], d.dec[j])),
        `半径 ${radius.toFixed(3)}° の円内の星 (${d.ra[j]}, ${d.dec[j]}) の pix を取りこぼした`);
    }
  }
});

test("被覆: 極をまたぐ円でも落ちない", () => {
  for (const nside of [16, 256]) {
    for (const dec of [89.9, -89.9, 90, -90]) {
      const s = V.pixelsForRegionV1(nside, 123.4, dec, 0.5);
      assert.ok(s.size > 0, `nside=${nside} dec=${dec} で空`);
      for (const p of s) assert.ok(p >= 0 && p < 12 * nside * nside);
    }
  }
});

test("被覆: 点数の上限を超えても返る (間隔を広げる)", () => {
  const s = V.pixelsForRegionV1(256, 10, 0, 20, 500);   // 広い円 × 細かい nside
  assert.ok(s.size > 0 && s.size < 200000, `異常な点数: ${s.size}`);
});
