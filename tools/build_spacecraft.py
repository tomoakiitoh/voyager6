#!/usr/bin/env python3
"""JPL Horizons から各国の惑星探査機の飛行経路を取得して src/spacecraft.json を生成する。

    python3 tools/build_spacecraft.py            # 全機
    python3 tools/build_spacecraft.py voyager1   # 1機だけ (デバッグ用)
    python3 tools/build_spacecraft.py --list     # 収録機の一覧と Horizons ID を表示

軌跡は打ち上げ後の実軌道 (Horizons の再構築軌道) なので、ビルド一回きりで原則不変。
現役機だけ「今日+1年」まで先を含むため、年に数回 (または半年に一度) 再実行すれば足りる。
cron は不要 (comets と違い毎日は変わらない)。

出力 (src/spacecraft.json):
  { "generated": "YYYY-MM-DD",
    "frame": "heliocentric ecliptic J2000, AU",
    "craft": [ {
      "key":     "voyager1",            … URL 用キー (?craft=voyager1)
      "name_ja": "ボイジャー1号", "name_en": "Voyager 1",
      "agency":  "NASA", "country_ja": "アメリカ",
      "id":      -31,                    … Horizons ID
      "launch":  "1977-09-05",
      "status":  "cruise"|"orbiting"|"ended",
      "at":      null|"jupiter"|…        … 滞在中の惑星 (小文字)。軌跡は到着で打ち切ってあるので、
                                           以後のマーカーは惑星の位置に重ねる
      "coasting":false,                  … true = 通信途絶後も飛び続けている (end で軌跡を切らない)
      "traj_end":null|"2004-07-01",      … 軌跡の打ち切り日 (= 到着日)。at と対
      "from":    "2009-01-27",           … 実際に取れた軌跡の開始日
      "partial": false,                  … true = 公開軌道が打ち上げに届いていない (要注記)
      "events":  [["1979-03-05","木星最接近"], …],
      "jd":      [2443392.5, …],         … TDB ユリウス日 (昇順)
      "xyz":     [[x,y,z], …]            … jd と同数。太陽中心・黄道 J2000・AU
    } ] }

軌跡点は Ramer–Douglas–Peucker (3D) で間引く。許容誤差 RDP_TOL_AU、ただし日付補間の
ために隣接点の時間差は MAX_GAP_DAYS 以下を保証する。1機あたりおおむね 200〜800 点。

軌道船 (Cassini/Juno 等) は到着後の太陽中心軌跡が惑星の軌道そのものになって煩いので、
traj_end (到着日) で打ち切る。クルーズ機・脱出機は終端 (ミッション終了 or 今日+1年) まで。

失敗した機体はスキップして続行し、最後にまとめて報告する (サイトを壊さない)。
"""

from __future__ import annotations

import datetime as dt
import json
import math
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT.parent / "src" / "spacecraft.json"
API = "https://ssd.jpl.nasa.gov/api/horizons.api"

RDP_TOL_AU = 0.004      # 間引き許容誤差 [AU] (外惑星スケールで見て破綻しない程度)
MAX_GAP_DAYS = 45.0     # 補間用に保証する最大時間間隔 [日]
STEP_TARGET = 4000      # Horizons へ頼む生データ点数の上限目安 (この後 RDP で削る)
SLEEP_SEC = 1.0         # リクエスト間隔 (行儀)

TODAY = dt.date.today()
HORIZON_FUTURE = (TODAY + dt.timedelta(days=366)).isoformat()   # 現役機の先読み上限


def C(key, name_ja, name_en, agency, country_ja, hid, launch, *,
      end=None, status="cruise", at=None, traj_end=None, coasting=False, events=()):
    """収録機 1 機の定義。end=None は現役。traj_end は軌跡の打ち切り日 (軌道船の到着日)。

    coasting=True は「**通信は途絶えたが、まだ飛んでいる**」機
    (パイオニア10/11・ユリシーズ・ドーン)。end で軌跡を切ってはいけない。
    切ると最後の交信地点で止まって見え、「パイオニアはまだ近い」という誤った印象になる
    (実際にはパイオニア10号は 2003年の82AU に対し、2026年には141AU まで来ている)。
    これらは弾道飛行なので Horizons が今後の位置も持っている。"""
    return dict(key=key, name_ja=name_ja, name_en=name_en, agency=agency,
                country_ja=country_ja, id=hid, launch=launch, end=end,
                status=status, at=at, traj_end=traj_end, coasting=coasting,
                events=list(events))


