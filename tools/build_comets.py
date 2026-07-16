#!/usr/bin/env python3
"""MPC の彗星軌道要素を取得して src/comets.json を生成する (F3)。

    python3 tools/build_comets.py

このデータは MPC の最新値なので、build(push) ではなく schedule(cron) 側で定期更新する。
生成物 src/comets.json はリポジトリにコミットしておき (= 前回データ)、cron が取得成功時
だけ更新してデプロイする。取得・検証に失敗したら前回のまま (サイトを壊さない)。

出力 (JSON 配列、1件 = [名前, e, q, i, Ω, ω, Tp(JD), M1, K1]):
  e   離心率
  q   近日点距離 [AU]
  i,Ω,ω  軌道傾斜・昇交点黄経・近日点引数 [度] (J2000 黄道)
  Tp  近日点通過 [JD, TT]
  M1  全光度の絶対等級, K1 活動指数 (m = M1 + 5·log Δ + 2.5·K1·log r)

出典: Minor Planet Center (IAU) の cometels。位置はクライアントで都度計算する。
"""

from __future__ import annotations

import gzip
import io
import json
import math
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT.parent / "src" / "comets.json"
SOURCE_URL = "https://www.minorplanetcenter.net/Extended_Files/cometels.json.gz"


def julian_day(y: int, m: int, d: float) -> float:
    """暦日 (日は小数可) → ユリウス日。"""
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    return (math.floor(365.25 * (y + 4716)) + math.floor(30.6001 * (m + 1))
            + d + b - 1524.5)


def main() -> int:
    print(f"  download: {SOURCE_URL}")
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "voyager6-build"})
    with urllib.request.urlopen(req, timeout=120) as res:
        raw = res.read()
    data = json.load(gzip.GzipFile(fileobj=io.BytesIO(raw)))

    out = []
    skipped = 0
    for c in data:
        try:
            e = float(c["e"])
            q = float(c["Perihelion_dist"])
            i = float(c["i"])
            node = float(c["Node"])
            peri = float(c["Peri"])
            tp = julian_day(int(c["Year_of_perihelion"]), int(c["Month_of_perihelion"]),
                            float(c["Day_of_perihelion"]))
            m1 = float(c["H"])   # MPC の "H" は彗星では全光度 M1
            k1 = float(c["G"])   # "G" は活動指数 K1 (既定 4)
        except (KeyError, ValueError, TypeError):
            skipped += 1
            continue
        name = str(c.get("Designation_and_name", "")).strip()
        out.append([name, round(e, 6), round(q, 6), round(i, 4), round(node, 4),
                    round(peri, 4), round(tp, 4), round(m1, 2), round(k1, 2)])

    if len(out) < 100:  # 明らかに壊れている取得は採用しない (前回データを守る)
        print(f"エラー: 彗星が {len(out)} 件しか取れず異常。中止。", file=sys.stderr)
        return 1

    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print(f"  彗星: {len(out)} 件 (スキップ {skipped}) -> {OUT.relative_to(ROOT.parent)} "
          f"({OUT.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
