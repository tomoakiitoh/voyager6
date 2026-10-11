#!/usr/bin/env python3
"""voyager6 の更新系が生きているかを外側から確かめる (帰宅後チェック)。

    python3 tools/check_health.py          # 全項目。問題が無ければ1行で終わる
    python3 tools/check_health.py -v       # 緑の項目も全部表示
    GITHUB_TOKEN=xxx python3 tools/check_health.py   # API制限(60回/時)が気になるとき

なぜ外側から見るか:
  三系統 (Actions / VPS cron / Mac) はどれも「取得に失敗したら前回データを残して静かに続ける」。
  サイトは止まらないが、止まったことにも気づけない。VPS から Slack に送る通知は
  「起きたこと」は知らせても、cron や VPS そのものが止まった「沈黙」は知らせない。
  このスクリプトは沈黙を検出する側。定時でなくてよい (TLE は数日もつ、証明書は残日数で見る)。

見るもの:
  - data.voyager6.net の TLE の鮮度 (TLE 1行目の元期を読む = 配信物そのものの新しさ)
  - voyager6.net (Pages) の TLE スナップショットの鮮度
  - data.voyager6.net/healthz
  - 証明書の残日数 (data. / next. / voyager6.net)
  - 彗星・小惑星の軌道要素の最終コミット (GitHub API)
  - 各ワークフローの直近の実行結果 (GitHub API)

終了コード: 0 = 全部緑 / 1 = 注意あり / 2 = 異常あり。標準ライブラリのみ。
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
import socket
import ssl
import sys
import unicodedata
import urllib.error
import urllib.request

REPO = "tomoakiitoh/voyager6"
UA = "voyager6-check-health/1"
TIMEOUT = 20

OK, WARN, FAIL = 0, 1, 2
MARK = {OK: "✅", WARN: "⚠️ ", FAIL: "❌"}

# 閾値 (時間 / 日)
TLE_WARN_H, TLE_FAIL_H = 48, 96           # 日次更新。2日空いたら注意、4日で異常
ORBIT_WARN_D, ORBIT_FAIL_D = 4.5, 8       # 月・木の週2回。最大の間隔は4日
CERT_WARN_D, CERT_FAIL_D = 30, 14

NOW = dt.datetime.now(dt.timezone.utc)


# ---------------------------------------------------------------- 取得まわり

def fetch(url: str, *, github: bool = False) -> bytes:
    headers = {"User-Agent": UA}
    if github:
        headers["Accept"] = "application/vnd.github+json"
        tok = os.environ.get("GITHUB_TOKEN")
        if tok:
            headers["Authorization"] = f"Bearer {tok}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


def fetch_json(url: str, **kw):
    return json.loads(fetch(url, **kw))


def dispw(s: str) -> int:
    """全角を2桁として数えた表示幅 (日本語の項目名で列を揃えるため)。"""
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in s)


def ago(delta: dt.timedelta) -> str:
    h = delta.total_seconds() / 3600
    return f"{h:.0f}時間前" if h < 48 else f"{h / 24:.1f}日前"


# ---------------------------------------------------------------- TLE

def tle_epoch(line1: str) -> dt.datetime:
    """TLE 1行目の元期 (列19-32: YYDDD.DDDDDDDD) を UTC の datetime にする。"""
    field = line1[18:32].strip()
    yy, doy = int(field[:2]), float(field[2:])
    year = 2000 + yy if yy < 57 else 1900 + yy
    return dt.datetime(year, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(days=doy - 1)


def newest_tle_epoch(rows) -> dt.datetime:
    """配列 [name, NORAD, TLE1, TLE2, ...] の中で最も新しい元期。
    個々の衛星は数日前の元期のこともあるので、全体の最大値で配信物の新しさを見る。"""
    epochs = []
    for row in rows:
        try:
            epochs.append(tle_epoch(row[2]))
        except (IndexError, ValueError, TypeError):
            continue
    if not epochs:
        raise ValueError("TLE が1件も読めない")
    return max(epochs)


def check_tle(name: str, url: str):
    rows = fetch_json(url)
    newest = newest_tle_epoch(rows)
    age = NOW - newest
    h = age.total_seconds() / 3600
    level = OK if h < TLE_WARN_H else WARN if h < TLE_FAIL_H else FAIL
    return level, name, f"最新の元期 {ago(age)} ({len(rows)}機)"


# ---------------------------------------------------------------- VPS / 証明書

def check_healthz():
    body = fetch("https://data.voyager6.net/healthz").decode().strip()
    return (OK if body == "ok" else WARN), "VPS /healthz", f"応答 '{body[:20]}'"


def cert_days_left(host: str) -> float:
    ctx = ssl.create_default_context()
    with socket.create_connection((host, 443), timeout=TIMEOUT) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as s:
            not_after = s.getpeercert()["notAfter"]
    exp = dt.datetime.fromtimestamp(ssl.cert_time_to_seconds(not_after), dt.timezone.utc)
    return (exp - NOW).total_seconds() / 86400, exp


def check_cert(host: str):
    days, exp = cert_days_left(host)
    level = OK if days >= CERT_WARN_D else WARN if days >= CERT_FAIL_D else FAIL
    return level, f"証明書 {host}", f"残り {days:.0f}日 ({exp:%Y-%m-%d} 失効)"


def check_next():
    fetch("https://next.voyager6.net/")
    return OK, "next.voyager6.net", "応答あり"


# ---------------------------------------------------------------- GitHub

def check_orbit_commit():
    api = f"https://api.github.com/repos/{REPO}/commits?path=src/comets_all.json&per_page=1"
    c = fetch_json(api, github=True)[0]["commit"]
    when = dt.datetime.fromisoformat(c["author"]["date"].replace("Z", "+00:00"))
    age = NOW - when
    d = age.total_seconds() / 86400
    level = OK if d < ORBIT_WARN_D else WARN if d < ORBIT_FAIL_D else FAIL
    return level, "彗星・小惑星の軌道要素", f"最終コミット {ago(age)}"


def check_workflows():
    """ワークフローごとに直近の実行だけを見る (過去の失敗が再実行で直っていれば緑)。"""
    runs = fetch_json(f"https://api.github.com/repos/{REPO}/actions/runs?per_page=50",
                      github=True)["workflow_runs"]
    latest: dict[str, dict] = {}
    for r in runs:                       # 新しい順に来るので、最初に出会ったものが直近
        latest.setdefault(r["name"], r)
    results = []
    for name, r in sorted(latest.items()):
        concl = r.get("conclusion")
        when = dt.datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))
        if r["status"] != "completed":
            results.append((OK, f"Actions {name}", f"実行中 ({ago(NOW - when)}に開始)"))
        elif concl == "success":
            results.append((OK, f"Actions {name}", f"直近 {ago(NOW - when)} 成功"))
        else:
            results.append((FAIL, f"Actions {name}", f"直近 {ago(NOW - when)} {concl}"))
    return results


# ---------------------------------------------------------------- 本体

CHECKS = [
    ("TLE (data.voyager6.net)", lambda: check_tle("TLE (data.voyager6.net)",
                                                  "https://data.voyager6.net/satellites.json")),
    ("TLE (Pages スナップショット)", lambda: check_tle("TLE (Pages スナップショット)",
                                                    "https://voyager6.net/satellites.json")),
    ("VPS /healthz", check_healthz),
    ("証明書 data.voyager6.net", lambda: check_cert("data.voyager6.net")),
    ("証明書 next.voyager6.net", lambda: check_cert("next.voyager6.net")),
    ("証明書 voyager6.net", lambda: check_cert("voyager6.net")),
    ("next.voyager6.net", check_next),
    ("彗星・小惑星の軌道要素", check_orbit_commit),
    ("Actions", check_workflows),
]


def run_one(label, fn):
    try:
        out = fn()
        return out if isinstance(out, list) else [out]
    except urllib.error.HTTPError as e:
        return [(FAIL, label, f"HTTP {e.code}")]
    except Exception as e:  # noqa: BLE001 — 何が起きても1項目の異常として報告し、他を止めない
        return [(FAIL, label, f"{type(e).__name__}: {e}")]


def main() -> int:
    ap = argparse.ArgumentParser(description="voyager6 の更新系を外側から確かめる")
    ap.add_argument("-v", "--verbose", action="store_true", help="緑の項目も表示する")
    args = ap.parse_args()

    with cf.ThreadPoolExecutor(max_workers=len(CHECKS)) as ex:
        futures = [ex.submit(run_one, label, fn) for label, fn in CHECKS]
        results = [r for f in futures for r in f.result()]

    worst = max(level for level, _, _ in results)
    shown = results if args.verbose else [r for r in results if r[0] != OK]
    stamp = NOW.astimezone(dt.timezone(dt.timedelta(hours=9))).strftime("%m/%d %H:%M")

    if worst == OK and not args.verbose:
        print(f"✅ voyager6: 全{len(results)}項目 異常なし ({stamp} JST)")
        return OK

    print(f"{MARK[worst]} voyager6 チェック ({stamp} JST)")
    width = max(dispw(name) for _, name, _ in shown) if shown else 0
    for level, name, detail in sorted(shown, key=lambda r: -r[0]):
        print(f"  {MARK[level]} {name}{' ' * (width - dispw(name))}  {detail}")
    if not args.verbose:
        print(f"  (ほか {len(results) - len(shown)} 項目は正常)")
    return worst


if __name__ == "__main__":
    sys.exit(main())
