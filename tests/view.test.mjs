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
  "rotateAToB", "raDecToVec", "applySky"];
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

test("projectView: 中心の裏側は behind=true", () => {
  const center = hFromAltAz(70, 0);
  const view = V.makeView(CX, CY, { center, pxPerDeg: 20 });
  const front = V.projectView(center, view);
  const back = V.projectView({ e: -center.e, n: -center.n, u: -center.u }, view);
  assert.equal(front.behind, false);
  assert.equal(back.behind, true);
  assert.ok(Math.abs(back.theta - 180) < 1e-6);
});
