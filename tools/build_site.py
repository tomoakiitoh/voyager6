#!/usr/bin/env python3
"""src/ の部品を結合して dist/ (公開物) を出力する。

    python3 tools/build_site.py

ページは src/pages/*.html。先頭の HTML コメントにメタ情報を書く:

    <!--
    title: 星座早見
    description: ページの説明
    scripts: astro.js render.js data.js   ← assets/ から読む共有スクリプト
    bodyclass: sky-page                   ← <body> に付けるクラス (省略可)
    -->

index.html は dist/index.html に、それ以外は dist/<名前>/index.html に出す
(= /tonight/ のような URL になる)。共有スクリプトと CSS は dist/assets/ にコピーする。
アセットの参照は相対パスなので、GitHub Pages のサブディレクトリ配信でも file:// でも動く。
"""

from __future__ import annotations

import datetime
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
DIST = ROOT / "dist"

SITE_NAME = "Voyager6"      # サイト名 (ヘッダに出る)
DOMAIN = "voyager6.net"     # GitHub Pages のカスタムドメイン (dist/CNAME に書き出す)
# cron 更新データを日次配信する VPS (データ配信VPS移設_設計_20260725.md)。
# 静的な土台は Pages のままで、ここは「より新しい方」を出すだけの補助。
# 取得先の既定は src/dataurl.js 側にも書いてある (画面はそちらを見る)。
DATA_ORIGIN = "https://data.voyager6.net"

# ヘッダのメニュー (UI整理 F2)。三つの動詞で束ねる。(スラッグ, 表示名)、"" はトップ。
# 横並びのナビは 5項目でスマホのヘッダが埋まり、ページが増えるたびに構造を作り直す羽目に
# なっていた。ここを一箇所のメニューにしたので、今後ページが増えても
# 「見る/調べる/使う」のどれかに足すだけでよく、トップの構造は変えなくて済む。
# スラッグに "." を含むものは実ファイル (PDF など) として扱い、末尾に "/" を付けない。
MENU = [
    ("見る", [
        ("", "早見盤"),
        ("solar", "太陽系3D"),
        ("earth", "地球周回3D"),
        ("planetarium", "VRプラネタリウム"),
    ]),
    ("調べる", [
        ("comets", "彗星カタログ"),
        ("asteroids", "小惑星カタログ"),
        ("variables", "変光星カタログ"),
        ("tonight", "今夜の空"),
        ("calendar", "天文現象カレンダー"),
        ("eclipses", "日食・月食カタログ"),
        ("perseids", "流星群"),
    ]),
    ("使う", [
        ("log", "観測記録シート"),
        ("ask", "AIに聞いてみる"),
        ("docs", "URLパラメータ仕様"),
        # マニュアル PDF はナビから外した (Ver.1.0)。docs と llms.txt に一本化し、
        # PDF の二重管理をやめる。**配信は続ける** — 住所は変えない原則。
        # 既に配ったリンクは生きたままで、docs の末尾から「旧版」として案内している。
        ("credits", "出典とライセンス"),
    ]),
]

# dist/assets/ に置く共有ファイル (存在するものだけコピーする)
ASSETS = ["style.css", "astro.js", "render.js", "data.js", "sky.js", "sites.js",
          "events.js", "stars.js",
          "eclipsemap.js",    # 食の地図 (等食分線・可視範囲)。/eclipses/ が使う
          "aerith.js",        # 彗星ごとの吉田誠一氏 (aerith.net) へのリンク生成
          "dataurl.js",       # cron更新データを VPS 優先で取る (失敗時は committed へ)
          "tonight.js",       # 今夜の空の要約 (トップ下段)。ビルドの tonight_digest.mjs と共有
          "three.module.min.js", "OrbitControls.js",  # 太陽系3D (three.js) 用に vendoring
          "svgcanvas.esm.js",  # チャートSVG出力 (F8) 用に vendoring (MIT)
          "satellite.es.js",   # 人工衛星の SGP4 計算 (PLAN6 F1) 用に vendoring (MIT)
          "vrpanel.js",        # VR内の操作パネル (三部作の3Dページで共有)
          "urlstate.js",       # 表示レイヤの ON/OFF を URL に載せる (同上)
          "earth.jpg",         # 地球周回3D (PLAN6 F4) の地球テクスチャ (NASA Blue Marble, PD)
          # 太陽系3Dの惑星テクスチャ (Solar System Scope, CC BY 4.0)。1024x512 に落として計約0.4MB。
          # 寄ったときだけ遅延ロードするので、開くだけの人には転送されない。
          "mercury.jpg", "venus.jpg", "mars.jpg", "jupiter.jpg",
          "saturn.jpg", "uranus.jpg", "neptune.jpg", "saturn_ring.png",
          "moon.jpg"]      # 地球周回3D の月 (同じく Solar System Scope, CC BY 4.0)

