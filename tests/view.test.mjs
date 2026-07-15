/**
 * F1: 一般化投影 projectView() のユニットテスト。
 *
 *   node --test tests/*.mjs
 *
 * 望遠鏡モードのズーム・パン・反転は projectView() に集約されている。
 * 最重要の回帰ガードは「既定ビュー (天頂中心・正立・pxPerDeg=R/90) で
 * 既存の project() と画素まで一致すること」。全天図の見た目を壊さない保証になる。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = (name) => readFileSync(path.join(ROOT, "src", name), "utf8");

const EXPORTS = ["project", "makeView", "projectView", "unprojectView",
  "rotateAToB", "eyepieceFov", "raDecToVec", "vecToRaDec", "applySky",
  "applySkyInverse", "skyMatrix", "applyProperMotion"];
const V = new Function(
  `${src("astro.js")}\n${src("render.js")}\nreturn {${EXPORTS.join(",")}};`
)();

/** 高度・方位 [度] → 地平成分 {e,n,u}。方位は北=0・東=90 の時計回り。 */
function hFromAltAz(altDeg, azDeg) {
  const alt = (altDeg * Math.PI) / 180, az = (azDeg * Math.PI) / 180;
  const ca = Math.cos(alt);
  return { e: ca * Math.sin(az), n: ca * Math.cos(az), u: Math.sin(alt) };
}

const CX = 300, CY = 300, R = 282;         // resize() 相当 (size=600, R=300-18)
const PPD = R / 90;                          // 全天図の pxPerDeg

