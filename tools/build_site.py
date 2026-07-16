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

import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
DIST = ROOT / "dist"

SITE_NAME = "Voyager6"      # サイト名 (ヘッダに出る)
DOMAIN = "voyager6.net"     # GitHub Pages のカスタムドメイン (dist/CNAME に書き出す)

# ヘッダのナビ。(スラッグ, 表示名)。スラッグ "" はトップ。
# ページを増やしたらここに足す。ただしスマホ (390px) では 5項目でヘッダが埋まるので、
# これ以上増やすなら折り返しではなく別の入口を考えること
# (ヘッダを2段にすると早見盤の盤面の高さ計算が狂う)。
# /log/ (記録シート) はナビに入れず、流星群・今夜の空のページから導線を張っている。
NAV = [
    ("", "早見盤"),
    ("tonight", "今夜の空"),
    ("calendar", "カレンダー"),
    ("perseids", "流星群"),
    ("credits", "出典"),
]

# dist/assets/ に置く共有ファイル (存在するものだけコピーする)
ASSETS = ["style.css", "astro.js", "render.js", "data.js", "sky.js", "sites.js",
          "events.js", "stars.js"]

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

    # ルート直下に置くファイル (OGP 画像・favicon)
    for name in ["og.png", "favicon.svg"]:
        f = SRC / name
        if f.exists():
            shutil.copy2(f, DIST / name)

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
        if stem != "404":     # 404 はサイトマップに載せない
            urls.append(canonical)

        scripts = "\n".join(
            f'<script src="{root}assets/{s}"></script>'
            for s in meta.get("scripts", "").split()
        )
        here = "" if stem == "index" else stem
        nav = "\n".join(
            f'<a href="{root}{slug}{"/" if slug else ""}"'
            f'{" class=\"active\"" if slug == here else ""}>{label}</a>'
            for slug, label in NAV
        )
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
