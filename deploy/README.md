# data.voyager6.net の立ち上げ — 手順書

設計は `データ配信VPS移設_設計_20260725.md`。これはその**実行手順**。

**分担**: SSH・DNS・証明書は本人。設定ファイルとスクリプトはこのディレクトリに用意済み。

**現状 (2026-08-29 実測)**
- `data.voyager6.net` — **A レコードなし。到達不可**。ここが入口の詰まり
- `blog.voyager6.net` — 応答あり (nginx 稼働中)。VPS 自体は生きている
- VPS の IP は `VPS棚卸し_確認手順_20260804.md` に記録あり

---

## 手順 0: 未確定3点を埋める [本人・SSH]

設計書が「着手時に確認」としている3点。VPS に入って、そのまま貼って出力を持ち帰る。

```bash
# (1) OS の種別 → パッケージ導入コマンドが決まる
cat /etc/os-release | head -3

# (2) KUSANAGI の nginx が include している実パス → conf をどこに置くか
nginx -T 2>/dev/null | grep -n 'include.*\.conf' | head
ls -la /etc/nginx/conf.d/

# (3) 配信ディレクトリを作れるか・誰が書けるか
id kusanagi; df -h /; python3 -V
```

**`df -h` の数字は特に重要**。Gaia 全天の深層タイルは概算 15GB。
空きが足りなければ、深層だけ別の置き場 (さくらのオブジェクトストレージ等) に分ける判断になる。
参考: 第1弾の1ファイルぶんは 3.3MB / 87 タイル。全天はこの 3,386 倍が上限の目安。

## 手順 1: DNS [本人]

`data.voyager6.net` の A レコード → VPS の IP。
IPv6 も振るなら AAAA も。伝播確認:

```bash
dig +short data.voyager6.net A     # IP が返れば OK
```

## 手順 2: 配信ディレクトリ [本人・SSH]

WordPress の DocumentRoot の**外**に置く (KUSANAGI の fcache/bcache とリライトを避けるため)。

```bash
mkdir -p /home/kusanagi/data.voyager6.net/stars/v1
chown -R kusanagi:kusanagi /home/kusanagi/data.voyager6.net
chmod 755 /home/kusanagi/data.voyager6.net
```

## 手順 3: TLS 証明書 [本人・SSH]

DNS が通ってから。KUSANAGI の `kusanagi ssl` は WordPress プロファイル向けなので、
独立サブドメインは certbot を直接使うほうが素直。

```bash
certbot certonly --webroot -w /var/www/html -d data.voyager6.net
# webroot が無ければ: mkdir -p /var/www/html
```

## 手順 4: nginx [本人・SSH]

```bash
# 手順 0-(2) で確かめた include 先へ置く
cp nginx/data.voyager6.net.conf /etc/nginx/conf.d/
nginx -t && systemctl reload nginx

curl -I https://data.voyager6.net/healthz        # 200 ok
```

conf の中に注意書きを入れてあるので、nginx が 1.24 以前なら `http2 on;` の扱いだけ読むこと。

## 手順 5: 衛星データの cron [本人・SSH]

```bash
git clone https://github.com/tomoakiitoh/voyager6.git /opt/voyager6
chmod +x /opt/voyager6/deploy/vps-update-satellites.sh
touch /var/log/voyager6-data.log && chown kusanagi /var/log/voyager6-data.log

# まず手で1回流して、配信ディレクトリに3ファイル出ることを確認する
sudo -u kusanagi /opt/voyager6/deploy/vps-update-satellites.sh
ls -la /home/kusanagi/data.voyager6.net/

# よければ crontab へ (kusanagi ユーザで)
# 17 5 * * *  /opt/voyager6/deploy/vps-update-satellites.sh
```

確認:

```bash
curl -s https://data.voyager6.net/satellites.json | head -c 120
```

## 手順 6: クライアントを VPS 優先に切り替える [こちら]

手順 5 まで通ったら教えてください。`index.html` / `earth.html` / `planetarium.html` の
衛星データ取得を「VPS を先に試し、失敗したら Pages の committed コピー」に差し替えます
(設計書 §d)。**VPS が落ちてもサイトは静的スナップショットで動く**ので、耐障害性は下がりません。

## 手順 7: 深層タイルの配信 [こちら + 本人]

Gaia 全天ビルド (MBP で週末に放置) のあと、Mac から:

```bash
DRY=1 ./deploy/rsync-stars.sh     # まず何が送られるか見る
./deploy/rsync-stars.sh           # 本番へ
```

manifest.json を最後に送るようにしてあります (先に着くと、まだ無いタイルを取りに行って 404 を踏むため)。

---

## 切り戻し

どの段階でも、**クライアントは Pages の committed スナップショットへ落ちる**ように作ってあるので、
VPS を止めてもサイトは動きます。急いで戻すなら:

```bash
# nginx だけ落とす
rm /etc/nginx/conf.d/data.voyager6.net.conf && nginx -t && systemctl reload nginx
```

深層タイル (20等星図) だけは Pages にフォールバックがありません。これは「オンライン専用の層」
という方針どおりで、`data.voyager6.net` が不通なら**黙って 10等までの表示に戻ります**。

## 運用の見張り

- `curl -s https://data.voyager6.net/healthz` — 生きているか
- 配信ファイルの mtime が2日以上古くないか (cron が黙って死んでいないか)
- `/var/log/voyager6-data.log` — 各回の結果が1行ずつ入る
