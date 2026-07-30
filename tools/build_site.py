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
import json
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
DIST = ROOT / "dist"

SITE_NAME = "Voyager6"      # サイト名 (ヘッダに出る)
DOMAIN = "voyager6.net"     # GitHub Pages のカスタムドメイン (dist/CNAME に書き出す)

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
        ("perseids", "流星群"),
    ]),
    ("使う", [
        ("log", "観測記録シート"),
        ("ask", "AIに聞いてみる"),
        ("docs", "URLパラメータ仕様"),
        ("voyager6-manual.pdf", "マニュアル (PDF)"),
        ("credits", "出典とライセンス"),
    ]),
]

# dist/assets/ に置く共有ファイル (存在するものだけコピーする)
ASSETS = ["style.css", "astro.js", "render.js", "data.js", "sky.js", "sites.js",
          "events.js", "stars.js",
          "three.module.min.js", "OrbitControls.js",  # 太陽系3D (three.js) 用に vendoring
          "svgcanvas.esm.js",  # チャートSVG出力 (F8) 用に vendoring (MIT)
          "satellite.es.js",   # 人工衛星の SGP4 計算 (PLAN6 F1) 用に vendoring (MIT)
          "vrpanel.js",        # VR内の操作パネル (VRプラネタリウム / 地球周回3D で共有)
          "earth.jpg"]         # 地球周回3D (PLAN6 F4) の地球テクスチャ (NASA Blue Marble, PD)

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
    既存の配列JSONは触らず、各データの URL・出典・ライセンス・更新頻度・スキーマをまとめる。"""
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
        {"name": "satellites", "url": f"{origin}/satellites.json",
         "description": "明るい人工衛星の TLE (stations + visual, 約180機) / bright satellites (TLE)",
         "format": "JSON array of arrays", "fields": ["name", "norad_id", "tle_line1", "tle_line2", "std_mag"],
         "source": "CelesTrak (Dr. T.S. Kelso)", "license": "no restrictions (CelesTrak)", "cadence": "daily"},
        {"name": "satellites_starlink", "url": f"{origin}/satellites_starlink.json",
         "description": "Starlink 群の TLE (約1万機) / Starlink constellation (TLE)",
         "format": "JSON array of arrays", "fields": ["name", "norad_id", "tle_line1", "tle_line2"],
         "source": "CelesTrak (Dr. T.S. Kelso)", "license": "no restrictions (CelesTrak)", "cadence": "daily"},
        {"name": "variables_all", "url": f"{origin}/variables_all.json",
         "description": ("変光星の拡張カタログ (GCVS 5.1、V等級で最大10等以下) / "
                         "extended variable star catalogue. epoch is maximum for pulsating, "
                         "minimum for eclipsing binaries"),
         "format": "JSON array of arrays",
         "fields": ["name", "ra_deg", "dec_deg", "type", "mag_max", "mag_min", "period_days",
                    "epoch_JD_minus_2400000"],
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
    if not (SRC / "data.js").exists():
        print("エラー: src/data.js がない。先に build_data.py を実行すること。", file=sys.stderr)
        return 1

    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "assets").mkdir(parents=True)

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
                 "satellites.json", "satellites_starlink.json", "variables.json", "variables_all.json",
                 "dso.json", "coastlines.bin", "voyager6-manual.pdf",
                 "llms.txt", "llms_preview.txt"]:
        f = SRC / name
        if f.exists():
            shutil.copy2(f, DIST / name)

    write_data_index()   # AI/機械可読なデータ索引 (/data/index.json)

    layout = (SRC / "layout.html").read_text(encoding="utf-8")
    origin = f"https://{DOMAIN}"
    urls = []

    for page in sorted((SRC / "pages").glob("*.html")):
        meta, content = parse_page(page)
        stem = page.stem

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
            f'<script src="{root}assets/{s}"></script>'
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
        html = (layout
                .replace("{{title}}", f'{meta["title"]} | {SITE_NAME}'
                         if stem != "index" else f'{SITE_NAME} | {meta["title"]}')
                .replace("{{description}}", meta.get("description", ""))
                .replace("{{bodyclass}}", meta.get("bodyclass", ""))
                .replace("{{root}}", root)
                .replace("{{canonical}}", canonical)
                .replace("{{origin}}", origin)
                .replace("{{sitename}}", SITE_NAME)
                .replace("{{nav}}", nav)
                .replace("{{scripts}}", scripts)
                .replace("{{content}}", content.strip()))
        if unlisted:
            html = html.replace(
                "<head>", '<head>\n<meta name="robots" content="noindex,nofollow">', 1)
        out.write_text(html, encoding="utf-8")
        print(f"  {out.relative_to(ROOT)} ({out.stat().st_size:,} bytes)")

    # sitemap.xml / robots.txt
    sitemap = ['<?xml version="1.0" encoding="UTF-8"?>',
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for url in sorted(urls):
        sitemap.append(f"  <url><loc>{url}</loc></url>")
    sitemap.append("</urlset>")
    (DIST / "sitemap.xml").write_text("\n".join(sitemap) + "\n", encoding="utf-8")
    (DIST / "robots.txt").write_text(
        f"User-agent: *\nAllow: /\nSitemap: {origin}/sitemap.xml\n", encoding="utf-8")

    total = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file())
    print(f"\ndist/ 合計 {total:,} bytes / {total/1024:.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