# 収録リスト (ID は 2026-08-01 に -31/-37/-5/-3/-156/-121/-28/-9901491 を実照会で確認。
# 他は Horizons 慣行 ID。取得失敗はスキップ報告されるので、間違っていれば起動時にわかる)
CRAFT = [
    # --- アメリカ (NASA) ---
    C("voyager1", "ボイジャー1号", "Voyager 1", "NASA", "アメリカ", -31, "1977-09-05",
      events=[["1979-03-05", "木星最接近"], ["1980-11-12", "土星最接近"],
              ["2012-08-25", "太陽圏界面を通過 (恒星間空間へ)"]]),
    C("voyager2", "ボイジャー2号", "Voyager 2", "NASA", "アメリカ", -32, "1977-08-20",
      events=[["1979-07-09", "木星最接近"], ["1981-08-25", "土星最接近"],
              ["1986-01-24", "天王星最接近"], ["1989-08-25", "海王星最接近"],
              ["2018-11-05", "太陽圏界面を通過"]]),
    C("pioneer10", "パイオニア10号", "Pioneer 10", "NASA", "アメリカ", -23, "1972-03-03",
      end="2003-01-23", status="ended", coasting=True, events=[["1973-12-04", "木星最接近 (史上初)"]]),
    C("pioneer11", "パイオニア11号", "Pioneer 11", "NASA", "アメリカ", -24, "1973-04-06",
      end="1995-09-30", status="ended", coasting=True,
      events=[["1974-12-03", "木星最接近"], ["1979-09-01", "土星最接近 (史上初)"]]),
    C("newhorizons", "ニューホライズンズ", "New Horizons", "NASA", "アメリカ", -98, "2006-01-19",
      events=[["2007-02-28", "木星スイングバイ"], ["2015-07-14", "冥王星最接近"],
              ["2019-01-01", "アロコス最接近"]]),
    C("cassini", "カッシーニ", "Cassini", "NASA/ESA", "アメリカ/欧州", -82, "1997-10-15",
      end="2017-09-15", status="ended", at="saturn", traj_end="2004-07-01",
      events=[["1998-04-26", "金星スイングバイ"], ["2000-12-30", "木星スイングバイ"],
              ["2004-07-01", "土星周回軌道に到着"], ["2017-09-15", "土星大気に突入 (グランドフィナーレ)"]]),
    C("galileo", "ガリレオ", "Galileo", "NASA", "アメリカ", -77, "1989-10-18",
      end="2003-09-21", status="ended", at="jupiter", traj_end="1995-12-08",
      events=[["1995-12-08", "木星周回軌道に到着"], ["2003-09-21", "木星大気に突入"]]),
    C("juno", "ジュノー", "Juno", "NASA", "アメリカ", -61, "2011-08-05",
      status="orbiting", at="jupiter", traj_end="2016-07-05",
      events=[["2016-07-05", "木星周回軌道に到着"]]),
    C("parker", "パーカー・ソーラー・プローブ", "Parker Solar Probe", "NASA", "アメリカ", -96,
      "2018-08-12", events=[["2021-04-29", "太陽コロナ内を初通過"],
                            ["2024-12-24", "太陽最接近 (約610万km)"]]),
    C("dawn", "ドーン", "Dawn", "NASA", "アメリカ", -203, "2007-09-27",
      end="2018-11-01", status="ended", at=None, coasting=True,
      events=[["2011-07-16", "ベスタ周回軌道"], ["2015-03-06", "ケレス周回軌道"]]),
    C("osirisrex", "オサイリス・レックス", "OSIRIS-REx", "NASA", "アメリカ", -64, "2016-09-08",
      events=[["2018-12-03", "小惑星ベンヌ到着"], ["2023-09-24", "サンプルカプセル地球帰還"]]),
    C("lucy", "ルーシー", "Lucy", "NASA", "アメリカ", -49, "2021-10-16",
      events=[["2025-04-20", "小惑星ドナルドジョハンソン接近"]]),
    C("psyche", "サイキ", "Psyche", "NASA", "アメリカ", -255, "2023-10-13"),
    C("europaclipper", "エウロパ・クリッパー", "Europa Clipper", "NASA", "アメリカ", -159,
      "2024-10-14", events=[["2025-03-01", "火星スイングバイ"]]),
    # --- 日本 (JAXA) ---
    C("hayabusa", "はやぶさ", "Hayabusa", "JAXA", "日本", -130, "2003-05-09",
      end="2010-06-13", status="ended",
      events=[["2005-09-12", "小惑星イトカワ到着"], ["2010-06-13", "地球帰還 (サンプルリターン)"]]),
    C("hayabusa2", "はやぶさ2", "Hayabusa 2", "JAXA", "日本", -37, "2014-12-03",
      events=[["2018-06-27", "小惑星リュウグウ到着"], ["2019-02-22", "第1回タッチダウン"],
              ["2020-12-06", "カプセル地球帰還・拡張ミッションへ"]]),
    C("akatsuki", "あかつき", "Akatsuki", "JAXA", "日本", -5, "2010-05-21",
      end="2025-09-18", status="ended", at="venus", traj_end="2015-12-07",
      events=[["2010-12-07", "金星軌道投入失敗"], ["2015-12-07", "再挑戦で金星周回軌道に到着"]]),
    # --- 欧州 (ESA) ---
    C("rosetta", "ロゼッタ", "Rosetta", "ESA", "欧州", -226, "2004-03-02",
      end="2016-09-30", status="ended",
      events=[["2014-08-06", "チュリュモフ・ゲラシメンコ彗星に到着"],
              ["2014-11-12", "フィラエ着陸"], ["2016-09-30", "彗星に着地しミッション終了"]]),
    C("juice", "ジュース", "JUICE", "ESA", "欧州", -28, "2023-04-14",
      events=[["2024-08-20", "月・地球スイングバイ"], ["2025-08-31", "金星スイングバイ"]]),
    C("solarorbiter", "ソーラー・オービター", "Solar Orbiter", "ESA/NASA", "欧州", -144,
      "2020-02-10"),
    C("ulysses", "ユリシーズ", "Ulysses", "ESA/NASA", "欧州", -55, "1990-10-06",
      end="2009-06-30", status="ended", coasting=True,
      events=[["1992-02-08", "木星スイングバイで黄道面を離脱"]]),
    C("bepicolombo", "ベピコロンボ", "BepiColombo", "ESA/JAXA", "欧州/日本", -121, "2018-10-20",
      events=[["2020-04-10", "地球スイングバイ"], ["2025-01-08", "第6回水星スイングバイ"]]),
    # --- インド (ISRO) ---
    C("mom", "マンガルヤーン", "Mars Orbiter Mission", "ISRO", "インド", -3, "2013-11-05",
      end="2022-10-02", status="ended", at="mars", traj_end="2014-09-24",
      events=[["2014-09-24", "火星周回軌道に到着 (アジア初)"]]),
    C("adityal1", "アディティヤL1", "Aditya-L1", "ISRO", "インド", -156, "2023-09-02",
      events=[["2024-01-06", "太陽・地球 L1 点ハロー軌道に到着"]]),
    # --- 中国 (CNSA) ---
    C("tianwen1", "天問1号", "Tianwen-1", "CNSA", "中国", -9901491, "2020-07-23",
      status="orbiting", at="mars", traj_end="2021-02-10",
      events=[["2021-02-10", "火星周回軌道に到着"], ["2021-05-14", "祝融ローバー着陸"]]),
]


