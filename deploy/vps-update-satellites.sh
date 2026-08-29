#!/usr/bin/env bash
# VPS 上の cron から呼ぶ。TLE を取り直して data.voyager6.net の配信ディレクトリへ置く。
#
#   置き場所: /opt/voyager6/deploy/vps-update-satellites.sh  (リポジトリごと clone)
#   cron 例:  17 5 * * *  /opt/voyager6/deploy/vps-update-satellites.sh
#
# 設計 (データ配信VPS移設_設計_20260725.md §c):
#   - GitHub Actions の共有IPが CelesTrak に弾かれる問題を、固定IPのVPSで根治する。
#   - **半端なデータをクライアントに見せない**: JSON として読めたものだけを
#     一時ファイル経由で mv (同一ファイルシステム内の mv は不可分)。
#   - 取得に失敗したら何もしない = 前回のデータが残り続ける。落ちても静かに壊れない。

set -uo pipefail

REPO="${REPO:-/opt/voyager6}"
DATA="${DATA:-/home/kusanagi/data.voyager6.net}"
LOG="${LOG:-/var/log/voyager6-data.log}"
FILES=(satellites.json satellites_starlink.json satellites_geo.json)

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*" >>"$LOG"; }

cd "$REPO" || { log "FATAL: $REPO へ cd できない"; exit 1; }
[ -d "$DATA" ] || { log "FATAL: 配信ディレクトリ $DATA が無い"; exit 1; }

# ビルドスクリプトの更新だけ取り込む。ローカルに変更は持たない前提なので
# 失敗しても前のコードで走らせる (取得を止めない方が実害が小さい)。
git pull --quiet --ff-only || log "WARN: git pull に失敗。前回のコードで続行"

if ! python3 tools/build_satellites.py >>"$LOG" 2>&1; then
  log "WARN: build_satellites.py が失敗。配信ファイルは据え置き"
  exit 0                                  # cron のエラーメールを出さない (常態の失敗ではない)
fi

placed=0
for f in "${FILES[@]}"; do
  src="src/$f"
  [ -s "$src" ] || { log "WARN: $src が無い/空。据え置き"; continue; }
  # JSON として妥当かを確かめてからでないと置き換えない
  if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$src" 2>>"$LOG"; then
    log "WARN: $f が JSON として壊れている。据え置き"
    continue
  fi
  cp "$src" "$DATA/.$f.tmp" && mv -f "$DATA/.$f.tmp" "$DATA/$f" && placed=$((placed + 1))
done

log "OK: ${placed}/${#FILES[@]} ファイルを更新"
