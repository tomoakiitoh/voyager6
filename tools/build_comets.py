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
  M1  全光度の絶対等級, K1 活動指数 (m = M1 + 5·log Δ + K1·log r)

軌道要素は MPC cometels (現行元期なので位置がよい)。ただし MPC の光度パラメータ (H,G) は
一部が明らかに誤り (例 10P は H=5.0 で 4等台に化ける) なので、光度 M1/K1 は JPL SBDB の
curated 値で上書きする (Horizons と一致。SBDB 要素は古い元期で位置が数度ずれるので要素には
使わない)。SBDB が引けない彗星は MPC の H,G のまま。
"""

from __future__ import annotations

import gzip
import io
import json
import math
import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT.parent / "src" / "comets.json"
SOURCE_URL = "https://www.minorplanetcenter.net/Extended_Files/cometels.json.gz"
SBDB_URL = "https://ssd-api.jpl.nasa.gov/sbdb_query.api"


def desig_key(s: str) -> str:
    """彗星の符号を照合キーに正規化 ('10P/Tempel'→'10P', 'C/1995 O1 (Hale-Bopp)'→'C/1995 O1')。"""
    s = s.strip()
    m = re.match(r"^(\d+[PDI])\b", s)
    if m:
        return m.group(1)
    m = re.match(r"^([CPXAI]/\d{4}\s+[A-Z]{1,2}\d*(?:-[A-Z])?)", s)
    if m:
        return re.sub(r"\s+", " ", m.group(1))
    return s.split(" (")[0].strip()


def fetch_sbdb_mags() -> dict[str, tuple[float, float]]:
    """JPL SBDB から彗星の M1/K1 を {符号キー: (M1,K1)} で得る。引けなければ空。"""
    try:
        url = f"{SBDB_URL}?fields=full_name,M1,K1&sb-kind=c"
        req = urllib.request.Request(url, headers={"User-Agent": "voyager6-build"})
        with urllib.request.urlopen(req, timeout=120) as res:
            d = json.load(res)
        out = {}
        for name, m1, k1 in d["data"]:
            if m1 in (None, ""):
                continue
            try:
                out[desig_key(name)] = (float(m1), float(k1) if k1 not in (None, "") else 8.0)
            except ValueError:
                continue
        return out
    except Exception as e:  # noqa: BLE001  SBDB が落ちていても MPC だけで続行する
        print(f"  ! SBDB 取得失敗 ({e})。MPC の光度パラメータを使う。", file=sys.stderr)
        return {}


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

    print(f"  download: {SBDB_URL} (光度パラメータ)")
    sbdb = fetch_sbdb_mags()

    out = []
    skipped = 0
    overridden = 0
    for c in data:
        try:
            e = float(c["e"])
            q = float(c["Perihelion_dist"])
            i = float(c["i"])
            node = float(c["Node"])
            peri = float(c["Peri"])
            tp = julian_day(int(c["Year_of_perihelion"]), int(c["Month_of_perihelion"]),
                            float(c["Day_of_perihelion"]))
            m1 = float(c["H"])   # MPC の "H"/"G" は不確かなので下で SBDB 値に上書きする
            k1 = float(c["G"])
        except (KeyError, ValueError, TypeError):
            skipped += 1
            continue
        name = str(c.get("Designation_and_name", "")).strip()
        sb = sbdb.get(desig_key(name))
        if sb:                       # JPL の curated な M1/K1 を優先 (Horizons と一致)
            m1, k1 = sb
            overridden += 1
        out.append([name, round(e, 6), round(q, 6), round(i, 4), round(node, 4),
                    round(peri, 4), round(tp, 4), round(m1, 2), round(k1, 2)])

    if len(out) < 100:  # 明らかに壊れている取得は採用しない (前回データを守る)
        print(f"エラー: 彗星が {len(out)} 件しか取れず異常。中止。", file=sys.stderr)
        return 1

    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print(f"  彗星: {len(out)} 件 (SBDB光度で上書き {overridden} / スキップ {skipped}) "
          f"-> {OUT.relative_to(ROOT.parent)} ({OUT.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
