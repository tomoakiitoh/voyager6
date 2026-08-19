/**
 * ハガキ裏面QRの番号ショートパス /1 〜 /8 の回帰ガード。
 *
 *   node --test tests/*.test.mjs
 *
 * **このテストがある理由**: 番号は紙に刷ってしまったので、後から番号の側を
 * 直すことができない。飛び先のページを消したりリネームしたりすると、
 * 配ったハガキがそのまま 404 になる。ページの整理は今後も起きるので、
 * 「/N の飛び先が実在すること」だけは機械に見張らせる。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const build = readFileSync(path.join(ROOT, "tools", "build_site.py"), "utf8");

/** build_site.py の SHORTPATHS を読む (Python の dict リテラルを素朴に拾う)。 */
function readShortpaths() {
  const body = build.match(/^SHORTPATHS = \{$(.*?)^\}$/ms);
  assert.ok(body, "build_site.py に SHORTPATHS が見つからない");
  const out = {};
  for (const m of body[1].matchAll(/^\s*"(\d+)":\s*"([^"]+)",/gm)) out[m[1]] = m[2];
  return out;
}

const SHORTPATHS = readShortpaths();

test("ショートパスは 1 から連番で 8 本ある", () => {
  assert.deepEqual(Object.keys(SHORTPATHS), ["1", "2", "3", "4", "5", "6", "7", "8"]);
});

test("飛び先はすべて voyager6.net の絶対URL", () => {
  for (const [n, url] of Object.entries(SHORTPATHS)) {
    assert.ok(url.startsWith("https://voyager6.net/"), `/${n} が絶対URLでない: ${url}`);
  }
});

test("飛び先のページが実在する (404 にならない)", () => {
  for (const [n, url] of Object.entries(SHORTPATHS)) {
    const slug = new URL(url).pathname.replace(/^\/|\/$/g, "");
    // "" はトップ = src/pages/index.html
    const page = path.join(ROOT, "src", "pages", `${slug || "index"}.html`);
    assert.ok(existsSync(page), `/${n} の飛び先 ${url} に対応する ${page} が無い`);
  }
});

test("飛び先のクエリキーは、そのページが実際に読むもの", () => {
  // urlstate.js 経由のレイヤ名は id から接頭辞を落としたもの。
  // ページ側のソースに現れない綴りを渡しても黙って無視されるだけなので、ここで気づけるようにする。
  for (const [n, url] of Object.entries(SHORTPATHS)) {
    const u = new URL(url);
    const slug = u.pathname.replace(/^\/|\/$/g, "") || "index";
    const src = readFileSync(path.join(ROOT, "src", "pages", `${slug}.html`), "utf8");
    for (const key of u.searchParams.keys()) {
      // get("key") で直接読むか、bindUrlState の id ("solar-orbits" など) として現れるか
      const ok = src.includes(`"${key}"`) || src.includes(`'${key}'`)
        || new RegExp(`id: "[a-z]+-${key}"`).test(src)
        || new RegExp(`key: "${key}"`).test(src);
      assert.ok(ok, `/${n} の ${key}= を ${slug}.html が読んでいない: ${url}`);
    }
  }
});
