#!/usr/bin/env node
/**
 * 今夜の空の要約を出す (Ver.1.1 トップ下段・日替わり description)。
 *
 *   node tools/tonight_digest.mjs                       # ビルド時の JST 日付・東京 → JSON
 *   node tools/tonight_digest.mjs --date 2026-09-15     # 任意の日 (テスト・検証用)
 *   node tools/tonight_digest.mjs --emit build          # build_site.py 用 {data, html, description}
 *   node tools/tonight_digest.mjs --emit fallback       # Node の無い環境向けの同梱断片を作り直す
 *
 * 計算も文面も src/tonight.js にある (ブラウザと共有)。ここはファイルを読んで渡すだけ。
 * src/*.js はブラウザ用の classic script なので、tests/ と同じく連結して new Function で評価する。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = (name) => readFileSync(path.join(ROOT, "src", name), "utf8");

const T = new Function(
  ["astro.js", "sky.js", "events.js", "sites.js", "aerith.js", "tonight.js"].map(src).join("\n")
  + "\nreturn { DEFAULT_SITE, tonightToday, tonightDayStart, tonightData, tonightComets,"
  + " tonightDescription, tonightSkyHtml, tonightWeekHtml, tonightCometsHtml, tonightBestPlanet, tonightHM };",
)();

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * 彗星の軌道要素。**早見盤の彗星レイヤと同じ comets.json (MPC の現行)**、無ければ comets_all.json。
 * 指示書は comets_notable.json を挙げていたが、あれは歴史的な肉眼彗星14個の監修リストで
 * (池谷・関1965 など)、M1/K1 も持たない。「いま見える彗星」を出すには現行の要素が要る。
 */
function loadCometList() {
  for (const name of ["comets.json", "comets_all.json"]) {
    const p = path.join(ROOT, "src", name);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  return [];
}

/** 日付・場所を決めて、データ一式を作る。 */
export function buildDigest(ymd = T.tonightToday(), site = T.DEFAULT_SITE) {
  const data = T.tonightData(ymd, site);
  // 明るさは「その夜の21時」で見る (/tonight/ の月齢と同じ基準時刻)
  data.comets = T.tonightComets(loadCometList(), T.tonightDayStart(ymd) + 21 * 3600e3);
  return data;
}

/** 下段 B〜D の HTML 断片 (A・E・F は日付に依らないので index.html 側に静的に書く)。 */
export function digestHtml(d) {
  return `<div id="tonight-sky" data-date="${d.date}">${T.tonightSkyHtml(d)}</div>`
    + `<div id="tonight-week">${T.tonightWeekHtml(d)}</div>`
    + `<div id="tonight-comets">${T.tonightCometsHtml(d.comets)}</div>`;
}

export { T };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const ymd = arg("--date") ?? T.tonightToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    console.error(`--date は YYYY-MM-DD で指定してください (受け取った値: ${ymd})`);
    process.exit(2);
  }
  const d = buildDigest(ymd);
  const emit = arg("--emit");
  if (emit === "build") {
    process.stdout.write(JSON.stringify({
      data: d, html: digestHtml(d), description: T.tonightDescription(d),
    }));
  } else if (emit === "fallback") {
    process.stdout.write(
      `<!-- Node の無い環境でビルドしたときに使う前回の断片 (${d.date} 生成)。\n`
      + `     更新: node tools/tonight_digest.mjs --emit fallback > src/tonight_digest.fallback.html -->\n`
      + digestHtml(d) + "\n");
  } else {
    process.stdout.write(JSON.stringify(d, null, 2) + "\n");
  }
}