# ハガキ裏面の QR に載せた番号ショートパス /1 〜 /8。
# **印刷物は刷り直せないので、番号と行き先の対応表をここ一箇所に置く。**
# 行き先を変えたくなったらこの表だけを直せばよく、配ったハガキはそのまま使える。
# noindex + sitemap 非掲載 (同じ画面が二つの URL で検索に出るのを避ける)。
# llms.txt にも載せない — AI には短縮でなく意味のある長い URL を渡したい。
SHORTPATHS = {
    "1": "https://voyager6.net/",
    # comets=0: 彗星の点群を消すと、ボイジャーの航跡が一本の線としてはっきり読める
    "2": "https://voyager6.net/solar/?craft=voyager1&craftlayer=1&comets=0",
    "3": "https://voyager6.net/?t=1996-03-25T03:00&lat=35.68&lon=139.77&comet=C/1996%20B2",
    # 指示書は focus=jupiter 付きだったが外した。寄ると木星の周りしか映らず、
    # 太陽・内惑星のラベルが重なり、肝心のトロヤ群 (L4/L5の二つの塊) が画面外に出る。
    # 既定の俯瞰のままなら、木星を止めたときに小惑星が木星の前後60°へ溜まる様子が
    # 一目で分かる。※ 印刷物は変えられないので、こうした調整は飛び先側で吸収する。
    # asteroids2 (全量・GPU, H≤15 の83,443個) は 10,291個の小惑星レイヤの上位互換で、
    # 本体の帯とトロヤ群の二つの塊が桁違いに濃く出る。転送は 2.2MB。
    "4": "https://voyager6.net/solar/?corotate=1&asteroids2=1&comets=0",
    "5": "https://voyager6.net/?target=T%20CrB&labels=mag&names=on&fov=6",
    "6": "https://voyager6.net/solar/?group=kreutz&comet-orbits=1&comets=1",
    "7": "https://voyager6.net/variables/",
    "8": "https://voyager6.net/planetarium/",
}

SHORTPATH_HTML = """<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0; url={esc}">
<meta name="robots" content="noindex,nofollow">
<link rel="canonical" href="{esc}">
<script>location.replace({js});</script>
<title>voyager6.net</title></head>
<body style="background:#05070d;color:#c8d2e8;font-family:system-ui">
<p style="padding:2em">移動しています… <a href="{esc}" style="color:#6ea8ff">開かない場合はこちら</a></p>
</body></html>
"""


def write_shortpaths() -> None:
    """/1 〜 /8 の静的リダイレクトを出す。

    GitHub Pages はサーバ側のリダイレクトを書けないので、HTML で二段に受ける:
    meta refresh (JS が無効でも動く) と location.replace (履歴に残らないので
    「戻る」でリダイレクタに捕まらない)。"""
    for num, target in SHORTPATHS.items():
        out = DIST / num / "index.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        # 属性値では & を実体参照にする。<script> の中は HTML の実体参照が
        # 効かないので、そちらには生の URL を JSON 文字列として埋める。
        out.write_text(
            SHORTPATH_HTML.format(esc=target.replace("&", "&amp;"), js=json.dumps(target)),
            encoding="utf-8")
    print(f"  /1 〜 /{len(SHORTPATHS)} のショートパス ({len(SHORTPATHS)} 本, noindex)")


