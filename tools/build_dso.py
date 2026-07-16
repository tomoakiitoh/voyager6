#!/usr/bin/env python3
"""OpenNGC から V≤12 の星雲・星団・銀河 (DSO) を抽出して src/dso.json を生成 (F5)。

    python3 tools/build_dso.py

静的データ (OpenNGC は頻繁には変わらない) なので生成物を src/ にコミットし、build_site
が dist へコピーする。彗星・小惑星のような cron 更新はしない。

出力 (JSON 配列、1件 = [赤経°, 赤緯°, 種別, 等級, 長径', 短径', 位置角°, 名前, 通称]):
  種別: galaxy / open(散開星団) / globular(球状星団) / nebula / other

出典: OpenNGC (mattiaverga/OpenNGC), CC-BY-SA-4.0。出典表記を data 先頭と about ページに。
"""

from __future__ import annotations

import csv
import io
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT.parent / "src" / "dso.json"
SOURCE_URL = "https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/NGC.csv"
MAG_LIMIT = 12.0

# OpenNGC の Type コード → 描き分けの種別
TYPE_MAP = {
    "G": "galaxy", "GPair": "galaxy", "GTrpl": "galaxy", "GGroup": "galaxy",
    "OCl": "open", "GCl": "globular",
    "PN": "nebula", "Neb": "nebula", "RfN": "nebula", "EmN": "nebula",
    "HII": "nebula", "SNR": "nebula", "Cl+N": "nebula",
    "*Ass": "open",
}
SKIP = {"Dup", "NonEx", "*", "**", "DarkNeb"}  # 描く対象でない


def hms_to_deg(s: str) -> float:
    h, m, sec = s.split(":")
    return (float(h) + float(m) / 60 + float(sec) / 3600) * 15.0


def dms_to_deg(s: str) -> float:
    sign = -1.0 if s.strip()[0] == "-" else 1.0
    d, m, sec = s.replace("+", "").replace("-", "").split(":")
    return sign * (float(d) + float(m) / 60 + float(sec) / 3600)


def fnum(s: str, default=None):
    s = (s or "").strip()
    if not s:
        return default
    try:
        return float(s)
    except ValueError:
        return default


def main() -> int:
    print(f"  download: {SOURCE_URL}")
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "voyager6-build"})
    with urllib.request.urlopen(req, timeout=120) as res:
        text = res.read().decode("utf-8")

    reader = csv.DictReader(io.StringIO(text), delimiter=";")
    out = []
    total = 0
    for row in reader:
        total += 1
        typ = (row.get("Type") or "").strip()
        if typ in SKIP:
            continue
        cat = TYPE_MAP.get(typ, "other")
        mag = fnum(row.get("V-Mag"))
        if mag is None:
            mag = fnum(row.get("B-Mag"))
        if mag is None or mag > MAG_LIMIT:
            continue
        try:
            ra = hms_to_deg(row["RA"])
            dec = dms_to_deg(row["Dec"])
        except (KeyError, ValueError, IndexError):
            continue
        maj = fnum(row.get("MajAx"), 0.0)
        minr = fnum(row.get("MinAx"), 0.0)
        pa = fnum(row.get("PosAng"), 0.0)
        name = (row.get("Name") or "").strip()
        m = (row.get("M") or "").strip()
        if m:
            name = f"M{int(m)}"           # メシエ番号があればそれを主名に
        common = (row.get("Common names") or "").split(",")[0].strip()
        out.append([round(ra, 4), round(dec, 4), cat, round(mag, 1),
                    round(maj or 0, 2), round(minr or 0, 2), round(pa or 0, 0),
                    name, common])

    if len(out) < 500:
        print(f"エラー: DSO が {len(out)} 件しか取れず異常。中止。", file=sys.stderr)
        return 1

    out.sort(key=lambda o: o[3])  # 明るい順
    kinds = {}
    for o in out:
        kinds[o[2]] = kinds.get(o[2], 0) + 1
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  DSO: {total:,} 個中 V≤{MAG_LIMIT} が {len(out)} 個 {kinds} "
          f"-> {OUT.relative_to(ROOT.parent)} ({OUT.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
