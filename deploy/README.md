# data.voyager6.net の立ち上げ — 手順書

設計は `データ配信VPS移設_設計_20260725.md`。これはその**実行手順**。

**分担**: SSH・DNS・証明書は本人。設定ファイルとスクリプトはこのディレクトリに用意済み。

## 状態: 手順1〜5 まで完了 (2026-09-01)

**`data.voyager6.net` は HTTPS で稼働中。衛星データの日次配信まで通った。**
以下の手順1〜5は実施済み。残りは手順6 (クライアント切替) と手順7 (深層タイル)。

```
https://data.voyager6.net/healthz            → ok
https://data.voyager6.net/satellites.json    → 175機
https://data.voyager6.net/satellites_geo.json→ 568機
https://data.voyager6.net/satellites_starlink.json → 10,725機 (gzip 1.86MB→682KB)
```

### この VPS の実際の姿 (手順0 の結果)

| | |
|---|---|
| OS | AlmaLinux 9.8 / SELinux **Disabled** (落とし穴 b は不要) |
| nginx | **1.31.3 (KUSANAGI ビルド)** `/opt/kusanagi/nginx131/sbin/nginx` |
| service | `nginx131.service` (**コンテナではなくホスト上**) |
| 設定 | `/etc/opt/kusanagi/nginx/conf.d/*.conf` — **`/etc/nginx/` は存在しない** |
| 共有 include | `ssl_listen.inc` (http2+QUIC), `ssl.inc`, `acme.inc`, `static.inc` |
| ディスク | 50G 中 **42G 空き** → **Gaia 全天の 15GB は乗る**。別置き場は不要 |
| python3 | 3.12.13 (`build_satellites.py` は標準ライブラリのみ) |
| certbot | 3.1.0。blog は webroot 方式で取得済み |

`nginx` は PATH に無く、`nginx -T` も素では動かない。**フルパスで叩くこと**:
`sudo /opt/kusanagi/nginx131/sbin/nginx -t`

### 設置したもの

| | |
|---|---|
| 設定 | `/etc/opt/kusanagi/nginx/conf.d/datav6.conf` |
| 配信 | `/home/kusanagi/data.voyager6.net/` (kusanagi 所有) |
| リポジトリ | `/opt/voyager6` (**kusanagi 所有で clone**。落とし穴 c 回避) |
| 証明書 | Let's Encrypt ECDSA、**2026-11-30** まで |
| 証明書更新 | `/etc/cron.d/certbot-datav6` — 月・木 4:41 (JST)、`--cert-name` で data のみ |
| 衛星の日次 | `/etc/cron.d/voyager6-data` — 毎日 5:17 (JST)、kusanagi ユーザ |
| ログ | `/var/log/voyager6-data.log` + `/etc/logrotate.d/voyager6-data` (月次・6世代) |
| nginx ログ | `/var/log/nginx/datav6_{access,error}.log` |
| バックアップ | `/root/nginx-conf.d.before-data.20260901-2248.tar.gz` (着手前の conf 一式) |

### 途中で判断を変えた2点 (設計書と違うので注意)

**(1) nginx のログを `/var/log/nginx/` に出した。** blog は
`/home/kusanagi/blogv6/log/nginx/` に出しているが、blog は root が
`.../blogv6/DocumentRoot` なのでログはルートの外にある。こちらは配信ルートが
`data.voyager6.net` 直下なので、同じ流儀にすると**ログが公開されてしまう**。

**(2) 証明書の更新 cron を自分で足した。** certbot は「scheduled task を設定した」と
表示するが、実際には `certbot-renew.timer` は **disabled** でタイマーは存在しなかった。
blog は `kusanagi update cert` (日曜 3:07) で更新されており、これは KUSANAGI の
プロファイル向けなので **data は対象外**。放置すると 2026-11-30 に失効する。
`--cert-name data.voyager6.net` で対象を限定してあるので、KUSANAGI 側の仕組みとは
同じ証明書を取り合わない。**blog 側の設定には触れていない。**

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

## 手順 3〜4: 証明書と nginx [済み] — 実際にやった順番

**証明書と conf は鶏と卵**なので、80番の仮 conf → 証明書 → 本番 conf の3段で進めた
(落とし穴メモ a)。以下は実際に通した手順そのまま。作り直すときはこれをなぞる。

```bash
NG=/opt/kusanagi/nginx131/sbin/nginx          # PATH に nginx は無い
D=/etc/opt/kusanagi/nginx/conf.d              # /etc/nginx/ ではない

# 0) 触る前に conf 一式を控える
sudo tar czf /root/nginx-conf.d.before-data.$(date +%Y%m%d-%H%M).tar.gz \
  -C /etc/opt/kusanagi/nginx conf.d

# 1) 80番だけの仮 conf。https へのリダイレクトは**まだ付けない**
#    (付けると証明書の無い https へ飛ばされ、acme 認証が通らない)
sudo tee $D/datav6.conf >/dev/null <<'NG_CONF'
server {
    listen 80; listen [::]:80;
    server_name data.voyager6.net;
    charset UTF-8;
    root /home/kusanagi/data.voyager6.net;
    include conf.d/acme.inc;
    location / { return 404; }
}
NG_CONF
sudo $NG -t && sudo systemctl reload nginx131.service

# 認証パスが本当に返るか、証明書を取る前に確かめる
sudo -u kusanagi mkdir -p /home/kusanagi/data.voyager6.net/.well-known/acme-challenge
echo ok | sudo -u kusanagi tee /home/kusanagi/data.voyager6.net/.well-known/acme-challenge/probe
curl http://data.voyager6.net/.well-known/acme-challenge/probe    # → ok

# 2) 証明書 (blog と同じ webroot 方式・ECDSA)
sudo certbot certonly --webroot -w /home/kusanagi/data.voyager6.net \
  -d data.voyager6.net --key-type ecdsa \
  --deploy-hook "systemctl reload nginx131.service" --non-interactive

# 3) 本番 conf へ差し替え (nginx/data.voyager6.net.conf を KUSANAGI 流儀にしたもの)
#    ログ先が要る: sudo mkdir -p /var/log/nginx
sudo cp /opt/voyager6/deploy/nginx/data.voyager6.net.conf $D/datav6.conf
sudo $NG -t && sudo systemctl reload nginx131.service
curl -I https://data.voyager6.net/healthz        # 200 ok
```

