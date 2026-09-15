/* 今夜の空の要約 (トップ下段・今夜ミニ計器・日替わり description)
 *
 * **ビルド (tools/tonight_digest.mjs) とブラウザで同じこのファイルを使う。**
 * ビルドは東京・その日の値を HTML に焼き (検索エンジンと AI が読む形)、ブラウザは
 * 開いた瞬間に保存済みの観測地・今日の日付で同じ関数を呼び直して差し替える。
 * 組み立てと文面をここ一か所に置くのは、焼いた HTML と画面の表示が**同じ骨格**であるため
 * (片方だけ文言を直すと、検索エンジンが見たものと利用者が見るものがずれる)。
 *
 * **新しい計算は書かない。** 数字はすべて /tonight/ と /calendar/ が使っている
 * sky.js / astro.js / events.js の関数そのもの。ここは並べて整形するだけ。
 * 依存: astro.js, sky.js, events.js, aerith.js (いずれも classic script のグローバル)。
 */

const TONIGHT_TZ_MIN = 9 * 60;                 // JST 固定 (サイト全体の方針)
const TONIGHT_WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const TONIGHT_COMET_MAG_LIMIT = 8.0;           // 双眼鏡で届く目安。これより暗い日は節ごと出さない
const TONIGHT_COMET_MAX = 3;

/** JST の日付文字列 "YYYY-MM-DD" → その日の 0:00 (JST) の絶対時刻 [ms]。 */
function tonightDayStart(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - TONIGHT_TZ_MIN * 60000;
}

/** いまの JST の日付 "YYYY-MM-DD"。 */
function tonightToday(nowMs = Date.now()) {
  return new Date(nowMs + TONIGHT_TZ_MIN * 60000).toISOString().slice(0, 10);
}

const tonightP2 = (n) => String(n).padStart(2, "0");

/**
 * 絶対時刻 → 分単位の ISO 文字列 (+09:00)。<time datetime> にそのまま入れる。
 * **分は切り捨て** — /tonight/ の表示 (hhmm) と同じ丸めにして、同じ夜が1分ずれて見えないようにする。
 */
function tonightIso(ms) {
  if (ms === null || ms === undefined) return null;
  const d = new Date(Math.floor(ms / 60000) * 60000 + TONIGHT_TZ_MIN * 60000);
  return `${d.toISOString().slice(0, 16)}+09:00`;
}

/** ISO (+09:00) → "HH:MM"。基準日の翌日にかかるものは /tonight/ と同じく「翌 HH:MM」。 */
function tonightHM(iso, baseYmd) {
  if (!iso) return "—";
  const s = iso.slice(11, 16);
  return iso.slice(0, 10) > baseYmd ? `翌 ${s}` : s;
}

/** 方位角 [度] → 8方位の日本語。 */
function tonightDir(az) {
  const names = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
  return names[Math.round(((az % 360) + 360) % 360 / 45) % 8];
}

/**
 * 今夜の空のデータ。/tonight/ と同じ関数を同じ引数で呼ぶ。
 * @param {string} ymd  JST の日付 "YYYY-MM-DD"
 * @param {{name:string, lat:number, lon:number}} site
 */
function tonightData(ymd, site) {
  const day = tonightDayStart(ymd);
  const next = day + 86400000;
  const { lat, lon } = site;

  const sun = riseSet("sun", day, lat, lon);
  const tw = twilightTimes(day, lat, lon);
  const nextTw = twilightTimes(next, lat, lon);
  const moon = riseSet("moon", day, lat, lon);
  const age = moonAge(day + 21 * 3600e3);          // /tonight/ と同じく「その日の宵 (21時)」の月齢

  const pw = planetWindows(day, lat, lon, 15);
  const planets = pw.planets.map((p) => {
    const jd = jdFromDate(new Date(p.bestMs));
    const pos = planetPosition(p.name, jd);
    const hz = eqToHorizon(pos.ra, pos.dec, jd, lat, lon, false);
    return {
      name: p.ja,
      dir: tonightDir(hz.az),                       // 見ごろの中心 (最高高度の瞬間) の方角
      from: tonightIso(p.spans[0][0]),
      to: tonightIso(p.spans[p.spans.length - 1][1]),
      mag: Math.round(p.mag * 10) / 10,
    };
  });

  return {
    date: ymd,
    weekday: TONIGHT_WEEKDAYS[new Date(day + TONIGHT_TZ_MIN * 60000).getUTCDay()],
    site: { name: site.name, lat, lon },
    sunset: tonightIso(sun.set),
    astroTwilightEnd: tonightIso(tw.astronomical.dusk),
    astroTwilightBegin: tonightIso(nextTw.astronomical.dawn),
    sunrise: tonightIso(riseSet("sun", next, lat, lon).rise),   // 翌朝の日の出 (/tonight/ と同じ)
    moonrise: tonightIso(moon.rise),
    moonset: tonightIso(moon.set),
    moonAge: Math.round(age.age * 10) / 10,
    moonPhaseName: moonPhaseName(age),
    planets,
    weekEvents: tonightWeekEvents(day, day + 7 * 86400000),
  };
}