/** 決定的な擬似乱数 (seed 固定・Math.random を使わない)。 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("projectView: 既定ビューは既存 project() と画素一致 (回帰ガード)", () => {
  const view = V.makeView(CX, CY, { pxPerDeg: PPD }); // 天頂中心・正立
  const rand = rng(12345);
  let n = 0;
  for (let i = 0; i < 2000; i++) {
    const alt = rand() * 90;                 // 地平線上のみ (u>0)
    const az = rand() * 360;
    const h = hFromAltAz(alt, az);
    const a = V.project(h, CX, CY, R);
    const b = V.projectView(h, view);
    assert.ok(Math.abs(a.x - b.x) < 1e-9, `x mismatch alt=${alt} az=${az}`);
    assert.ok(Math.abs(a.y - b.y) < 1e-9, `y mismatch alt=${alt} az=${az}`);
    n++;
  }
  assert.equal(n, 2000);
});

test("projectView: 天頂中心では東が左・北が上", () => {
  const view = V.makeView(CX, CY, { pxPerDeg: PPD });
  const east = V.projectView(hFromAltAz(10, 90), view);   // 東
  const north = V.projectView(hFromAltAz(10, 0), view);   // 北
  const west = V.projectView(hFromAltAz(10, 270), view);  // 西
  const south = V.projectView(hFromAltAz(10, 180), view); // 南
  assert.ok(east.x < CX, "東は中心より左");
  assert.ok(west.x > CX, "西は中心より右");
  assert.ok(north.y < CY, "北は中心より上");
  assert.ok(south.y > CY, "南は中心より下");
});

test("projectView: 視野中心に置いた天体は画面中心へ", () => {
  const center = hFromAltAz(40, 120);        // 適当な方向を中心に
  const view = V.makeView(CX, CY, { center, pxPerDeg: 50 });
  const p = V.projectView(center, view);
  assert.ok(Math.abs(p.x - CX) < 1e-9);
  assert.ok(Math.abs(p.y - CY) < 1e-9);
  assert.ok(Math.abs(p.theta) < 1e-3); // acos は 1 付近で精度が落ちる。中心の x,y は厳密
});

test("projectView: 中心から1°離れた点は pxPerDeg だけ離れる (正距の等角スケール)", () => {
  const center = hFromAltAz(50, 200);
  const ppd = 37;
  const view = V.makeView(CX, CY, { center, pxPerDeg: ppd });
  // 中心を高度方向に +1° ずらした点
  const near = hFromAltAz(51, 200);
  const p = V.projectView(near, view);
  const d = Math.hypot(p.x - CX, p.y - CY);
  assert.ok(Math.abs(p.theta - 1) < 1e-6, `theta=${p.theta}`);
  assert.ok(Math.abs(d - ppd) < 1e-6, `d=${d}`);
});

test("projectView: 中心が水平方向なら高度が上がると画面上へ", () => {
  const center = hFromAltAz(20, 90);         // 東を向く
  const view = V.makeView(CX, CY, { center, pxPerDeg: 40 });
  const higher = V.projectView(hFromAltAz(25, 90), view); // 同方位で高い
  const lower = V.projectView(hFromAltAz(15, 90), view);
  assert.ok(higher.y < CY, "高いほうが画面上");
  assert.ok(lower.y > CY, "低いほうが画面下");
});

test("projectView: 鏡像は横反転・倒立は180°回転", () => {
  const center = hFromAltAz(45, 135);
  const base = { center, pxPerDeg: 30 };
  const up = V.makeView(CX, CY, { ...base, flip: "upright" });
  const mi = V.makeView(CX, CY, { ...base, flip: "mirror" });
  const inv = V.makeView(CX, CY, { ...base, flip: "inverted" });
  const h = hFromAltAz(48, 140);
  const a = V.projectView(h, up);
  const m = V.projectView(h, mi);
  const v = V.projectView(h, inv);
  // 鏡像: x は中心対称、y は同じ
  assert.ok(Math.abs((m.x - CX) + (a.x - CX)) < 1e-9, "鏡像は横反転");
  assert.ok(Math.abs(m.y - a.y) < 1e-9, "鏡像は縦そのまま");
  // 倒立: x も y も中心対称
  assert.ok(Math.abs((v.x - CX) + (a.x - CX)) < 1e-9, "倒立は横反転");
  assert.ok(Math.abs((v.y - CY) + (a.y - CY)) < 1e-9, "倒立は縦反転");
});

test("unprojectView: project → unproject で元の方向へ戻る (往復)", () => {
  const center = hFromAltAz(35, 210);
  const view = V.makeView(CX, CY, { center, pxPerDeg: 45, flip: "mirror" });
  const rand = rng(999);
  for (let i = 0; i < 500; i++) {
    // 中心付近の方向をランダムに作る (視野内)
    const dAlt = (rand() - 0.5) * 20, dAz = (rand() - 0.5) * 20;
    const h = hFromAltAz(35 + dAlt, 210 + dAz);
    const p = V.projectView(h, view);
    const back = V.unprojectView(p.x, p.y, view);
    const dot = h.e * back.e + h.n * back.n + h.u * back.u;
    assert.ok(dot > 1 - 1e-9, `round-trip mismatch dot=${dot}`);
  }
});

test("rotateAToB: a→b の回転で a は b に一致する", () => {
  const a = hFromAltAz(20, 80);
  const b = hFromAltAz(55, 300);
  const r = V.rotateAToB(a, a, b);
  const dot = r.e * b.e + r.n * b.n + r.u * b.u;
  assert.ok(dot > 1 - 1e-9, `dot=${dot}`);
});

test("rotateAToB: 再センタリング反復でカーソル下の空がカーソルへ収束", () => {
  // ズーム相当: pxPerDeg を上げても、掴んだ方向がカーソル位置へ戻ることを確認。
  // 「上=天頂固定」モデルなので roll のぶん一発では厳密一致しないが、数回の反復で収束する
  // (操作コードも同じ反復を使う)。
  let center = hFromAltAz(40, 100);
  const cursor = { x: CX + 60, y: CY - 40 };
  const v1 = V.makeView(CX, CY, { center, pxPerDeg: 30 });
  const grab = V.unprojectView(cursor.x, cursor.y, v1); // 掴んだ空
  for (let i = 0; i < 3; i++) {                          // ズームイン + 再センタリング反復
    const v = V.makeView(CX, CY, { center, pxPerDeg: 90 });
    const under = V.unprojectView(cursor.x, cursor.y, v);
    center = V.rotateAToB(center, under, grab);
  }
  const p = V.projectView(grab, V.makeView(CX, CY, { center, pxPerDeg: 90 }));
  assert.ok(Math.hypot(p.x - cursor.x, p.y - cursor.y) < 0.1, "掴んだ空がカーソルへ収束");
});

test("applySkyInverse: applySky の逆で RA/Dec が往復する", () => {
  const M = V.skyMatrix(2461237.0, 35.68, 139.77); // 適当な JD・東京
  const rand = rng(77);
  for (let i = 0; i < 300; i++) {
    const ra = rand() * 360, dec = (rand() - 0.5) * 160; // -80..80
    const v = V.raDecToVec(ra, dec);
    const h = V.applySky(M, v);
    const back = V.applySkyInverse(M, h);
    const [ra2, dec2] = V.vecToRaDec(back);
    // 角距離で比較 (RA の 0/360 境界を避ける)
    const d = v[0] * back[0] + v[1] * back[1] + v[2] * back[2];
    assert.ok(d > 1 - 1e-9, `round-trip dot=${d} ra=${ra} dec=${dec}`);
    assert.ok(Math.abs(dec2 - dec) < 1e-6, `dec ${dec2} vs ${dec}`);
  }
});

test("applyProperMotion: バーナード星の26年後の移動 (第一原理照合)", () => {
  // バーナード星 (最大の固有運動星) J2000
  const ra = 269.45207, dec = 4.69339;
  const pmRa = -798.71, pmDec = 10337.77;   // μα*・μδ [mas/yr]
  const years = 26.0;
  const MAS_TO_DEG = 1 / 3600 / 1000;

  const base = V.raDecToVec(ra, dec);
  const moved = V.applyProperMotion(ra, dec, pmRa, pmDec, years);
  const [ra2, dec2] = V.vecToRaDec(moved);

  // Dec の変化 ≈ μδ·years (北向きはそのまま座標変化)
  assert.ok(Math.abs((dec2 - dec) - pmDec * years * MAS_TO_DEG) < 5e-6,
    `Δdec=${(dec2 - dec).toFixed(6)} 期待 ${(pmDec * years * MAS_TO_DEG).toFixed(6)}`);
  // 天球上の総移動量 ≈ hypot(μα*,μδ)·years
  const sep = Math.acos(Math.max(-1, Math.min(1,
    base[0] * moved[0] + base[1] * moved[1] + base[2] * moved[2]))) * (180 / Math.PI) * 3600; // 秒角
  const expected = Math.hypot(pmRa, pmDec) * years / 1000; // 秒角
  assert.ok(Math.abs(sep - expected) < 0.5, `移動量 ${sep.toFixed(1)}″ 期待 ${expected.toFixed(1)}″`);
  // RA は南天でなければ μα*/cosδ ぶん動く
  assert.ok((ra2 - ra) < 0, "μα*<0 なので RA は減る");
});