**証明書の自動更新は certbot 任せにできない** (上の「判断を変えた2点」参照)。cron を1本:

```bash
sudo tee /etc/cron.d/certbot-datav6 >/dev/null <<'CRON'
41 4 * * 1,4 root /usr/bin/certbot renew --cert-name data.voyager6.net --quiet
CRON
sudo certbot renew --cert-name data.voyager6.net --dry-run   # 数分かかる。気長に待つ
```

## 手順 5: 衛星データの cron [済み]

```bash
# 落とし穴 c: root で clone すると kusanagi が git pull も src/ への書き込みもできない
sudo mkdir -p /opt/voyager6 && sudo chown kusanagi:kusanagi /opt/voyager6
sudo -u kusanagi git clone https://github.com/tomoakiitoh/voyager6.git /opt/voyager6
sudo touch /var/log/voyager6-data.log && sudo chown kusanagi:kusanagi /var/log/voyager6-data.log

# 手で1回流して、配信ディレクトリに3ファイル出ることを確認する
sudo -u kusanagi /opt/voyager6/deploy/vps-update-satellites.sh
ls -la /home/kusanagi/data.voyager6.net/

# cron の最小環境でも動くかを確かめておく (PATH 由来の失敗はここでしか出ない)
sudo -u kusanagi env -i HOME=/home/kusanagi SHELL=/bin/sh PATH=/usr/bin:/bin \
  /opt/voyager6/deploy/vps-update-satellites.sh

# 登録 (crond はサーバのTZ=JST で解釈する)
sudo tee /etc/cron.d/voyager6-data >/dev/null <<'CRON'
17 5 * * * kusanagi /opt/voyager6/deploy/vps-update-satellites.sh
CRON
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

---

## 落とし穴メモ (2026-09-01 Clara追記・手順3〜5で詰まりやすい所)

**(a) 証明書と nginx conf の鶏と卵。** `nginx/data.voyager6.net.conf` の 443 ブロックは
`/etc/letsencrypt/live/data.voyager6.net/` の証明書を参照している。証明書がまだ無い状態で
この conf を置くと `nginx -t` が落ちる。しかも certbot の webroot 認証は「80番で data.voyager6.net の
`/.well-known/acme-challenge/` が `/var/www/html` から返る」ことが前提で、server ブロックが無いと
その名前のリクエストは既定の vhost (WordPress 側) に吸われて認証が通らない。**順番はこう**:

```bash
# 1) まず 80 番だけの仮 conf を置く (acme の location だけ。リダイレクトは付けない)
cat > /etc/nginx/conf.d/data.voyager6.net.conf <<'NG'
server {
    listen 80; listen [::]:80;
    server_name data.voyager6.net;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
NG
mkdir -p /var/www/html && nginx -t && systemctl reload nginx

# 2) 証明書を取る (更新時に nginx を reload するフックも一緒に)
certbot certonly --webroot -w /var/www/html -d data.voyager6.net \
  --deploy-hook "systemctl reload nginx"

# 3) 本番 conf で上書き → 反映
cp /opt/voyager6/deploy/nginx/data.voyager6.net.conf /etc/nginx/conf.d/
nginx -t && systemctl reload nginx
curl -I https://data.voyager6.net/healthz
```

**(b) SELinux (AlmaLinux)。** `/home/kusanagi/data.voyager6.net` を新規に作ると、コンテキストが
`user_home_t` 系になって nginx が読めず 403/Permission denied になることがある。
`getenforce` が Enforcing で 403 が出たら:

```bash
ls -Z /home/kusanagi/ | head            # 既存プロファイルのコンテキストと見比べる
semanage fcontext -a -t httpd_sys_content_t "/home/kusanagi/data.voyager6.net(/.*)?"
restorecon -Rv /home/kusanagi/data.voyager6.net
```

**(c) `/opt/voyager6` の所有者。** root で clone すると、cron を回す kusanagi ユーザが
`git pull` できず (safe.directory + 書込不可)、`build_satellites.py` も `src/` に書けない。
clone の直後に `chown -R kusanagi:kusanagi /opt/voyager6`、または最初から
`sudo -u kusanagi git clone ...` にする。手順5の「まず手で1回流す」で気づける。

**(d) IPv6。** VPS には IPv6 (2401:2500:102:1202:133:242:138:253) がある。AAAA を振るなら
conf の `listen [::]` が生きる。振らないなら AAAA 無しでよい (conf はそのままで害なし)。

**(e) 手順0の出力は貼って持ち帰る。** 特に `df -h /`、`nginx -v`、`getenforce`、`cat /etc/os-release | head -3`。
この4つで手順4以降の分岐 (http2 の書き方・SELinux・Gaia 全天の置き場) が全部決まる。
