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
OUT = ROOT.parent / "src" / "asteroids.json"          # 望遠鏡モード用 (現在 V≤11)
OUT_SOLAR = ROOT.parent / "src" / "asteroids_solar.json"  # 太陽系3D用 (H≤12 の要素)
OUT_TIER2 = ROOT.parent / "src" / "asteroids_tier2.bin"   # 太陽系3D GPU全量用 (H≤15 バイナリ)
SOURCE_URL = "https://www.minorplanetcenter.net/iau/MPCORB/MPCORB.DAT.gz"

MAG_LIMIT = 11.0
H_PRESCREEN = 10.5   # これより暗い絶対等級は V≤11 に届かないので位置計算を省く
BIG_FOUR = {"00001", "00002", "00003", "00004"}  # Ceres/Pallas/Juno/Vesta は常時掲載
SOLAR_H_LIMIT = 12.0  # 太陽系3D用: この絶対等級以下の小惑星を要素だけ配信 (メインベルト俯瞰)
TIER2_H_LIMIT = 15.0  # GPU全量用: H≤15 の要素を Float32 バイナリで配信 (トロヤ群/ヒルダ群の雲)
J2000 = 2451545.0     # Tier2 の epoch はこの基準日からの相対日数で持つ (float32 精度対策)

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

    # 太陽系3D用 (SBDB, 確実)。MPCORB より先に出しておく。
    try:
        build_solar_asteroids()
    except Exception as e:  # noqa: BLE001
        print(f"  ! 3D用小惑星の取得失敗 ({e})。前回データを維持。", file=sys.stderr)

    # 太陽系3D GPU全量用 (SBDB H≤15, バイナリ)。取得失敗時は前回 .bin を維持。
    try:
        build_tier2_asteroids()
    except Exception as e:  # noqa: BLE001
        print(f"  ! Tier2小惑星の取得失敗 ({e})。前回データを維持。", file=sys.stderr)

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
    print(f"  小惑星(望遠鏡用): {n_lines:,} 個中 V≤{MAG_LIMIT} が {len(out)} 個 "
          f"({OUT.stat().st_size:,} bytes)")
    return 0


def build_solar_asteroids() -> None:
    """JPL SBDB から H≤12 の小惑星要素を asteroids_solar.json に出力 (太陽系3D俯瞰用)。
    MPCORB(93MB)より軽く確実。要素は SBDB の現行元期。"""
    import urllib.parse
    params = urllib.parse.urlencode({
        "fields": "a,e,i,w,om,ma,epoch,H", "sb-kind": "a",
        "sb-cdata": json.dumps({"AND": [f"H|LT|{SOLAR_H_LIMIT}"]}),
    })
    url = f"https://ssd-api.jpl.nasa.gov/sbdb_query.api?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": "voyager6-build"})
    with urllib.request.urlopen(req, timeout=180) as res:
        d = json.load(res)
    out = []
    for row in d.get("data", []):
        try:
            a, e, i, w, om, ma, ep, H = (float(x) for x in row)
        except (TypeError, ValueError):
            continue
        # [a, e, i, Ω(node), ω(peri), M0, epoch, H]
        out.append([round(a, 5), round(e, 6), round(i, 4), round(om, 4),
                    round(w, 4), round(ma, 5), round(ep, 1), round(H, 2)])
    if len(out) < 1000:
        raise RuntimeError(f"SBDB 小惑星が {len(out)} 個しか取れず異常")
    OUT_SOLAR.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"  小惑星(3D用): H≤{SOLAR_H_LIMIT} が {len(out):,} 個 (SBDB, {OUT_SOLAR.stat().st_size:,} bytes)")


def build_tier2_asteroids() -> None:
    """JPL SBDB から H≤15 の小惑星要素を Float32 バイナリ asteroids_tier2.bin に出力。

    太陽系3D の「全量表示 (GPU)」用。位置はクライアントの頂点シェーダで都度ケプラーを解く
    ので、要素だけを詰める。1件 = 7×float32 (little-endian):
        [a(AU), e, i(deg), Ω node(deg), ω peri(deg), M0(deg), epochRel(=epoch JD − J2000)]
    epoch を J2000 からの相対日数にするのは float32 の仮数24bit を近点角計算で使い切らない
    ため (絶対 JD の 245万を float32 に入れると 0.03 日ぶんの丸めが出る)。
    """
    import struct
    import urllib.parse
    params = urllib.parse.urlencode({
        "fields": "a,e,i,w,om,ma,epoch", "sb-kind": "a",
        "sb-cdata": json.dumps({"AND": [f"H|LT|{TIER2_H_LIMIT}"]}),
    })
    url = f"https://ssd-api.jpl.nasa.gov/sbdb_query.api?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": "voyager6-build"})
    with urllib.request.urlopen(req, timeout=300) as res:
        d = json.load(res)
    buf = bytearray()
    n = dropped = 0
    for row in d.get("data", []):
        try:
            a, e, i, w, om, ma, ep = (float(x) for x in row)
        except (TypeError, ValueError):
            continue
        if not (0.0 < a < 100.0) or e >= 0.99:
            dropped += 1  # 双曲線・準放物線・極端な遠方は俯瞰に不要 (巨大距離/NaN を避ける)
            continue
        buf += struct.pack("<7f", a, e, i, om, w, ma, ep - J2000)
        n += 1
    if n < 5000:
        raise RuntimeError(f"SBDB Tier2 小惑星が {n} 個しか取れず異常")
    OUT_TIER2.write_bytes(bytes(buf))
    print(f"  小惑星(Tier2/GPU): H≤{TIER2_H_LIMIT} が {n:,} 個 (除外 {dropped}) "
          f"(SBDB, {OUT_TIER2.stat().st_size:,} bytes)")


if __name__ == "__main__":
    sys.exit(main())
