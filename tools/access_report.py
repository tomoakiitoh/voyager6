#!/usr/bin/env python3
"""GoatCounter から月次アクセスレポート(Markdown)を作る。

    GOATCOUNTER_TOKEN=xxx python3 tools/access_report.py [YYYY-MM]

- 月を省略すると今月(1日〜今日)。
- 出力は reports/access-YYYY-MM.md(.gitignore 済み)と標準出力の両方。
- トークンの作り方: https://tomoakiitoh.goatcounter.com/ 右上の
  [ユーザー名] → API → New API token(権限は Read statistics だけでよい)。
  トークンはリポジトリにコミットしないこと(環境変数で渡す)。

API仕様: https://www.goatcounter.com/help/api (v0, Bearer認証, 4req/s)
"""

from __future__ import annotations

import calendar
import datetime
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SITE = "https://tomoakiitoh.goatcounter.com"
ROOT = pathlib.Path(__file__).resolve().parent.parent


def api(path: str, **params):
    """GET /api/v0/<path>。レート制限(4req/s)を素朴に守る。"""
    url = f"{SITE}/api/v0/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + os.environ["GOATCOUNTER_TOKEN"],
        "Content-Type": "application/json",
    })
    time.sleep(0.3)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def month_range(arg: str | None):
    today = datetime.date.today()
    if arg:
        y, m = map(int, arg.split("-"))
    else:
        y, m = today.year, today.month
    start = datetime.date(y, m, 1)
    last = datetime.date(y, m, calendar.monthrange(y, m)[1])
    end = min(last, today)
    return start, end


def fmt_rows(items, name_keys=("name", "path", "id"), max_rows=20):
    """統計エントリの配列を Markdown 表の行に整形する(キー名の揺れに耐える)。"""
    rows = []
    for it in items[:max_rows]:
        name = next((it[k] for k in name_keys if it.get(k)), "(不明)")
        count = it.get("count", it.get("count_unique", 0))
        rows.append(f"| {name} | {count:,} |")
    return rows


def main() -> int:
    if "GOATCOUNTER_TOKEN" not in os.environ:
        print("エラー: 環境変数 GOATCOUNTER_TOKEN が未設定。", file=sys.stderr)
        print("  例: GOATCOUNTER_TOKEN=xxx python3 tools/access_report.py", file=sys.stderr)
        return 1

    start, end = month_range(sys.argv[1] if len(sys.argv) > 1 else None)
    span = {"start": start.isoformat(), "end": end.isoformat()}
    lines = [f"# voyager6.net アクセスレポート {start:%Y-%m}",
             "",
             f"期間: {start} 〜 {end} / 生成: {datetime.date.today()}",
             ""]

    # 合計
    try:
        total = api("stats/total", **span)
        lines += [f"**合計 {total.get('total', 0):,} PV** "
                  f"(ユニーク訪問 {total.get('total_utc', total.get('total_unique', 0)):,})",
                  ""]
    except Exception as e:
        lines += [f"(合計の取得に失敗: {e})", ""]

    # セクション: (見出し, APIパス, 名前キー)
    sections = [
        ("ページ別", "stats/hits", ("path",)),
        ("参照元", "stats/toprefs", ("name", "id")),
        ("ブラウザ", "stats/browsers", ("name", "id")),
        ("OS", "stats/systems", ("name", "id")),
        ("国", "stats/locations", ("name", "id")),
    ]
    for title, path, keys in sections:
        try:
            data = api(path, **span, limit=20)
            items = data.get("hits", data.get("stats", []))
            if not items:
                continue
            lines += [f"## {title}", "", "| 項目 | 件数 |", "|---|---:|"]
            lines += fmt_rows(items, name_keys=keys)
            lines.append("")
        except urllib.error.HTTPError as e:
            lines += [f"## {title}", "", f"(取得失敗 HTTP {e.code} — APIパス要確認)", ""]
        except Exception as e:
            lines += [f"## {title}", "", f"(取得失敗: {e})", ""]

    # 404 ハント: パス「404/〜」だけ抜き出す
    try:
        data = api("stats/hits", **span, limit=100)
        broken = [h for h in data.get("hits", []) if str(h.get("path", "")).startswith("404/")]
        if broken:
            lines += ["## 404(リンク切れ・迷子)", "", "| 存在しないURL | 件数 |", "|---|---:|"]
            lines += fmt_rows(broken, name_keys=("path",), max_rows=30)
            lines.append("")
    except Exception:
        pass

    report = "\n".join(lines)
    out = ROOT / "reports" / f"access-{start:%Y-%m}.md"
    out.parent.mkdir(exist_ok=True)
    out.write_text(report, encoding="utf-8")
    print(report)
    print(f"\n→ {out.relative_to(ROOT)} に保存した", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