/**
 * [from, to) の天文現象。/calendar/ と同じ関数・同じ見出しの作り方。
 * 月食の「見えるか」は観測地で変わるが、ここでは現象の名前だけを出す (詳細は /calendar/)。
 */
function tonightWeekEvents(from, to) {
  const items = [];
  for (const p of moonPhaseEvents(from, to)) items.push({ ms: p.ms, text: p.name });
  for (const e of planetEvents(from, to)) {
    items.push({ ms: e.ms, text: `${e.ja}が${e.label.split(" (")[0]}` });
  }
  const y0 = new Date(from + TONIGHT_TZ_MIN * 60000).getUTCFullYear();
  const y1 = new Date(to + TONIGHT_TZ_MIN * 60000).getUTCFullYear();
  for (let y = y0; y <= y1; y++) {                  // 年末年始をまたぐ週を取りこぼさない
    for (const m of meteorPeaks(y)) {
      if (m.peakMs >= from && m.peakMs < to) items.push({ ms: m.peakMs, text: `${m.name} 極大` });
    }
  }
  const eclipseMsOf = (e) => {
    const [yy, mo, d] = e[0].split("-").map(Number);
    const [hh, mm, ss] = e[1].split(":").map(Number);
    return Date.UTC(yy, mo - 1, d, hh, mm, ss);
  };
  for (const e of ECLIPSES_LUNAR) {
    const ms = eclipseMsOf(e);
    if (ms >= from && ms < to) items.push({ ms, text: `${e[2]}月食` });
  }
  for (const e of ECLIPSES_SOLAR) {
    const ms = eclipseMsOf(e);
    if (ms >= from && ms < to) items.push({ ms, text: `${e[2]}日食` });
  }
  return items
    .sort((a, b) => a.ms - b.ms)
    .map((it) => ({ date: tonightIso(it.ms), text: it.text, href: "/calendar/" }));
}

/**
 * 明るい彗星。早見盤の彗星レイヤと同じ軌道要素 (comets.json) と同じ光度式 (cometMagnitude)。
 * @param {Array} list  [[name,e,q,i,node,peri,tp,M1,K1], ...]
 * @param {number} ms   いつの明るさか (その夜の 21時を渡す)
 */