def asset_ver(name: str) -> str:
    """アセットの**中身**から作る短い版番号。<script src="…?v=">・<link href="…?v="> に付ける。

    GitHub Pages は HTML も JS も max-age=600 で配るので、配信直後の数分は
    「HTML だけ新しく、JS はキャッシュの古いもの」という組み合わせが起きうる。
    2026-09 に関数を sky.js へ移したとき、手元でこれが実際に起きて /tonight/ の月の表が空になった。
    日付ではなく中身のハッシュにするのは、**変わったファイルだけ**取り直させるため
    (日次ビルドのたびに全アセットを取り直させない)。"""
    p = SRC / name
    if not p.exists():
        return ""
    return hashlib.sha1(p.read_bytes()).hexdigest()[:8]


def tonight_digest() -> tuple[str, str | None, str | None]:
    """トップ下段「今夜の空」の HTML 断片・日替わり description・その日付を返す (Ver.1.1)。

    数字も文面も tools/tonight_digest.mjs → src/tonight.js (ブラウザと共有) が作る。
    Python で同じ計算を二重に書かないために Node を呼ぶ。CI には Node がある (tests が使う)。

    **Node が無い・失敗したときもビルドは止めない。** 同梱の前回断片
    (src/tonight_digest.fallback.html) を使い、description は各ページのメタのままにする。
    断片の中に日付を書いているので、古い日の値が残っても嘘にはならない
    (ブラウザは開いた瞬間に今日の値へ描き直す)。"""
    try:
        r = subprocess.run(
            ["node", str(ROOT / "tools" / "tonight_digest.mjs"), "--emit", "build"],
            capture_output=True, text=True, timeout=120, check=True)
        j = json.loads(r.stdout)
        print(f"  今夜の空の要約: {j['data']['date']} {j['data']['site']['name']} "
              f"(彗星 {len(j['data']['comets'])} 件)")
        return j["html"], j["description"], j["data"]["date"]
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired,
            json.JSONDecodeError, KeyError) as e:
        fb = SRC / "tonight_digest.fallback.html"
        print(f"  ! 今夜の空の要約を作れなかったので同梱の前回断片を使う ({type(e).__name__})",
              file=sys.stderr)
        return (fb.read_text(encoding="utf-8") if fb.exists() else ""), None, None


META_RE = re.compile(r"^<!--\s*\n(.*?)\n-->\s*\n", re.S)


def parse_page(path: pathlib.Path):
    """ページ先頭のメタコメントを読み、(メタ, 本文) を返す。"""
    text = path.read_text(encoding="utf-8")
    m = META_RE.match(text)
    if not m:
        raise SystemExit(f"エラー: {path} の先頭にメタコメントがない")
    meta = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    return meta, text[m.end():]


