/* 彗星ごとに吉田誠一氏の彗星カタログ (aerith.net) のページへリンクする。
   変光星カタログが星ごとに AAVSO VSP へリンクしているのと同じ扱い。
   リンクは本人の了承済み (2026-08 彗星会議)。

   ---- URL の規則 (2026-08-24 に実測して確定。指示書の想定とは違っていた) ----
   周期彗星   10P            → /comet/catalog/0010P/index-j.html   (番号を4桁ゼロ埋め + P)
   非周期彗星 C/1996 B2      → /comet/catalog/1996B2/1996B2-j.html (ディレクトリ名と同じファイル名)
   日本語版は周期・非周期とも -j 付き。英語版 (index.html / 1996B2.html) も併存する。

   ---- リンクを出さない条件 (実測にもとづく) ----
   - **1995年より前の非周期彗星**: 先方のカタログは1995年から。390件を確認したところ、
     1995年以降は 305/307 で頁があり、1995年より前は 0/83 だった。
     池谷・関(1965)・ウェスト(1975)・ベネット(1969) のような大彗星でも頁は無い。
   - **消滅彗星 (D)**: 85D/Boethin・3D/Biela とも404。番号があっても P でなければ出さない。
   - 例外として C/2002 C1 は 153P/Ikeya-Zhang として頁があるが、こちらのカタログも
     153P で収録しているので、周期彗星の規則で自然に当たる。

   ---- http である理由 ----
   aerith.net は https だと証明書エラーになり、http でしか開けない (2026-08-24 時点)。
   https:// で貼ると全員が証明書の警告画面に当たるので、実際に開ける http:// を使う。
   先方が https 化したらここを1行直せばよい。 */

const AERITH_BASE = "http://www.aerith.net/comet/catalog/";

/** 先方のカタログが始まる年。これより前の非周期彗星には頁が無い。 */
const AERITH_FROM_YEAR = 1995;

/**
 * 彗星の符号 → 吉田誠一氏のページ URL。頁が無いと分かっているものは null。
 * @param {string} desig 例 "10P/Tempel", "C/1996 B2 (Hyakutake)"
 * @returns {string|null}
 */
function aerithUrl(desig) {
  if (!desig) return null;
  const s = String(desig).split("(")[0].trim();

  // 周期彗星。番号つきでも D (消滅) は先方に頁が無いので P だけを見る
  const p = s.match(/^(\d+)P\b/);
  if (p) return `${AERITH_BASE}${String(p[1]).padStart(4, "0")}P/index-j.html`;

  // 仮符号。分裂核の枝 (-A, -B) は親の頁に送る
  const c = s.match(/^[CPXDA]\/\s*(\d{4})\s*([A-Z]{1,2}\d*)/);
  if (c && Number(c[1]) >= AERITH_FROM_YEAR) {
    const k = c[1] + c[2];
    return `${AERITH_BASE}${k}/${k}-j.html`;
  }
  return null;
}

/** 情報カードに挿す1行。頁が無い彗星では空文字を返すので、そのまま連結してよい。 */
function aerithLinkHtml(desig, cls) {
  const u = aerithUrl(desig);
  if (!u) return "";
  return `<a class="${cls || ""}" href="${u}" target="_blank" rel="noopener"`
       + ` title="吉田誠一氏の彗星カタログ。光度の実測・観測条件・過去の出現がまとまっています">`
       + `吉田誠一氏のページ</a>`;
}
