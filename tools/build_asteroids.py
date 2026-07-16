#!/usr/bin/env python3
"""MPCORB(数字付き小惑星)から「今 V≤11」の小惑星を抽出して src/asteroids.json を生成 (F4)。

    python3 tools/build_asteroids.py [--date YYYY-MM-DD]

MPCORB 全量(140万)は配らない。cron 実行時点の等級を概算し V≤11 の数十〜数百個だけを
軌道要素で配信する。位置はクライアントが表示日時で都度計算する。四大 (Ceres/Pallas/Juno/
Vesta) は明るさによらず常時掲載。取得失敗時は書き換えないので前回データが残る。

出力 (JSON 配列、1件 = [名前, e, a, i, Ω, ω, M0, epoch(JD), H, G]):
  M0 は epoch(JD) 時点の平均近点角。H,G は IAU の等級パラメータ。

出典: Minor Planet Center (IAU) の MPCORB。位置・等級はクライアントで都度計算する。
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import math
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT.parent / "src" / "asteroids.json"
SOURCE_URL = "https://www.minorplanetcenter.net/iau/MPCORB/MPCORB.DAT.gz"

MAG_LIMIT = 11.0
H_PRESCREEN = 10.5   # これより暗い絶対等級は V≤11 に届かないので位置計算を省く
BIG_FOUR = {"00001", "00002", "00003", "00004"}  # Ceres/Pallas/Juno/Vesta は常時掲載

DEG = math.pi / 180


def julian_day(y: int, m: int, d: float) -> float:
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    return math.floor(365.25 * (y + 4716)) + math.floor(30.6001 * (m + 1)) + d + b - 1524.5


def unpack_epoch(s: str) -> float:
    """MPC のパックド元期 (例 K2669 = 2026-06-09) → JD。"""
    cent = {"I": 1800, "J": 1900, "K": 2000}[s[0]]
    year = cent + int(s[1:3])
    mon = "123456789ABC".index(s[3]) + 1
    day = "123456789ABCDEFGHIJKLMNOPQRSTUV".index(s[4]) + 1
    return julian_day(year, mon, day)


# ---- astro.js と同じ計算 (Meeus 太陽 J2000 / 楕円ケプラー / IAU H,G) ----

def sun_ecl_j2000(jd: float):
    T = (jd - 2451545) / 36525
    L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T
    M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T
    e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T
    C = ((1.914602 - 0.004817 * T - 0.000014 * T * T) * math.sin(M * DEG)
         + (0.019993 - 0.000101 * T) * math.sin(2 * M * DEG) + 0.000289 * math.sin(3 * M * DEG))
    nu = M + C
    R = 1.000001018 * (1 - e * e) / (1 + e * math.cos(nu * DEG))
    lon = L0 + C - 0.01397 * ((jd - 2451545) / 365.25)
    return R * math.cos(lon * DEG), R * math.sin(lon * DEG), 0.0, R


def helio(a, e, i, node, peri, M0, epoch, jd):
    n = 0.9856076686 / a ** 1.5
    M = math.radians((M0 + n * (jd - epoch)) % 360)
    E = M + e * math.sin(M) * (1 + e * math.cos(M))
    for _ in range(30):
        dE = (E - e * math.sin(E) - M) / (1 - e * math.cos(E))
        E -= dE
        if abs(dE) < 1e-10:
            break
    xv, yv = a * (math.cos(E) - e), a * math.sqrt(1 - e * e) * math.sin(E)
    v, r = math.atan2(yv, xv), math.hypot(xv, yv)
    u = (math.degrees(v) + peri) * DEG
    N, ir = node * DEG, i * DEG
    x = r * (math.cos(N) * math.cos(u) - math.sin(N) * math.sin(u) * math.cos(ir))
    y = r * (math.sin(N) * math.cos(u) + math.cos(N) * math.sin(u) * math.cos(ir))
    z = r * math.sin(u) * math.sin(ir)
    return x, y, z, r


def ast_mag(H, G, r, delta, rs):
    cosA = max(-1, min(1, (r * r + delta * delta - rs * rs) / (2 * r * delta)))
    alpha = math.acos(cosA)
    t = math.tan(alpha / 2)
    phi1 = math.exp(-3.33 * t ** 0.63)
    phi2 = math.exp(-1.87 * t ** 1.22)
    return H + 5 * math.log10(r * delta) - 2.5 * math.log10((1 - G) * phi1 + G * phi2)


def parse_line(line: str):
    """MPCORB 80桁行 → 要素 dict。数字付きでなければ None。"""
    des = line[0:7].strip()
    try:
        H = float(line[8:13])
        G = float(line[14:19])
        epoch = unpack_epoch(line[20:25].strip())
        M0 = float(line[26:35])
        peri = float(line[37:46])
        node = float(line[48:57])
        i = float(line[59:68])
        e = float(line[70:79])
        a = float(line[92:103])
    except (ValueError, KeyError, IndexError):
        return None
    name = line[166:194].strip() or des
    return {"des": des, "name": name, "e": e, "a": a, "i": i,
            "node": node, "peri": peri, "M0": M0, "epoch": epoch, "H": H, "G": G}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="基準日 YYYY-MM-DD (既定は今日 UT)")
    args = ap.parse_args()
    if args.date:
        y, m, d = map(int, args.date.split("-"))
        jd = julian_day(y, m, d)
    else:
        now = dt.datetime.now(dt.timezone.utc)
        jd = julian_day(now.year, now.month, now.day + now.hour / 24)

    print(f"  download: {SOURCE_URL} (基準JD {jd:.1f})")
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "voyager6-build"})
    sx, sy, sz, rs = sun_ecl_j2000(jd)

    out = []
    n_lines = 0
    with urllib.request.urlopen(req, timeout=300) as res:
        gz = gzip.GzipFile(fileobj=res)
        started = False
        for raw in gz:
            line = raw.decode("latin-1").rstrip("\n")
            if not started:
                if line.startswith("-----"):  # ヘッダ末尾の区切り
                    started = True
                continue
            if not line.strip():
                break  # 数字付きセクションの終わり (以降は仮符号天体)
            n_lines += 1
            el = parse_line(line)
            if el is None:
                continue
            is_big = el["des"] in BIG_FOUR
            if el["H"] > H_PRESCREEN and not is_big:
                continue  # 暗すぎて V≤11 に届かない
            x, y, z, r = helio(el["a"], el["e"], el["i"], el["node"], el["peri"],
                               el["M0"], el["epoch"], jd)
            delta = math.hypot(x + sx, y + sy, z + sz)
            mag = ast_mag(el["H"], el["G"], r, delta, rs)
            if mag <= MAG_LIMIT or is_big:
                out.append([el["name"], round(el["e"], 6), round(el["a"], 6),
                            round(el["i"], 4), round(el["node"], 4), round(el["peri"], 4),
                            round(el["M0"], 5), round(el["epoch"], 1),
                            round(el["H"], 2), round(el["G"], 2)])

    if n_lines < 1000:  # 取得が壊れている → 前回データを守る
        print(f"エラー: 数字付き小惑星が {n_lines} 行しか読めず異常。中止。", file=sys.stderr)
        return 1

    out.sort(key=lambda a: a[8])  # H 昇順 (明るい代表が先頭)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  小惑星: {n_lines:,} 個中 V≤{MAG_LIMIT} が {len(out)} 個 "
          f"-> {OUT.relative_to(ROOT.parent)} ({OUT.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
