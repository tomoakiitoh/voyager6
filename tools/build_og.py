#!/usr/bin/env python3
"""OGP 画像 (src/og.png) と favicon (src/favicon.svg) を作る。

    python3 tools/build_og.py

生成物はリポジトリにコミットして、そのまま dist/ に配る。
CI (Linux) では日本語フォントが入っていないので、画像の生成は手元でやる。
フォントを差し替えたり文言を変えたいときだけ、このスクリプトを回し直せばよい。

盤面には実際の星表 (src/data.js の STARS) を使い、夏の夜の東京の空を描く。
"""

from __future__ import annotations

import json
import math
import pathlib
import re
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

W, H = 1200, 630
BG = (5, 7, 13)
DISC = (10, 18, 38)

# 盤面に描く空: 2026-08-13 22:00 JST の東京 (夏の大三角が高い)
LAT, LON = 35.68, 139.77
JD = 2461266.041666  # 2026-08-13 13:00 UT

FONT_CANDIDATES = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]


def load_font(size: int):
    for path in FONT_CANDIDATES:
        if pathlib.Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    print("  ! 日本語フォントが見つからないので既定フォントで描く", file=sys.stderr)
    return ImageFont.load_default()


def load_stars():
    """src/data.js から STARS 配列を読む。"""
    text = (SRC / "data.js").read_text(encoding="utf-8")
    m = re.search(r"const STARS = (\[.*?\]);", text, re.S)
    if not m:
        raise SystemExit("src/data.js に STARS が見つからない")
    body = re.sub(r",\s*\]", "]", m.group(1))  # 末尾のカンマを落とす
    return json.loads(body)


def horizon(ra, dec):
    """赤道座標 → 地平座標 (高度, 方位)。astro.js と同じ式の Python 版。"""
    d = math.radians
    T = (JD - 2451545.0) / 36525.0
    gmst = (280.46061837 + 360.98564736629 * (JD - 2451545.0)
            + 0.000387933 * T * T) % 360
    lst = math.radians((gmst + LON) % 360)
    ha = lst - d(ra)
    sin_alt = (math.sin(d(dec)) * math.sin(d(LAT))
               + math.cos(d(dec)) * math.cos(d(LAT)) * math.cos(ha))
    alt = math.asin(max(-1, min(1, sin_alt)))
    az = math.atan2(
        -math.cos(d(dec)) * math.sin(ha),
        math.sin(d(dec)) * math.cos(d(LAT))
        - math.cos(d(dec)) * math.sin(d(LAT)) * math.cos(ha),
    )
    return math.degrees(alt), math.degrees(az) % 360


def bv_color(bv):
    t = max(-0.3, min(1.6, bv))
    if t < 0.6:
        r, g, b = 0.72 + t * 0.42, 0.82 + t * 0.22, 1.0 - t * 0.15
    else:
        r, g, b = 1.0, 0.95 - (t - 0.6) * 0.2, 0.9 - (t - 0.6) * 0.3
    return tuple(int(255 * max(0, min(1, v))) for v in (r, g, b))


def main() -> int:
    stars = load_stars()
    img = Image.new("RGB", (W, H), BG)
    dr = ImageDraw.Draw(img)

    # 盤面は右寄せ。左側に文字を置く
    R = 280
    cx, cy = W - R - 60, H // 2
    dr.ellipse([cx - R, cy - R, cx + R, cy + R], fill=DISC, outline=(57, 69, 107))

    for ra, dec, mag, bv in stars:
        alt, az = horizon(ra, dec)
        if alt <= 0:
            continue
        r = R * (90 - alt) / 90
        a = math.radians(az)
        x = cx - r * math.sin(a)   # 東が左 (見上げた空)
        y = cy - r * math.cos(a)
        rad = max(0.6, (4.4 - 0.75 * mag) * (R / 320))
        dr.ellipse([x - rad, y - rad, x + rad, y + rad], fill=bv_color(bv))

    # 方位
    small = load_font(15)
    for label, az in [("北", 0), ("東", 90), ("南", 180), ("西", 270)]:
        a = math.radians(az)
        x = cx - (R + 20) * math.sin(a)
        y = cy - (R + 20) * math.cos(a)
        dr.text((x, y), label, font=small, fill=(140, 155, 190), anchor="mm")

    # タイトル
    dr.text((70, 232), "Voyager6", font=load_font(64), fill=(240, 245, 255))
    dr.text((72, 320), "今夜の空を、その場所で。", font=load_font(26), fill=(160, 180, 215))
    dr.text((72, 366), "星座早見・今夜の空・天文現象カレンダー",
            font=load_font(20), fill=(110, 130, 165))

    out = SRC / "og.png"
    img.save(out, optimize=True)
    print(f"OGP 画像: {out} ({out.stat().st_size:,} bytes)")

    # favicon: 夜空に星ひとつ (SVG なら軽くて拡大にも強い)
    favicon = SRC / "favicon.svg"
    favicon.write_text("""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="32" fill="#0a1226"/>
  <circle cx="32" cy="30" r="20" fill="none" stroke="#39456b" stroke-width="1.5"/>
  <circle cx="24" cy="22" r="2.6" fill="#eaf1ff"/>
  <circle cx="40" cy="27" r="2.0" fill="#cddcff"/>
  <circle cx="30" cy="38" r="1.6" fill="#ffd9b0"/>
  <circle cx="44" cy="40" r="1.2" fill="#cddcff"/>
  <circle cx="19" cy="35" r="1.2" fill="#eaf1ff"/>
</svg>
""", encoding="utf-8")
    print(f"favicon: {favicon}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