test("applyProperMotion: 往復で元に戻る / years=0 は不動", () => {
  const ra = 100, dec = -30, pmRa = 500, pmDec = -1200;
  const fwd = V.applyProperMotion(ra, dec, pmRa, pmDec, 50);
  const [ra2, dec2] = V.vecToRaDec(fwd);
  const back = V.applyProperMotion(ra2, dec2, pmRa, pmDec, -50);
  const b0 = V.raDecToVec(ra, dec);
  const dot = b0[0] * back[0] + b0[1] * back[1] + b0[2] * back[2];
  assert.ok(dot > 1 - 1e-9, `往復 dot=${dot}`);
  const still = V.applyProperMotion(ra, dec, pmRa, pmDec, 0);
  assert.ok(Math.abs(still[0] - b0[0]) < 1e-12 && Math.abs(still[2] - b0[2]) < 1e-12);
});

test("eyepieceFov: 倍率と実視界", () => {
  // 焦点距離1200mm + アイピース25mm(見かけ52°) → 48倍・実視界 約1.08°
  const a = V.eyepieceFov(1200, 25, 52);
  assert.ok(Math.abs(a.mag - 48) < 1e-9);
  assert.ok(Math.abs(a.trueFov - 52 / 48) < 1e-9);
  // 焦点距離1200mm + アイピース8mm(見かけ68°) → 150倍・実視界 約0.45°
  const b = V.eyepieceFov(1200, 8, 68);
  assert.ok(Math.abs(b.mag - 150) < 1e-9);
  assert.ok(Math.abs(b.trueFov - 68 / 150) < 1e-9);
  // 短焦点鏡 400mm + 32mm(70°) → 12.5倍・実視界 5.6°(広視野)
  const c = V.eyepieceFov(400, 32, 70);
  assert.ok(Math.abs(c.mag - 12.5) < 1e-9);
  assert.ok(Math.abs(c.trueFov - 5.6) < 1e-9);
});

test("projectView: roll で視野中心まわりに回転する", () => {
  const center = hFromAltAz(50, 120);
  const P = hFromAltAz(52, 122);
  const v0 = V.makeView(CX, CY, { center, pxPerDeg: 40 });
  const vr = V.makeView(CX, CY, { center, pxPerDeg: 40, roll: Math.PI / 3 });
  const p0 = V.projectView(P, v0), pr = V.projectView(P, vr);
  const r0 = Math.hypot(p0.x - CX, p0.y - CY), rr = Math.hypot(pr.x - CX, pr.y - CY);
  assert.ok(Math.abs(r0 - rr) < 1e-6, "中心からの距離は不変");
  const a0 = Math.atan2(p0.y - CY, p0.x - CX), ar = Math.atan2(pr.y - CY, pr.x - CX);
  const d = Math.atan2(Math.sin(ar - a0), Math.cos(ar - a0));
  assert.ok(Math.abs(Math.abs(d) - Math.PI / 3) < 1e-6, `回転角 ${d}`);
});

test("viewBasis(upRef): 画面の上が指定した基準方向を向く (北を上=回転しないパンの土台)", () => {
  const center = hFromAltAz(20, 90); // 東を向く
  const north = { e: 0, n: 1, u: 0 };
  const v = V.makeView(CX, CY, { center, pxPerDeg: 40, upRef: north });
  const c = [center.e, center.n, center.u];
  const d = north.e * c[0] + north.n * c[1] + north.u * c[2];
  const t = [north.e - c[0] * d, north.n - c[1] * d, north.u - c[2] * d];
  const L = Math.hypot(t[0], t[1], t[2]);
  const dot = v.basis.up[0] * t[0] / L + v.basis.up[1] * t[1] / L + v.basis.up[2] * t[2] / L;
  assert.ok(dot > 1 - 1e-9, `up が北の接方向を向く dot=${dot}`);
});

test("projectView: 中心の裏側は behind=true", () => {
  const center = hFromAltAz(70, 0);
  const view = V.makeView(CX, CY, { center, pxPerDeg: 20 });
  const front = V.projectView(center, view);
  const back = V.projectView({ e: -center.e, n: -center.n, u: -center.u }, view);
  assert.equal(front.behind, false);
  assert.equal(back.behind, true);
  assert.ok(Math.abs(back.theta - 180) < 1e-6);
});
