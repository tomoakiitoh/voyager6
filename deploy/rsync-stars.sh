#!/usr/bin/env bash
# 20等星図の深層タイルを MBP → VPS へ送る。**Mac 側で実行する**。
#
#   ./deploy/rsync-stars.sh            # 本番へ送る
#   DRY=1 ./deploy/rsync-stars.sh      # 何が送られるかだけ見る (推奨: 初回は必ずこれ)
#
# なぜ VPS でビルドしないか (20等星図_実装プラン §3):
#   Gaia のバルクは csv.gz が 3,386 本・数百GB級で、VPS の回線とディスクでは回らない。
#   ビルドは MBP で週末に一回。VPS は静的配信に徹する (実行系を置かない方針とも一致)。
#
# 送り方の考え方:
#   - **manifest.json を最後に送る**。タイルより先に manifest が着くと、まだ無いタイルを
#     クライアントが取りに行って 404 を踏む。manifest が「正」なので、実体を先に置く。
#   - --delete は付けない。古い層を消すのは v2 を掘るとき (住所は変えない原則)。
#     消したいときだけ DELETE=1 で明示する。

set -euo pipefail

HOST="${HOST:-data.voyager6.net}"
USER_="${USER_:-kusanagi}"
SRC="${SRC:-dist/stars_v1/}"                       # build_stars_v1.py の出力
DEST="${DEST:-/home/kusanagi/data.voyager6.net/stars/v1/}"

[ -d "$SRC" ] || { echo "エラー: $SRC が無い。先に tools/build_stars_v1.py を実行する" >&2; exit 1; }
[ -f "$SRC/manifest.json" ] || { echo "エラー: $SRC/manifest.json が無い" >&2; exit 1; }
python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$SRC/manifest.json" \
  || { echo "エラー: manifest.json が JSON として壊れている" >&2; exit 1; }

OPTS=(-avz --partial --human-readable --info=stats2)
[ "${DRY:-0}" = "1" ]    && OPTS+=(--dry-run)
[ "${DELETE:-0}" = "1" ] && OPTS+=(--delete)

echo "== タイル本体 (manifest 以外) を先に送る =="
rsync "${OPTS[@]}" --exclude 'manifest.json' "$SRC" "${USER_}@${HOST}:${DEST}"

echo
echo "== manifest.json を最後に送る (これが着いた時点で新しい層が有効になる) =="
rsync "${OPTS[@]}" "${SRC}manifest.json" "${USER_}@${HOST}:${DEST}"

if [ "${DRY:-0}" != "1" ]; then
  echo
  echo "== 配信の確認 =="
  curl -sI "https://${HOST}/stars/v1/manifest.json" | head -1
  curl -s  "https://${HOST}/stars/v1/manifest.json" \
    | python3 -c "import json,sys; m=json.load(sys.stdin); print('層:', [l['id'] for l in m['layers']], '/ タイル数:', sum(len(v) for v in m['tiles'].values()))"
fi
