#!/usr/bin/env python3
"""歴史的な肉眼彗星の「出現時元期の軌道要素」を取得して src/comets_historic.json を作る (PLAN5 F2)。

    python3 tools/build_comets_historic.py

現行の comets.json(MPC cometels)には過去の大彗星(百武1996 等)が無い。ここで JPL から
出現時の軌道要素を取り、早見盤・太陽系3Dが「その頃の空/軌道」を描けるようにする。
- 単一出現の長周期彗星(百武・ヘールボップ 等): JPL SBDB の要素(full-prec)＋光度 M1/K1。
- ハレー(1P)は周期彗星で出現ごとに要素が違うため、JPL Horizons の CAP(closest apparition)で
  1910/1986/2061 の各近日点エポックの接触要素を別レコードとして取得する。

出力 (JSON 配列、1件 = [name, e, q, i, Ω, ω, Tp(JD), M1, K1, 描画開始JD, 描画終了JD, 和名]):
  index 0..8 は comets.json と同じ(name,e,q,i,node,peri,tp,M1,K1)。
  index 9,10 は「この要素で描いてよい期間」(出現期±数年。長周期要素を遠い日時へ外挿しないため)。
出典: JPL Small-Body Database / JPL Horizons。
"""

from __future__ import annotations

import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT.parent / "src" / "comets_historic.json"
SBDB = "https://ssd-api.jpl.nasa.gov/sbdb.api"
HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
YR = 365.25

# 単一出現の肉眼彗星: (SBDB照会符号, 和名, 描画期間の半幅[年])
SINGLE = [
    ("C/1965 S1-A", "池谷・関", 4),
    ("C/1969 Y1", "ベネット", 4),
    ("C/1975 V1-A", "ウェスト", 4),
    ("C/1995 O1", "ヘール・ボップ", 6),
    ("C/1996 B2", "百武", 4),
    ("C/2002 C1", "池谷・張", 4),
    ("C/2006 P1", "マックノート", 4),
    ("C/2011 W3", "ラブジョイ", 4),
    ("C/2020 F3", "ネオワイズ", 4),
    ("C/2023 A3", "紫金山・ATLAS", 4),
]
# ハレーの各出現の近日点付近エポック(照会用。返る Tp が実際の近日点)
HALLEY = [(2418781.5, "1910"), (2446470.5, "1986"), (2474040.5, "2061")]


def _get(url: str) -> bytes:
    return urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": "voyager6-build"}), timeout=90).read()


def sbdb_lookup(sstr: str) -> dict:
    """SBDB から e,q,i,node,peri,tp(full-prec)と M1,K1 を得る。"""
    url = f"{SBDB}?" + urllib.parse.urlencode({"sstr": sstr, "phys-par": "true", "full-prec": "true"})
    d = json.loads(_get(url))
    el = {e["name"]: float(e["value"]) for e in d["orbit"]["elements"] if e.get("value") not in (None, "")}
    pp = {p["name"]: p["value"] for p in d.get("phys_par", [])}
    # M1/K1 が SBDB に無い/空の彗星は既定値(明るい彗星向け)。近日点付近でのみ描くので概略で可。
    m1 = float(pp["M1"]) if pp.get("M1") not in (None, "") else 5.0
    k1 = float(pp["K1"]) if pp.get("K1") not in (None, "") else 10.0
    return {"name": d["object"]["fullname"], "e": el["e"], "q": el["q"], "i": el["i"],
            "node": el["om"], "peri": el["w"], "tp": el["tp"], "M1": m1, "K1": k1}


def horizons_apparition(desig: str, jd: float) -> dict:
    """Horizons CAP(その時刻に最も近い出現)の接触軌道要素を得る。"""
    p = {"format": "text", "COMMAND": f"'DES={desig};CAP;'", "OBJ_DATA": "NO",
         "MAKE_EPHEM": "YES", "EPHEM_TYPE": "ELEMENTS", "CENTER": "'500@10'",
         "TLIST": f"'{jd}'", "OUT_UNITS": "AU-D"}
    txt = _get(f"{HORIZONS}?" + urllib.parse.urlencode(p)).decode("utf-8", "replace")
    m = re.search(r"\$\$SOE(.*?)\$\$EOE", txt, re.S)
    if not m:
        raise RuntimeError(f"Horizons: SOE が無い ({desig}@{jd})")
    b = m.group(1)
    g = lambda pat: float(re.search(pat, b).group(1))
    return {"e": g(r"EC=\s*([\d.E+-]+)"), "q": g(r"QR=\s*([\d.E+-]+)"),
            "i": g(r"IN=\s*([\d.E+-]+)"), "node": g(r"OM=\s*([\d.E+-]+)"),
            "peri": g(r"W\s*=\s*([\d.E+-]+)"), "tp": g(r"Tp=\s*([\d.E+-]+)")}


def rec(name, e, q, i, node, peri, tp, m1, k1, win_yr, ja):
    half = win_yr * YR
    return [name, round(e, 7), round(q, 6), round(i, 4), round(node, 4), round(peri, 4),
            round(tp, 4), round(m1, 2), round(k1, 2), round(tp - half, 1), round(tp + half, 1), ja]


def main() -> int:
    out = []

    print("  SBDB: 単一出現の肉眼彗星")
    for sstr, ja, win in SINGLE:
        try:
            d = sbdb_lookup(sstr)
        except Exception as ex:  # noqa: BLE001
            print(f"    ! {sstr} 失敗 ({ex})", file=sys.stderr)
            continue
        name = re.sub(r"\s+", " ", d["name"]).strip()
        out.append(rec(name, d["e"], d["q"], d["i"], d["node"], d["peri"], d["tp"],
                       d["M1"], d["K1"], win, ja))
        print(f"    {ja} ({name}) Tp={d['tp']:.1f} M1={d['M1']}")

    print("  Horizons: ハレー(1P)の出現別要素")
    hm = sbdb_lookup("1P")  # 光度パラメータは出現共通で使う
    for jd, year in HALLEY:
        try:
            h = horizons_apparition("1P", jd)
        except Exception as ex:  # noqa: BLE001
            print(f"    ! 1P {year} 失敗 ({ex})", file=sys.stderr)
            continue
        out.append(rec(f"1P/Halley ({year})", h["e"], h["q"], h["i"], h["node"], h["peri"],
                       h["tp"], hm["M1"], hm["K1"], 8, f"ハレー彗星（{year}）"))
        print(f"    ハレー {year}  Tp={h['tp']:.1f}")

    if len(out) < 8:
        print(f"エラー: {len(out)} 件しか取れず異常。中止(前回データ維持)。", file=sys.stderr)
        return 1
    out.sort(key=lambda r: r[6])  # 近日点通過順
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  comets_historic.json: {len(out)} 件 ({OUT.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