def write_data_index() -> None:
    """AI/機械可読なデータ索引 dist/data/index.json を書く (F9 AI可用性)。
    既存の配列JSONは触らず、各データの URL・出典・ライセンス・更新頻度・スキーマをまとめる。

    **ここは「機械が fetch できるデータセット」の目録**であって、機能の目録ではない。
    月の満ち欠け・日食・月食 (2026-08 実装) は配信するファイルを持たず、ブラウザ内の
    計算だけで出るので**載せない**。載せると「fetch できる URL」の一覧という索引の
    意味が濁る。URL の使い方は llms.txt と url_parameters_doc (/docs/) が受け持つ。"""
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    origin = f"https://{DOMAIN}"
    datasets = [
        {"name": "comets_all", "url": f"{origin}/comets_all.json",
         "description": "全既知彗星の軌道要素 / all known comets orbital elements",
         "format": "JSON array of arrays",
         "fields": ["name", "e", "q_AU", "i_deg", "node_deg", "peri_deg", "Tp_JD", "M1", "K1"],
         "source": "IAU Minor Planet Center + JPL Small-Body Database", "cadence": "weekly"},
        {"name": "comets_historic", "url": f"{origin}/comets_historic.json",
         "description": "歴史的な肉眼彗星の出現時元期の軌道要素 / famous naked-eye comets' apparition-epoch elements (Halley per-apparition 1910/1986/2061)",
         "format": "JSON array of arrays",
         "fields": ["name", "e", "q_AU", "i_deg", "node_deg", "peri_deg", "Tp_JD", "M1", "K1",
                    "draw_from_JD", "draw_to_JD", "name_ja"],
         "source": "JPL Small-Body Database + JPL Horizons", "cadence": "static"},
        {"name": "asteroids_catalog", "url": f"{origin}/asteroids_catalog.json",
         "description": "命名済み小惑星 / named asteroids", "format": "JSON array of arrays",
         "fields": ["number", "name", "designation", "class", "a_AU", "e", "i_deg",
                    "node_deg", "peri_deg", "M0_deg", "epoch_JD", "H_mag", "diameter_km"],
         "source": "JPL Small-Body Database", "cadence": "weekly"},
        {"name": "asteroids_neo", "url": f"{origin}/asteroids_neo.json",
         "description": "地球近傍小惑星 / near-Earth asteroids (same schema as asteroids_catalog)",
         "format": "JSON array of arrays", "source": "JPL Small-Body Database", "cadence": "weekly"},
        {"name": "dso", "url": f"{origin}/dso.json",
         "description": "星雲・星団・銀河 / deep-sky objects", "format": "JSON",
         "source": "OpenNGC", "cadence": "static"},
        # 衛星は VPS (data.voyager6.net) が最新を日次配信し、Pages 側は同内容のスナップショット。
        # `live_url` が新しさ優先、`url` が確実さ優先。両方 CORS 開放。
        {"name": "satellites", "url": f"{origin}/satellites.json",
         "live_url": f"{DATA_ORIGIN}/satellites.json",
         "description": ("明るい人工衛星の TLE (stations + visual, 約180機) / bright satellites (TLE). "
                         "live_url is updated daily on a dedicated host; url is a committed snapshot (fallback)."),
         "format": "JSON array of arrays", "fields": ["name", "norad_id", "tle_line1", "tle_line2", "std_mag"],
         "source": "CelesTrak (Dr. T.S. Kelso)", "license": "no restrictions (CelesTrak)", "cadence": "daily"},
        {"name": "satellites_geo", "url": f"{origin}/satellites_geo.json",
         "live_url": f"{DATA_ORIGIN}/satellites_geo.json",
         "description": "静止衛星の TLE (約570機) / geostationary satellites (TLE)",
         "format": "JSON array of arrays", "fields": ["name", "norad_id", "tle_line1", "tle_line2"],
         "source": "CelesTrak (Dr. T.S. Kelso)", "license": "no restrictions (CelesTrak)", "cadence": "daily"},
        {"name": "satellites_starlink", "url": f"{origin}/satellites_starlink.json",
         "live_url": f"{DATA_ORIGIN}/satellites_starlink.json",
         "description": "Starlink 群の TLE (約1万機) / Starlink constellation (TLE)",
         "format": "JSON array of arrays", "fields": ["name", "norad_id", "tle_line1", "tle_line2"],
         "source": "CelesTrak (Dr. T.S. Kelso)", "license": "no restrictions (CelesTrak)", "cadence": "daily"},
        {"name": "spacecraft", "url": f"{origin}/spacecraft.json",
         "description": ("各国の惑星探査機の飛行経路 / interplanetary spacecraft trajectories "
                         "(25 craft, NASA/JAXA/ESA/ISRO/CNSA). Positions are heliocentric "
                         "ecliptic J2000 in AU; interpolate linearly between samples "
                         "(adjacent samples are at most 45 days apart)."),
         "format": "JSON object",
         "fields": ["key", "name_ja", "name_en", "agency", "country_ja", "id", "launch",
                    "end", "status", "at", "traj_end", "from", "partial", "events",
                    "jd (TDB)", "xyz (AU, heliocentric ecliptic J2000)"],
         "source": "JPL Horizons (reconstructed trajectories)", "cadence": "a few times a year"},
        {"name": "variables_all", "url": f"{origin}/variables_all.json",
         "description": ("変光星の拡張カタログ (GCVS 5.1、V等級で最大10等以下) / "
                         "extended variable star catalogue. epoch is maximum for pulsating, "
                         "minimum for eclipsing binaries"),
         "format": "JSON array of arrays",
         "fields": ["name", "ra_deg", "dec_deg", "type", "mag_max", "mag_min", "period_days",
                    "epoch_JD_minus_2400000", "rise_time_percent"],
         "source": "GCVS 5.1 (Samus+)", "license": "academic use with attribution",
         "cadence": "static"},
        {"name": "variables", "url": f"{origin}/variables.json",
         "description": "著名な変光星 (観測星図むけ・23個の厳選版) / famous variable stars (curated)",
         "format": "JSON array of arrays",
         "fields": ["name", "ra_deg", "dec_deg", "type", "mag_max", "mag_min", "period_days", "note"],
         "source": "GCVS (Samus+)", "license": "academic use with attribution", "cadence": "static"},
    ]
    index = {
        "generated_at": now, "site": origin,
        "description": ("Machine-readable index of Voyager6 astronomical datasets. "
                        "Positions verified against JPL Horizons. CORS enabled (Access-Control-Allow-Origin: *)."),
        "license": "https://creativecommons.org/licenses/by-sa/4.0/",
        "sources": ["IAU Minor Planet Center", "JPL Small-Body Database", "AT-HYG", "d3-celestial", "OpenNGC"],
        "url_parameters_doc": f"{origin}/docs/", "llms_txt": f"{origin}/llms.txt",
        "datasets": datasets,
    }
    (DIST / "data").mkdir(parents=True, exist_ok=True)
    (DIST / "data" / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  data/index.json ({len(datasets)} datasets, generated_at {now})")


def main() -> int:
    # --channel next … Current チャネル (next.voyager6.net) 向けの出力。
    # 同じ src から作るが、**検索に出さない**・**どちらを見ているか画面で分かる**ようにする。
    # 無指定 (Stable = voyager6.net) のときの出力は1バイトも変えないこと。
    channel = ""
    if "--channel" in sys.argv:
        i = sys.argv.index("--channel")
        channel = sys.argv[i + 1] if i + 1 < len(sys.argv) else ""
        if channel != "next":
            print(f"エラー: --channel は next のみ (受け取った値: {channel!r})", file=sys.stderr)
            return 1

    if not (SRC / "data.js").exists():
        print("エラー: src/data.js がない。先に build_data.py を実行すること。", file=sys.stderr)
        return 1

    # dist は毎回作り直すが、**中で作るには重すぎるものは残す**。
    # stars_v1 (20等星図の深層タイル) は全天ビルドで 10GB 級・数時間かかり、
    # build_stars_v1.py が別に作る。ここで消すと、サイトを1回ビルドし直すたびに
    # 作り直しになってしまう。build_stars.py の dist/stars/ も同じ理由で残す。
    KEEP = {"stars", "stars_v1"}
    if DIST.exists():
        for child in DIST.iterdir():
            if child.name in KEEP:
                continue
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
    (DIST / "assets").mkdir(parents=True, exist_ok=True)

    for name in ASSETS:
        f = SRC / name
        if f.exists():
            shutil.copy2(f, DIST / "assets" / name)

    # GitHub Pages にカスタムドメインを教えるファイル
    (DIST / "CNAME").write_text(DOMAIN + "\n", encoding="utf-8")

    # ルート直下に置くファイル (OGP 画像・favicon・天体データ)。
    # comets.json / asteroids.json は cron が更新する最新データ (無ければスキップ)。
    for name in ["og.png", "favicon.svg", "comets.json", "comets_all.json", "comets_notable.json",
                 "comets_historic.json",
                 "asteroids.json", "asteroids_solar.json", "asteroids_tier2.bin",
                 "asteroids_catalog.json", "asteroids_neo.json", "asteroids_notable.json",
                 "satellites.json", "satellites_starlink.json", "satellites_geo.json",
                 "spacecraft.json",
                 "variables.json", "variables_all.json",
                 "dso.json", "coastlines.bin", "voyager6-manual.pdf",
                 "llms.txt", "llms_preview.txt"]:
        f = SRC / name
        if f.exists():
            shutil.copy2(f, DIST / name)

    write_data_index()    # AI/機械可読なデータ索引 (/data/index.json)
    write_shortpaths()    # ハガキQRの番号ショートパス (/1 〜 /8)

    layout = (SRC / "layout.html").read_text(encoding="utf-8")
    origin = f"https://{DOMAIN}"
    urls = []
    digest_html, digest_desc, digest_date = tonight_digest()

    for page in sorted((SRC / "pages").glob("*.html")):
        meta, content = parse_page(page)
        stem = page.stem
        if stem == "index":
            # トップだけ、今夜の空の断片を焼き込み、description を日替わりにする。
            # og:description も同じ {{description}} から出るので、SNS に貼られたときも今夜の文になる
            content = content.replace("{{tonight_digest}}", digest_html)
            if digest_desc:
                meta = {**meta, "description": digest_desc}

        if stem == "index":
            out = DIST / "index.html"
            root = ""            # dist/index.html から見た dist/ の位置
            canonical = f"{origin}/"
        elif stem == "404":
            # GitHub Pages は存在しない全URLに dist/404.html を返す。
            # どの階層で表示されるか分からないので、参照は絶対パスにする。
            out = DIST / "404.html"
            root = "/"
            canonical = f"{origin}/404.html"
        else:
            out = DIST / stem / "index.html"
            root = "../"
            canonical = f"{origin}/{stem}/"
        out.parent.mkdir(parents=True, exist_ok=True)
        # unlisted: true のページは「置いてあるが案内していない」状態にする。
        # sitemap に載せず noindex を付けるので、検索にもAIの巡回にも出てこない。
        # (メニューと llms.txt に載せないだけでは、sitemap 経由で拾われてしまう)
        unlisted = meta.get("unlisted", "").lower() in ("1", "true", "yes")
        if stem != "404" and not unlisted:     # 404 はサイトマップに載せない
            urls.append(canonical)

        scripts = "\n".join(
            f'<script src="{root}assets/{s}?v={asset_ver(s)}"></script>'
            for s in meta.get("scripts", "").split()
        )
        here = "" if stem == "index" else stem
        groups = []
        for gname, items in MENU:
            links = []
            for slug, label in items:
                if "." in slug:                       # PDF などの実ファイル
                    links.append(f'<a href="{root}{slug}">{label}</a>')
                    continue
                # トップは root が "" になるページ (dist/index.html) があるので "./" で補う
                href = f"{root}{slug}/" if slug else (root or "./")
                cls = ' class="active" aria-current="page"' if slug == here else ""
                links.append(f'<a href="{href}"{cls}>{label}</a>')
            groups.append(
                f'<div class="menu-group"><h2>{gname}</h2>{"".join(links)}</div>')
        nav = "".join(groups)

        # ---- トップだけ「上の一画面 (#screen) + その下の本文」に組む (Ver.1.1) ----
        # 盤面の寸法は #sky-wrap の大きさで決まるので、ヘッダ〜フッタを 100dvh の #screen に閉じ込め、
        # 下段 (#tonight) はその外に置いて body をスクロールさせる。他のページは3つとも空文字で、
        # **出力はバイト単位で変わらない** (プレースホルダを改行なしで置いてある)。
        screen_open = screen_close = after_screen = ""
        if stem == "index":
            screen_open, screen_close = '<div id="screen">', "</div><!-- /#screen -->"
            # 本文は「/screen」の印で二つに分ける。印より後 (下段・印刷エリア・スクリプト) は #screen の外。
            # 印刷エリアは必ず外に出すこと: @media print は body 直下の #print-area 以外を全部隠す。
            marker = "<!-- /screen -->"
            if marker in content:
                content, after_screen = content.split(marker, 1)
            # 案K: メニューは盤面左上の「≡」に入る (中身は他ページと同じ nav)
            content = content.replace("{{nav}}", nav)

        # fulltitle: があれば <title> と og:title をその文字列にする (トップの「今日の星空 — 星座早見 Voyager6」)。
        # 無いページは従来どおり「ページ名 | Voyager6」。
        title = meta.get("fulltitle") or (f'{meta["title"]} | {SITE_NAME}'
                                          if stem != "index" else f'{SITE_NAME} | {meta["title"]}')
        html = (layout
                .replace("{{title}}", title)
                .replace("{{description}}", meta.get("description", ""))
                .replace("{{bodyclass}}", meta.get("bodyclass", ""))
                .replace("{{root}}", root)
                .replace("{{canonical}}", canonical)
                .replace("{{origin}}", origin)
                .replace("{{style_ver}}", asset_ver("style.css"))
                .replace("{{sitename}}", SITE_NAME)
                .replace("{{nav}}", nav)
                .replace("{{scripts}}", scripts)
                .replace("{{screen_open}}", screen_open)
                .replace("{{screen_close}}", screen_close)
                .replace("{{after_screen}}", after_screen.strip())
                .replace("{{content}}", content.strip()))
        if stem == "index":
            # 案K: トップではヘッダ行を出さない (盤面を一行ぶん広げる)。ブランドは右下、メニューは左上の≡へ。
            # hidden で残すと同じ nav が二つになり id="menu" が重複するので、要素ごと出さない。
            html = re.sub(r'<header id="site-header">.*?</header>\s*', "", html, count=1, flags=re.S)
        if channel == "next":
            # Current チャネルは全ページ検索避け (VPS 側の X-Robots-Tag と二重に掛ける)。
            # unlisted のページは下の行で同じものが入るので、ここで入れたら重ねない。
            html = html.replace(
                "<head>", '<head>\n<meta name="robots" content="noindex, nofollow">', 1)
            # どちらのチャネルを見ているかが一目で分かる帯 (埋め込み・印刷・シネマでは出さない)
            html = html.replace(
                f'<body class="{meta.get("bodyclass", "")}">',
                f'<body class="{meta.get("bodyclass", "")}">\n<div id="channel-tag">next</div>', 1)
        elif unlisted:
            html = html.replace(
                "<head>", '<head>\n<meta name="robots" content="noindex,nofollow">', 1)
        out.write_text(html, encoding="utf-8")
        print(f"  {out.relative_to(ROOT)} ({out.stat().st_size:,} bytes)")

    # sitemap.xml / robots.txt
    sitemap = ['<?xml version="1.0" encoding="UTF-8"?>',
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    # トップは今夜の空が毎日焼き変わるので、lastmod で「毎日更新される」ことを伝える。
    # 他のページは内容が日々変わるわけではないので付けない (付けると lastmod 自体が信用されなくなる)。
    # 要約を作れず前回断片で済ませた日も付けない — 中身は変わっていないので。
    top_lastmod = digest_date
    for url in sorted(urls):
        if url == f"{origin}/" and top_lastmod:
            sitemap.append(f"  <url><loc>{url}</loc><lastmod>{top_lastmod}</lastmod></url>")
        else:
            sitemap.append(f"  <url><loc>{url}</loc></url>")
    sitemap.append("</urlset>")
    if channel == "next":
        # Current チャネルは検索に出さないので sitemap を置かない (nginx 側も /sitemap.xml は 404)。
        # robots.txt は**置いたうえで Disallow** にする: nginx の location が消えても
        # ファイル単体で拒否が効くようにしておく (検索避けは二重にする)。
        (DIST / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    else:
        (DIST / "sitemap.xml").write_text("\n".join(sitemap) + "\n", encoding="utf-8")
        (DIST / "robots.txt").write_text(
            f"User-agent: *\nAllow: /\nSitemap: {origin}/sitemap.xml\n", encoding="utf-8")

    total = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file())
    print(f"\ndist/ 合計 {total:,} bytes / {total/1024:.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
