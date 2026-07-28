#!/usr/bin/env python3
"""地球の海岸線を線画で描くためのデータを作る (地球周回3D の線画モード)。

    python3 tools/build_coastlines.py

出典: Natural Earth (public domain, 1:50m land)。TopoJSON 版を world-atlas から取得し、
デルタ符号化された arcs を復号して「線の並び」に直す。海岸線は変わらないので、
cron ではなく一度作って src/coastlines.bin に置く (作り直したいときだけ再実行)。

出力形式 (リトルエンディアン。緯度経度を 16bit に量子化):
  uint32  線の本数
  各線:  uint16 頂点数, 頂点数 × (uint16 lon, uint16 lat)
    lon = (経度+180)/360 * 65535,  lat = (緯度+90)/180 * 65535
    → 分解能 約0.0055° (経度で約600m)。地球儀の見た目には十分。
"""

from __future__ import annotations

import json
import pathlib
import struct
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
CACHE = ROOT / "cache"
OUT = ROOT.parent / "src" / "coastlines.bin"

SOURCE_NAME = "land-50m.json"
SOURCE_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/land-50m.json"
USER_AGENT = "Voyager6/1.0 (+https://voyager6.net/; astronomy star chart)"


def fetch() -> pathlib.Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / SOURCE_NAME
    if path.exists() and path.stat().st_size > 0:
        print(f"  cached: {SOURCE_NAME} ({path.stat().st_size:,} bytes)")
        return path
    print(f"  download: {SOURCE_URL}")
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": USER_AGENT})
    last = None
    for attempt in (1, 2):        # 失敗時のみ1回だけ再試行 (連打しない)
        try:
            with urllib.request.urlopen(req, timeout=120) as res, path.open("wb") as f:
                f.write(res.read())
            print(f"    -> {SOURCE_NAME} ({path.stat().st_size:,} bytes)")
            return path
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt == 1:
                print(f"  警告: 取得失敗 ({e})。20秒後に1回だけ再試行。", file=sys.stderr)
                time.sleep(20)
    raise last


def decode_arcs(topo: dict) -> list[list[tuple[float, float]]]:
    """TopoJSON の arcs (デルタ符号化＋量子化) を経度緯度の折れ線に戻す。"""
    t = topo["transform"]
    sx, sy = t["scale"]
    ox, oy = t["translate"]
    lines = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + ox, y * sy + oy))
        if len(pts) >= 2:
            lines.append(pts)
    return lines


def q16(v: float, lo: float, span: float) -> int:
    q = round((v - lo) / span * 65535)
    return max(0, min(65535, q))


def main() -> int:
    topo = json.loads(fetch().read_text(encoding="utf-8"))
    lines = decode_arcs(topo)

    buf = bytearray()
    buf += struct.pack("<I", len(lines))
    npts = 0
    for pts in lines:
        buf += struct.pack("<H", len(pts))
        for lon, lat in pts:
            buf += struct.pack("<HH", q16(lon, -180.0, 360.0), q16(lat, -90.0, 180.0))
            npts += 1
    OUT.write_bytes(buf)

    # 日本付近の頂点数 (形が分かる密度か確認するため)
    jp = sum(1 for pts in lines for lon, lat in pts if 128 <= lon <= 146 and 30 <= lat <= 46)
    print(f"src/coastlines.bin: {len(lines):,} 本 / {npts:,} 頂点 "
          f"({len(buf):,} bytes)  ※日本付近 {jp} 頂点")
    return 0


if __name__ == "__main__":
    sys.exit(main())