def fetch(hid: int, start: str, stop: str, step: str) -> str:
    """Horizons ベクトルテーブル (CSV) を文字列で返す。"""
    q = {
        "format": "text", "COMMAND": f"'{hid}'", "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'", "EPHEM_TYPE": "'VECTORS'", "VEC_TABLE": "'1'",
        "CENTER": "'500@10'",                # 太陽中心
        "REF_PLANE": "'ECLIPTIC'",           # 黄道 J2000 (サイトの太陽系3Dと同じ枠)
        "OUT_UNITS": "'AU-D'", "CSV_FORMAT": "'YES'", "VEC_LABELS": "'NO'",
        "START_TIME": f"'{start}'", "STOP_TIME": f"'{stop}'", "STEP_SIZE": f"'{step}'",
    }
    url = API + "?" + urllib.parse.urlencode(q)
    req = urllib.request.Request(url, headers={"User-Agent": "voyager6-build"})
    with urllib.request.urlopen(req, timeout=180) as res:
        return res.read().decode("utf-8", "replace")


MONTHS = {m: i + 1 for i, m in enumerate(
    "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split())}
LIMIT_RE = re.compile(
    r"No ephemeris for target .*? (prior to|after) A\.D\. (\d{4})-([A-Z]{3})-(\d{2})")


def ephem_limit(text: str):
    """Horizons のエラー文から有効範囲を読む → ("prior to"|"after", date) か None。

    探査機の軌道は「打ち上げから今まで」揃っているとは限らない。
      - 再構築軌道が任務の途中からしか公開されていない (はやぶさは2009年以降のみ)
      - 現役機の予測軌道が数か月先までしかない (はやぶさ2・ベピコロンボ・アディティヤL1)
      - 開始時刻が打ち上げ当日の 00:00 ではない (ガリレオは 01:29:33 TDB から)
    どれも「ID が違う」のではなく範囲の問題で、**Horizons はエラー文に有効範囲を書いてくる**。
    それを読んで詰め直せば取れる (25機中5機がこれで失敗していた)。"""
    m = LIMIT_RE.search(text)
    if not m:
        return None
    return m.group(1), dt.date(int(m.group(2)), MONTHS[m.group(3)], int(m.group(4)))


def parse_vectors(text: str) -> tuple[list[float], list[list[float]]]:
    """$$SOE〜$$EOE の CSV 行から (jd[], xyz[][]) を取り出す。"""
    jd, xyz = [], []
    inside = False
    for line in text.splitlines():
        s = line.strip()
        if s == "$$SOE":
            inside = True
            continue
        if s == "$$EOE":
            break
        if not inside or not s:
            continue
        parts = [p.strip() for p in s.split(",")]
        # VEC_TABLE=1, CSV: JDTDB, CalDate, X, Y, Z, (末尾に空要素が付くことがある)
        if len(parts) < 5:
            continue
        try:
            jd.append(float(parts[0]))
            xyz.append([float(parts[2]), float(parts[3]), float(parts[4])])
        except ValueError:
            continue
    if not jd:
        # エラーメッセージらしき行を拾って報告に使う
        head = "\n".join(text.splitlines()[:20])
        raise RuntimeError(f"no vectors in response:\n{head}")
    return jd, xyz


def rdp3(jd, xyz, tol):
    """3D Ramer–Douglas–Peucker (反復版)。残す添字の集合を返す。"""
    keep = {0, len(xyz) - 1}
    stack = [(0, len(xyz) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        ax, ay, az = xyz[a]
        bx, by, bz = xyz[b]
        dx, dy, dz = bx - ax, by - ay, bz - az
        seg2 = dx * dx + dy * dy + dz * dz
        worst, wi = -1.0, -1
        for i in range(a + 1, b):
            px, py, pz = xyz[i][0] - ax, xyz[i][1] - ay, xyz[i][2] - az
            if seg2 > 0:
                t = max(0.0, min(1.0, (px * dx + py * dy + pz * dz) / seg2))
            else:
                t = 0.0
            ex, ey, ez = px - t * dx, py - t * dy, pz - t * dz
            d2 = ex * ex + ey * ey + ez * ez
            if d2 > worst:
                worst, wi = d2, i
        if worst > tol * tol:
            keep.add(wi)
            stack.append((a, wi))
            stack.append((wi, b))
    return keep


def simplify(jd, xyz):
    """RDP + 最大時間間隔の保証。(jd, xyz) を間引いて返す。"""
    keep = rdp3(jd, xyz, RDP_TOL_AU)
    idx = sorted(keep)
    # 時間間隔が MAX_GAP_DAYS を超える区間には元データから点を足し戻す
    filled = []
    for a, b in zip(idx, idx[1:]):
        filled.append(a)
        gap = jd[b] - jd[a]
        if gap > MAX_GAP_DAYS:
            # 生データへのスナップ誤差 (±生ステップ/2) を見込んで 0.75 掛けで刻む
            n = math.ceil(gap / (MAX_GAP_DAYS * 0.75))
            for k in range(1, n):
                target = jd[a] + gap * k / n
                # 二分探索は不要な規模 (数千点) なので線形で最寄りを探す
                j = min(range(a, b + 1), key=lambda i: abs(jd[i] - target))
                if j not in (a, b):
                    filled.append(j)
    filled.append(idx[-1])
    idx = sorted(set(filled))
    return [round(jd[i], 1) for i in idx], \
           [[round(v, 4) for v in xyz[i]] for i in idx]


def step_for(start: str, stop: str) -> str:
    """データ点数が STEP_TARGET 程度に収まる STEP_SIZE を選ぶ。"""
    d0 = dt.date.fromisoformat(start[:10])
    d1 = dt.date.fromisoformat(stop[:10])
    days = max(1, (d1 - d0).days)
    step = max(1, math.ceil(days / STEP_TARGET))
    return f"{step} d"


def build_one(c: dict) -> dict:
    # 打ち上げ当日は地球脱出前で中心天体が違うことがあるので 1 日ずらす
    start = (dt.date.fromisoformat(c["launch"]) + dt.timedelta(days=1)).isoformat()
    # coasting (通信途絶だが飛行中) は end で切らない。切ると最後の交信地点で止まって見える
    stop = c["traj_end"] or (None if c["coasting"] else c["end"]) or HORIZON_FUTURE
    # 範囲外を言われたら、言われた境界まで詰めて取り直す (最大2回。両端が外れることがある)
    for _ in range(2):
        text = fetch(c["id"], start, stop, step_for(start, stop))
        lim = ephem_limit(text)
        if not lim:
            break
        kind, day = lim
        if kind == "prior to":
            start = (day + dt.timedelta(days=1)).isoformat()
        else:
            stop = (day - dt.timedelta(days=1)).isoformat()
        if start >= stop:
            raise RuntimeError(f"有効範囲が残らない ({start} 〜 {stop})")
    jd, xyz = parse_vectors(text)
    jd, xyz = simplify(jd, xyz)
    out = {k: c[k] for k in ("key", "name_ja", "name_en", "agency", "country_ja",
                             "id", "launch", "status", "at", "events")}
    out["end"] = c["end"]
    out["traj_end"] = c["traj_end"]      # 周回機の到着日。以後のマーカーは惑星に重ねる
    out["coasting"] = c["coasting"]      # true = 通信途絶後も飛行中 (以後の位置は軌道計算)
    # 公開軌道が打ち上げに届いていないときは、そう明記する (黙って一部だけ描かない)。
    # 例: はやぶさは Horizons に 2009-01 以降しか無く、往路もイトカワ到着も描けない。
    got = dt.date(1858, 11, 17) + dt.timedelta(days=jd[0] - 2400000.5)
    out["from"] = got.isoformat()
    out["partial"] = (got - dt.date.fromisoformat(c["launch"])).days > 30
    out["jd"] = jd
    out["xyz"] = xyz
    return out


def main(argv):
    if "--list" in argv:
        for c in CRAFT:
            print(f"{c['key']:15s} {c['id']:>9}  {c['name_ja']} ({c['agency']})")
        return 0
    only = {a for a in argv if not a.startswith("-")}
    targets = [c for c in CRAFT if not only or c["key"] in only]
    done, failed = [], []
    for c in targets:
        try:
            item = build_one(c)
            done.append(item)
            print(f"ok   {c['key']:15s} {len(item['jd'])} pts")
        except Exception as e:  # noqa: BLE001  失敗はスキップして最後に報告
            failed.append((c["key"], str(e).splitlines()[0][:120]))
            print(f"FAIL {c['key']:15s} {failed[-1][1]}")
        time.sleep(SLEEP_SEC)
    if only:
        # 部分ビルドは既存ファイルへマージ (無ければ新規)
        try:
            prev = json.loads(OUT.read_text())["craft"]
        except Exception:  # noqa: BLE001
            prev = []
        merged = {c["key"]: c for c in prev}
        for c in done:
            merged[c["key"]] = c
        order = [c["key"] for c in CRAFT]
        done = sorted(merged.values(), key=lambda c: order.index(c["key"]) if c["key"] in order else 99)
    if not done:
        print("nothing built; keep previous file")
        return 1
    doc = {"generated": TODAY.isoformat(),
           "frame": "heliocentric ecliptic J2000, AU",
           "craft": done}
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n")
    kb = OUT.stat().st_size / 1024
    print(f"\nwrote {OUT}  ({len(done)} craft, {kb:.0f} KB)")
    if failed:
        print("failed:")
        for k, msg in failed:
            print(f"  {k}: {msg}")
    return 0 if not failed else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
