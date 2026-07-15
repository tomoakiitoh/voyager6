#!/usr/bin/env python3
"""深い星表 (V<=10, 約33万星) のバイナリ・タイルを生成する (F2)。

    python3 tools/build_stars.py

全天図が読む埋め込み5等カタログ (src/data.js の STARS) はそのまま「ベース」。
望遠鏡モードで視野が狭まったとき、ここで作るタイルをクライアントが遅延ロードして
重ね描きする。埋め込みと重複しないよう mag>5.0 のみ収録する。

出力 (dist/stars/ 以下。build_site.py が dist を作り直すので、その後に実行すること):
  manifest.json                          … グリッド定義・等級層・存在するタイル
  {layer}/{band}_{cell}.bin              … タイルごとの星レコード (明るい順)

レコード形式 (10 byte, リトルエンディアン):
  ra   Float32  赤経 [度] (J2000)
  dec  Float32  赤緯 [度] (J2000)
  magQ Uint8    等級を (5,10] で量子化   mag = 5 + magQ/255*5
  bvQ  Uint8    B-V を [-0.5,2.5] で量子化 bv  = -0.5 + bvQ/255*3

タイル分割: 緯度を BAND_H=10° 幅の帯 (18本) に切り、各帯の RA を cos(dec) に比例した
数のセルに割る (ほぼ等面積 ~10°角)。狭視野では毎回数タイルだけ取得すればよい。
等級層: L0=(5,7], L1=(7,8.5], L2=(8.5,10]。視野が狭いほど深い層まで読む。

出典: AT-HYG v3.3 (astronexus/athyg, CC BY-SA 4.0)。サブセット athyg_33_reduced_m10。
"""

from __future__ import annotations

import csv
import gzip
import json
import math
import pathlib
import struct
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
CACHE = ROOT / "cache"
DIST = ROOT.parent / "dist"
OUTDIR = DIST / "stars"

SOURCE_NAME = "athyg_33_reduced_m10.csv.gz"
SOURCE_URL = ("https://codeberg.org/astronexus/athyg/media/branch/main/"
              "data/subsets/athyg_33_reduced_m10.csv.gz")

EMBED_MAG_MAX = 5.0   # 埋め込みカタログ (data.js) の上限。深層はこれより暗い星のみ
MAG_MAX = 10.0
BAND_H = 10.0         # 緯度帯の高さ [度]
LAYERS = [7.0, 8.5, 10.0]  # 各等級層の上限 (下限は前の層の上限 / L0 は EMBED_MAG_MAX)

MAG_LO, MAG_HI = 5.0, 10.0      # 等級量子化レンジ
BV_LO, BV_HI = -0.5, 2.5        # B-V 量子化レンジ

PM_THRESHOLD = 200.0  # 固有運動 [mas/yr]。これを超える星はタイルから外し highpm.json へ
                      # (日付に応じてクライアントが位置を前進させて描く。二重描画を避ける)


def n_bands() -> int:
    return round(180.0 / BAND_H)


def band_of(dec: float) -> int:
    """赤緯 [度] → 帯インデックス 0..n_bands-1。"""
    b = int((dec + 90.0) / BAND_H)
    return max(0, min(n_bands() - 1, b))


def n_ra(band: int) -> int:
    """帯 band の RA セル数 (cos(帯中央緯度) に比例、最低1)。"""
    mid = -90.0 + (band + 0.5) * BAND_H
    return max(1, round(360.0 * math.cos(math.radians(mid)) / BAND_H))


def cell_of(ra: float, band: int) -> int:
    """赤経 [度] → その帯での RA セル 0..n_ra-1。"""
    n = n_ra(band)
    c = int(ra / (360.0 / n))
    return max(0, min(n - 1, c))


def layer_of(mag: float) -> int:
    """等級 → 層インデックス (0..len(LAYERS)-1)。範囲外は -1。"""
    if mag <= EMBED_MAG_MAX or mag > MAG_MAX:
        return -1
    for i, hi in enumerate(LAYERS):
        if mag <= hi:
            return i
    return -1


def quant(v: float, lo: float, hi: float) -> int:
    q = round((v - lo) / (hi - lo) * 255)
    return max(0, min(255, q))


def fetch() -> pathlib.Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / SOURCE_NAME
    if path.exists() and path.stat().st_size > 0:
        print(f"  cached: {SOURCE_NAME} ({path.stat().st_size:,} bytes)")
        return path
    print(f"  download: {SOURCE_URL}")
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "voyager6-build"})
    with urllib.request.urlopen(req, timeout=600) as res, path.open("wb") as f:
        f.write(res.read())
    print(f"    -> {SOURCE_NAME} ({path.stat().st_size:,} bytes)")
    return path


