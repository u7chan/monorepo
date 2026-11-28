# serve-tunnel-spike

u7agent の一時共有（[#2804](https://github.com/u7chan/monorepo/issues/2804)）で使う Cloudflare Quick Tunnel の実挙動を、実装前に確かめるスパイクです。製品コードは含みません。

Quick Tunnel はアカウント不要で、`cloudflared tunnel --url` を実行するたびに `*.trycloudflare.com` の URL を発行します。このプロジェクトは、その作成・公開・停止・連続作成を実 `cloudflared` と実 Cloudflare で確かめ、結果を [results/](./results/) に残します。

## 検証する項目

| 項目 | 見るもの | 関連 |
| --- | --- | --- |
| 起動の引数 | 固定版の `--help`、`tunnel` の後ろに置いたフラグ、`--config /dev/null` の警告 | #2805 |
| 準備完了 | メトリクスの `/quicktunnel` と `/ready`、URL の形、DNS が引けるまで | #2805 / #2806 |
| 外向きの経路 | 起動時 precheck の UDP / TCP 7844、`api.trycloudflare.com:443` | #2805 |
| 公開 | HTTP/2、警告画面の有無、`Origin` / `Referer` / `Cf-Connecting-Ip` の転送 | #2807 |
| SSE | イベントが逐次届くか、最後にまとめて届くか | #2807 |
| WebSocket | `101` と echo が通るか | #2808 |
| 同時接続 | 240 並列で何件が通り、何件が 429 になるか | #2807 |
| 停止 | SIGTERM の所要時間、停止後の URL の応答 | #2805 |
| 連続作成 | 作成と停止を繰り返したときに 429 で拒否されないか | #2805 |
| 親の強制終了 | BFF 役の親を SIGKILL した後も子とトンネルが残るか | #2805 |
| メトリクス | loopback だけで待ち受けているか、`/config` や `/debug/pprof/` が見えるか | #2805 |

## 使い方

Linux と Node.js 22 以上を使います。外向きに `api.trycloudflare.com:443` と `region{1,2}.v2.argotunnel.com:7844` の TCP / UDP が要ります。HTTP/2 の測定には HTTP/2 対応の `curl` を使います。`curl` が無い場合は `httpVersionByCurl` が空になりますが、公開 URL の到達確認は続きます。

```sh
cd projects/_labs/serve-tunnel-spike

# 版と sha256 を固定した cloudflared を tools/ へ入れる
node src/install-cloudflared.mjs

# 実トンネルを数本作り、検証して out/report.md を出す（数分）
node src/spike.mjs

# IP・ホスト名のマスクの単体テスト
node --test test/*.test.mjs
```

`src/spike.mjs` は実行のたびに `out/` を作り直します。`out/` には生のログと、URL を `<random>.trycloudflare.com` に伏せたレポートが入り、Git 管理外です。

Quick Tunnel の作成が 429 で拒否されることがあります（下記）。その場合は時間を置くしかありません。作成の回数を減らしたいときは、次のオプションを使います。

```sh
node src/spike.mjs --skip-cycles          # 基本と孤児だけ（作成 2 回）
node src/spike.mjs --skip-orphan          # 基本と連続作成だけ
node src/spike.mjs --cycles=1             # 連続作成を 1 回に減らす
```

手で動かす場合:

```sh
# 検証用のオリジン（/、/echo、/sse、/hold、/ws）
node src/origin.mjs 18080

# 別ターミナルで Quick Tunnel を作る
./tools/cloudflared tunnel --no-autoupdate --config /dev/null \
  --metrics 127.0.0.1:20241 --grace-period 5s \
  --url http://127.0.0.1:18080
```

`--config /dev/null` では `Configuration file /dev/null was empty` が Error として 1 行出ますが、起動は続きます。URL は起動ログの表と `http://127.0.0.1:20241/quicktunnel` で取れます。

## 安全上の注意

- 実行中は、検証用のダミー HTTP サーバーがランダムな URL でインターネットから見えます。機密情報を置かず、検証が終わったら停止してください。
- このスクリプトは資格情報を使いません。`HOME` は起動ごとの一時ディレクトリにし、BFF が `cloudflared` へ渡す env を絞る前提を再現しています。
- `tools/cloudflared` は GitHub のリリース asset の sha256 を固定して照合します。
- レポートには `*.trycloudflare.com` の実ホスト名と IP アドレスを残しません。`out/` の生ログも同じ置換をしてから書きます。
- 孤児シナリオの子の生ログは `out/` の外の一時ディレクトリに置き、終了時に消します。

## 結果と #2804 への示唆

検証結果は [results/2026-11-28.md](./results/2026-11-28.md) にあります。実測値はこの環境のもので、再実行すると変わります。

主な示唆:

- **`/ready` は「公開 URL が引ける」ことを意味しません。** メトリクスの `/ready` が 200 になっても DNS レコードの反映が数秒遅れることがあり、反映前に名前を引くと NXDOMAIN がリゾルバにキャッシュされ、約 30 秒待たされます。URL を利用者へ出す前に、DNS の解決（DoH など）を確かめるか、初回アクセスの失敗を前提にした案内が必要です。
- **SSE はバッファされます。** 6 イベントを 400 ms 間隔で送っても、トンネル越しには最後にまとめて届きました。公式の「SSE 非対応」と一致します。
- **WebSocket は通ります。** Quick Tunnel 自体は `101` と echo を転送しました。制限はゲート側（`service-proxy`）の upgrade 対応で、#2808 の範囲です。
- **同時 200 の上限は実在します。** 240 並列で 200 件が 200、40 件が 429 になり、オリジンの同時実行数も 200 で止まりました。開発サーバーが 1 画面で大量のリクエストを出す場合は 429 を見込む必要があります。
- **停止は速く、URL は確実に無効になります。** SIGTERM から数十 ms で終了し、以後の URL は HTTP 530 と Cloudflare のエラー 1033 を返しました。
- **連続作成は 429 で拒否されることがあります。** この環境で短時間に何本も作成・停止した後、`quick tunnel provisioning failed with status 429` で作成できなくなりました。公開されている上限はなく、回復までの時間も不明です。BFF は `rejected` として扱い、再試行を急がない必要があります。
- **親を SIGKILL すると子は残ります。** BFF 役の親を SIGKILL しても `cloudflared` は生き続け、トンネルも公開されたままでした（親は `init` などへ reparent される）。pid ファイルによる孤児の掃除は必須です。
- **メトリクスは loopback に限る必要があります。** `/quicktunnel` と `/ready` に加えて `/config` と `/debug/pprof/` も同じポートで見えました。外向きインターフェースからは届きませんでしたが、待ち受けを `127.0.0.1` に固定する前提が要ります。

## 構成

```text
src/install-cloudflared.mjs  cloudflared の取得（版と sha256 を固定）
src/origin.mjs               検証用の HTTP / SSE / WebSocket オリジン
src/tunnel.mjs               cloudflared の起動、メトリクスの待機、停止
src/spike.mjs                検証シナリオとレポートの生成
src/report.mjs               レポートの整形とサニタイズ
test/mask.test.mjs           マスクの単体テスト
results/                     実行結果（実ホスト名・IP を除く）
```

## 制約

- 外向き 7844 を塞いだときの失敗の見え方は確かめていません。ホストの firewall を操作する権限が要るためです。precheck が通る環境での結果だけを残しています。
- 転送量の上限、月間のリクエスト数、初回の警告画面の有無は、HTTP で観測できる範囲でしか見ていません。
- 1 つの環境・1 つの出口 IP での結果です。Quick Tunnel のレート制限は IP 単位と推測されますが、上限も回復時間も公開されていません。
- 実機のスマホ・QR の受入は #2807 で行います。このスパイクは HTTP クライアントからの確認だけです。