function tonightComets(list, ms) {
  if (!Array.isArray(list)) return [];
  const jd = jdFromDate(new Date(ms));
  const out = [];
  for (const c of list) {
    const M1 = c[7], K1 = c[8];
    if (!Number.isFinite(M1) || !Number.isFinite(K1)) continue;
    const el = { e: c[1], q: c[2], i: c[3], node: c[4], peri: c[5], tp: c[6] };
    const g = orbitalToRaDec(el, jd);
    if (!g || !Number.isFinite(g.r) || !Number.isFinite(g.delta)) continue;
    const mag = cometMagnitude(M1, K1, g.r, g.delta);
    if (!Number.isFinite(mag) || mag > TONIGHT_COMET_MAG_LIMIT) continue;
    const desig = String(c[0]).split(/\s*\(/)[0].replace(/^(\d+P)\/.*/, "$1").trim();
    out.push({
      name: c[0],
      desig,
      mag: Math.round(mag * 10) / 10,
      href: `/?target=${encodeURIComponent(desig)}&labels=mag&fov=5`,
      aerith: typeof aerithUrl === "function" ? aerithUrl(c[0]) : null,
    });
  }
  return out.sort((a, b) => a.mag - b.mag).slice(0, TONIGHT_COMET_MAX);
}

/** 「9月15日(火)」 */
function tonightDateJa(d) {
  return `${Number(d.date.slice(5, 7))}月${Number(d.date.slice(8, 10))}日(${d.weekday})`;
}

/**
 * 見ごろの惑星から一つ選ぶ (description と今夜ミニ計器用)。**夜に見えている時間がいちばん長いもの**。
 * 「いちばん明るい」で選ぶと、夜明け前に1時間だけ昇る木星が「今夜の見ごろ」になってしまう
 * (2026-09-15: 土星 20:00〜翌05:00 に対し 木星は 翌03:47〜)。同じ長さなら明るいほう。
 */
function tonightBestPlanet(d) {
  if (!d.planets.length) return null;
  const span = (p) => Date.parse(p.to) - Date.parse(p.from);
  return d.planets.reduce((a, b) => {
    const da = span(a), db = span(b);
    if (Math.abs(da - db) > 60000) return da > db ? a : b;
    return a.mag <= b.mag ? a : b;
  });
}

/** 日替わりの meta description。「9月15日(火)の東京: 日の入り17:52、月齢3、今夜は土星が見ごろ。…」 */
function tonightDescription(d) {
  const p = tonightBestPlanet(d);
  const parts = [];
  if (d.sunset) parts.push(`日の入り${tonightHM(d.sunset, d.date)}`);
  parts.push(`月齢${Math.round(d.moonAge)}`);
  parts.push(p ? `今夜は${p.name}が見ごろ` : "今夜は見ごろの惑星なし");
  return `${tonightDateJa(d)}の${d.site.name}: ${parts.join("、")}。開いた瞬間に今の空が出る星座早見`;
}

/**
 * データの href (サイト絶対 "/calendar/") を、トップから辿れる相対形 ("./calendar/") にする。
 * このサイトは file:// やサブディレクトリ配信でも動くよう参照を相対で書く方針なので、HTML にはこちらを出す。
 * (データ=JSON のほうは他所から読まれるので絶対形のまま)
 */
const tonightRel = (href) => (href.startsWith("/") ? `.${href}` : href);

const tonightEsc = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** 時刻の <time>。datetime は機械可読の ISO、表示は /tonight/ と同じ書式。 */
function tonightTime(iso, baseYmd) {
  return iso
    ? `<time datetime="${iso}">${tonightHM(iso, baseYmd)}</time>`
    : "—";
}

/**
 * B節 (今夜の空) の中身。観測地を変えたときにブラウザもこれで描き直す。
 * 見出し・行の順番・書式はここにしか無い。
 */
function tonightSkyHtml(d) {
  const b = d.date;
  const rows = [
    ["日の入り", tonightTime(d.sunset, b)],
    ["空が暗くなる（天文薄明の終わり）", tonightTime(d.astroTwilightEnd, b)],
    ["月の出", tonightTime(d.moonrise, b)],
    ["月の入り", tonightTime(d.moonset, b)],
    ["月齢", `${d.moonAge.toFixed(1)}（${tonightEsc(d.moonPhaseName)}）`],
    ["明るくなり始める（天文薄明の始まり）", tonightTime(d.astroTwilightBegin, b)],
    ["日の出", tonightTime(d.sunrise, b)],
  ];
  const planets = d.planets.length
    ? "<ul class=\"tonight-planets\">" + d.planets.map((p) =>
      `<li><b>${tonightEsc(p.name)}</b> — ${tonightEsc(p.dir)}の空、`
      + `${tonightTime(p.from, b)}〜${tonightTime(p.to, b)}（${p.mag.toFixed(1)}等）</li>`).join("")
      + "</ul>"
    : "<p>今夜は高度15°を超える惑星がありません。</p>";
  return `<h2>今夜の空 — ${tonightEsc(d.site.name)}・<time datetime="${d.date}">${tonightDateJa(d)}</time></h2>`
    + `<table class="tonight-table"><tbody>`
    + rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")
    + `</tbody></table>`
    + `<h3>今夜見ごろの惑星</h3>${planets}`
    + `<p class="tonight-more"><a href="${tonightRel("/tonight/")}">別の場所・日付で見る →</a></p>`;
}

/** C節 (この先1週間の天文現象)。 */
function tonightWeekHtml(d) {
  const body = d.weekEvents.length
    ? "<ul class=\"tonight-week\">" + d.weekEvents.map((e) => {
      const md = `${Number(e.date.slice(5, 7))}/${Number(e.date.slice(8, 10))}`;
      return `<li><time datetime="${e.date}">${md}</time> `
        + `<a href="${tonightRel(e.href)}">${tonightEsc(e.text)}</a></li>`;
    }).join("") + "</ul>"
    : "<p>この1週間に目立った現象はありません。</p>";
  return `<h2>この先1週間の天文現象</h2>${body}`;
}

/** D節 (いま見える彗星)。**0件なら空文字** — 節ごと出さない。 */
function tonightCometsHtml(comets) {
  if (!comets || !comets.length) return "";
  return "<h2>いま見える彗星</h2><ul class=\"tonight-comets\">"
    + comets.map((c) => `<li><a href="${tonightEsc(tonightRel(c.href))}">${tonightEsc(c.name)}</a>`
      + `（予報 ${c.mag.toFixed(1)}等）`
      + (c.aerith ? ` — <a href="${tonightEsc(c.aerith)}" rel="noopener">観測情報（aerith.net）</a>` : "")
      + "</li>").join("")
    + "</ul><p class=\"dim\">予報等級は軌道要素と光度式からの目安で、実際の明るさは大きく外れることがあります。</p>";
}