def main() -> int:
    path = fetch()

    # tiles[layer][tileKey] = [ (mag, ra, dec, bv), ... ]
    tiles: list[dict[str, list]] = [dict() for _ in LAYERS]
    highpm = []  # [ra, dec, pm_ra, pm_dec, mag, bv] 高固有運動星
    total = 0
    skipped_nomag = 0

    def fnum(row, key, default=0.0):
        try:
            return float(row[key])
        except (ValueError, KeyError, TypeError):
            return default

    with gzip.open(path, "rt", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            try:
                mag = float(row["mag"])
            except (ValueError, KeyError, TypeError):
                skipped_nomag += 1
                continue
            layer = layer_of(mag)
            if layer < 0:
                continue
            ra = float(row["ra"]) * 15.0 % 360.0   # AT-HYG の ra は「時」単位
            dec = float(row["dec"])
            bv = fnum(row, "ci", 0.6)
            pmra = fnum(row, "pm_ra")   # mas/yr (μα* = μα·cosδ, Gaia由来)
            pmdec = fnum(row, "pm_dec")
            if math.hypot(pmra, pmdec) > PM_THRESHOLD:
                # 高固有運動星はタイルから外し、日付連動で描くために別ファイルへ
                highpm.append([round(ra, 5), round(dec, 5), round(pmra, 1),
                               round(pmdec, 1), round(mag, 2), round(bv, 2)])
                total += 1
                continue
            band = band_of(dec)
            key = f"{band}_{cell_of(ra, band)}"
            tiles[layer].setdefault(key, []).append((mag, ra, dec, bv))
            total += 1

    if OUTDIR.exists():
        import shutil
        shutil.rmtree(OUTDIR)
    OUTDIR.mkdir(parents=True)

    manifest_tiles = []
    nfiles = 0
    nbytes = 0
    for layer, tdict in enumerate(tiles):
        (OUTDIR / str(layer)).mkdir()
        counts = {}
        for key, stars in tdict.items():
            stars.sort(key=lambda s: s[0])   # 明るい順 (クライアントが限界等級で早切りできる)
            buf = bytearray()
            for mag, ra, dec, bv in stars:
                buf += struct.pack("<ffBB", ra, dec,
                                   quant(mag, MAG_LO, MAG_HI), quant(bv, BV_LO, BV_HI))
            (OUTDIR / str(layer) / f"{key}.bin").write_bytes(buf)
            counts[key] = len(stars)
            nfiles += 1
            nbytes += len(buf)
        manifest_tiles.append(counts)

    manifest = {
        "version": 1,
        "source": "AT-HYG v3.3 (athyg_33_reduced_m10)",
        "license": "CC BY-SA 4.0",
        "embedMagMax": EMBED_MAG_MAX,
        "magRange": [MAG_LO, MAG_HI],
        "bvRange": [BV_LO, BV_HI],
        "recordBytes": 10,
        "bandH": BAND_H,
        "nBands": n_bands(),
        "nRa": [n_ra(b) for b in range(n_bands())],
        "layers": [{"id": i, "magMax": hi} for i, hi in enumerate(LAYERS)],
        "tiles": manifest_tiles,
    }
    manifest["highPmThreshold"] = PM_THRESHOLD
    manifest["highPmCount"] = len(highpm)
    (OUTDIR / "manifest.json").write_text(
        json.dumps(manifest, separators=(",", ":")), encoding="utf-8")

    # 高固有運動星 (日付連動でクライアントが位置を前進させる)
    highpm.sort(key=lambda s: s[4])  # 明るい順
    hp_path = OUTDIR / "highpm.json"
    hp_path.write_text(json.dumps(highpm, separators=(",", ":")), encoding="utf-8")

    per_layer = " / ".join(f"L{i}:{sum(c.values()):,}" for i, c in enumerate(manifest_tiles))
    print(f"  深層星: {total:,} 星 ({per_layer})  等級不明でスキップ {skipped_nomag:,}")
    print(f"  タイル: {nfiles:,} ファイル / {nbytes:,} bytes ({nbytes/1024/1024:.2f} MB)")
    print(f"  高固有運動星 (|μ|>{PM_THRESHOLD:.0f}mas/yr): {len(highpm):,} 個 "
          f"-> highpm.json ({hp_path.stat().st_size:,} bytes)")
    print(f"  出力: {OUTDIR.relative_to(ROOT.parent)}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
