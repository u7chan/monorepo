# u7agent Relay

外部クライアント（Muse など）から、u7agent の固定した会話へ依頼を投稿し、最終応答を受け取るための中継です。接続先と API キーは付属の管理 GUI で作ります。

u7agent の BFF にはログイン認証がありません。中継は外部へ公開する入口を Bearer キーに限定し、キーごとに 1 つの会話へ固定します。会話を増やすときは、GUI で接続先を足してキーを発行します。

```text
外部クライアント ── Bearer キー ──▶ u7agent-relay ── HTTPS ──▶ u7agent BFF
                                      │
                                      └─ PIN で守られた管理 GUI（接続先 / キー / 実行履歴）
```

## Docker で起動する

```sh
cd projects/u7agent-relay
docker compose up -d --build
```

`http://localhost:8787` を開き、最初に 6 桁の PIN を登録します。PIN・セッション鍵・SQLite は `u7agent_relay_data` volume に残ります。TLS 終端を前段に置く場合は、`.env` に `COOKIE_SECURE` / `TRUST_PROXY` / `APP_ORIGIN` を設定すると Compose から渡されます。

待受はホストの loopback だけに公開しています（`compose.yaml` の `127.0.0.1:8787:8787`）。u7agent の BFF が無認証のため、中継をインターネットへ直接公開しないでください。

自宅サーバーでは self-hosted-runner の `u7agent-relay` target が動かします。`ports` は loopback のままで、ホストの `tailscale serve` が tailnet 内だけに公開します（Caddy に site は持ちません）。上流の u7agent へは Caddy 経由の `https://agent.home.arpa` で接続し、証明書は Caddy の内部 CA を信頼します。手順は self-hosted-runner の `docs/u7agent-relay.md` を参照してください。

それ以外の環境で別端末から使うときは、Tailscale などで到達範囲を絞ってから `ports` を変えてください。

## ローカルで起動する

Bun 1.4 を使います。

```sh
cd projects/u7agent-relay
bun install
DATA_DIR=./data bun run dev   # http://localhost:8787
```

`NODE_ENV` が `production` でなければ Bun の HMR が有効になります。データは `./data` に作られます。

## 接続先を登録する

「接続先」タブから、次のどちらかで登録します。

| 方法 | 入力 | 用途 |
| --- | --- | --- |
| 会話 URL を貼る | `https://…/s/<10 hex>?space=<space>` | すでにある会話へ中継する |
| 新しい会話を作る | u7agent の origin とスペース ID | u7agent に会話を作らせて、そのまま登録する |

- 会話 URL は `https` だけを受け付けます。平文だと、中継の外で会話が読めてしまうためです。
- `space` を省略した URL は `default` として扱います。
- 同じ会話（origin + 会話 ID + スペース）の重複登録は 409 で拒否します。
- 登録後に変更できるのは名前だけです。会話を変えると発行済みキーの送信先が変わってしまうため、別の会話へ移るときは新しい接続先を登録し、キーを発行し直してください。
- 「疎通確認」は u7agent の `GET /api/sessions/:id` を呼び、状態・タイトル・待ち件数を表示します。
- 接続先を削除すると、紐づく API キーと実行履歴も削除されます。
- 管理 API は接続先の origin / URL を返しません。画面には会話 ID とスペースだけを表示します。

## API キーを発行する

「API キー」タブで名前と接続先を選ぶと、`ur_` で始まるキーを一度だけ表示します。保存されるのは SHA-256 ハッシュだけなので、再表示はできません。

- キーは 1 つの接続先に固定されます。別の会話へ投稿するには、その会話の接続先とキーを作ります。
- 失効は即時です。失効したキーは 401 になり、監査用に一覧へ残ります。
- 削除すると一覧から消えます。実行履歴のキー名は「削除済み」になります。

## 外部クライアントから使う

投稿は `202` で `runId` を返し、実行はバックグラウンドで進みます。`GET /v1/replies/:runId` を繰り返し呼んで結果を受け取ります。旧パス `/messages` と `/replies/:runId` も同じ動作です。

```sh
curl -fsS -X POST http://localhost:8787/v1/messages \
  -H "Authorization: Bearer ur_…" \
  -H "Content-Type: application/json" \
  -d '{"text":"このリポジトリの構成を調べて"}'
# => 202 {"runId":"0123456789abcdef"}

curl -fsS http://localhost:8787/v1/replies/0123456789abcdef \
  -H "Authorization: Bearer ur_…"
```

| 応答 | 意味 |
| --- | --- |
| `{"runId":"…"}` | 受理した。`runId` で結果を追跡する。 |
| `{"status":"queued","sessionUrl":"…"}` | u7agent のキューに積まれた。実行 ID が無いので追跡できない。会話を開いて確認する。 |
| `{"status":"running"}` | 実行中。 |
| `{"status":"awaiting_answer","sessionUrl":"…"}` | u7agent が質問して回答待ち。会話を開いて答える。 |
| `{"status":"completed","text":"…","files":[…]}` | 完了。その実行の最後の assistant 本文と、生成物の一覧を返す。 |
| `{"status":"stopped"}` / `{"status":"error"}` | 停止または失敗。 |

- 実行中の会話、または送信待ちがある会話への投稿は `409 session_busy` です。再送しないでください。
- 返信は、その `runId` を発行したキーだけが読めます。他のキーからは `404 run_not_found` です。
- 会話履歴全体とツール出力は返しません。生成物は `/v1/runs/:runId/files` で取得できます（cwd 配下、allowlist）。
- 終了済みの実行は SQLite に保存した結果で答えます。上流の u7agent は直近の実行しか返さないため、後から追い越された実行の途中経過は取得できません。

### 実行の生成物を取得する

`completed` の `files` は、その実行の assistant 本文に現れた画像・音声・HTML・テキストの一覧です。それぞれ `path`（cwd 相対）と `kind` を持ちます。実体は同じ `runId` の API から取得します。

```sh
curl -fsS http://localhost:8787/v1/runs/0123456789abcdef/files \
  -H "Authorization: Bearer ur_…"

curl -fsS "http://localhost:8787/v1/runs/0123456789abcdef/files?path=generated%2Fcafe.png" \
  -H "Authorization: Bearer ur_…" \
  -o cafe.png
```

| 応答 | 意味 |
| --- | --- |
| `{"files":[{"path":"…","kind":"image"}]}` | 完了した実行の生成物一覧。実行中・停止・エラーは `409 run_not_completed`。 |
| バイナリ | `Content-Type: application/octet-stream` と `Content-Disposition: attachment`。画像・音声は `Range` / `206` / `416` に対応。 |

- 取得できるのは接続先セッションの cwd 配下だけです。`..` / 絶対パス / ディレクトリ / 空 / バックスラッシュ / 空白 / NUL は 400 `invalid_path`。
- 受け付けたパスは upstream `GET /api/files/stat` で realpath を確認し、cwd の外を指す symlink は 400 にします。cwd がワークスペース root の接続先は 403 `file_scope_unavailable` です。
- 画像・音声は upstream `GET /api/files/raw`、HTML・テキストは `GET /api/files/download` を使います。対象外の拡張子と SVG は 415 `not_downloadable`。
- 上限は 1 ファイル 100 MiB、同時ダウンロードは接続先ごとに 2 本です。超過は `413 file_too_large` / `429 too_many_downloads`。
- 上流の 400 / 404 / 413 / 502 / 503 / 504 は `invalid_path` / `file_not_found` / `file_too_large` / `upstream_unavailable` / `upstream_timeout` などに写像します。上流の本文は返しません。
- 画像と音声以外に `Range` を付けても無視し、200 で全体を返します。
- 上流へのファイル取得は `Accept-Encoding: identity` を要求します。上流が `Content-Encoding` を付けた場合は `Content-Length` を引き継がず、本文の長さはチャンク転送に任せます。
- ファイルは `attachment` として返すため、relay のオリジンで HTML は実行されません。
- 一覧の `kind` は本文のパスから決めるヒントです。実際に配信できるかは `stat` が返す realpath の拡張子で決まります。
- 抽出は Markdown のフェンス（``` / ~~~）とインラインコードを除外します。インデントコードブロック内の記法は除外できない既知の制限があります。
- `cwd` は接続先ごとに 60 秒キャッシュします。セッション移動の直後は最大 60 秒古い cwd を使うことがあり、その場合は `stat` の確認で fail closed になります。
- `stat` と取得の間に symlink を差し替えられる競合は塞げません。静的な symlink は realpath の確認で拒否します。
- プロジェクト会話の `cwd` はプロジェクトのルートです。その配下のファイルをキーで読める範囲になるため、接続先の会話とキーの配布先を信頼できる範囲に限ってください。

`GET /healthz` は認証なしで `200 OK` と `u7agent-relay-ok` を返します。

## セキュリティ

| 対象 | 方式 |
| --- | --- |
| 管理 GUI | 6 桁 PIN（Argon2id）。5 回失敗で 15 分ロック。cookie は HttpOnly / SameSite=Lax / 30 日。 |
| 管理 API の変更 | 同一 origin の要求だけ許可（Origin が無い curl は拒否）。 |
| 中継 API | `Authorization: Bearer ur_…`。保存は SHA-256 で、失効は即時。 |
| 中継 API のファイル取得 | 接続先セッションの cwd 配下だけ。上流 `stat` の realpath で境界を確認し、`attachment` / `octet-stream` で返す。 |
| 待受 | コンテナ内は `0.0.0.0`、compose は loopback のみ。 |

- PIN は初回アクセスで登録し、`DATA_DIR` の `pin-hash` に保存します。忘れた場合は `pin-hash` と `session-key` を消すと再設定できます（キーと接続先は残ります）。
- 初回の PIN 登録より先に中継を外部へ公開しないでください。最初にアクセスした人が PIN を決められます。
- `TRUST_PROXY=1` を使うときは、前段が接続元を `X-Forwarded-For` へ上書きまたは追記し、中継へ直接到達できないことを配備条件にしてください。直接到達できると、転送ヘッダーを偽装して PIN の試行制限を回避できます。
- 中継は接続先として登録した会話へ到達できます。接続先の origin は信頼できる u7agent だけにしてください。
- 実行中の直列化はプロセス内で行います。中継は 1 インスタンスで動かしてください。ファイル取得の同時実行制限と cwd の 60 秒キャッシュも、この前提に依存します。
- ファイル取得は 1 ファイル 100 MiB までで、接続先ごとに同時 2 本に制限します。帯域を守る仕組みは別途必要です。
- 実行中 / 回答待ちの履歴は 30 秒ごとに上流へ問い合わせて更新します。クライアントが返信取得をやめても、完了した応答は管理画面から読めます。
- 上流の u7agent は中継からの要求に認証を要求しません。中継と u7agent の間を信頼できるネットワークに置いてください。内部 CA を使う場合は、イメージの信頼ストアへ CA を入れてください。

## 環境変数

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 待受アドレス。 |
| `PORT` | `8787` | 待受ポート。 |
| `DATA_DIR` | `/app/data` | SQLite・PIN ハッシュ・セッション鍵の置き場。 |
| `COOKIE_SECURE` | 未設定 | `1` で cookie に常に `Secure` を付ける。 |
| `TRUST_PROXY` | 未設定 | `1` で `X-Forwarded-*` を信頼する。TLS 終端が前段にあるときだけ。接続元は `X-Forwarded-For` の末尾（前段が追記した値）を使う。前段が値を上書きまたは追記し、中継へ直接到達できない構成に限る。 |
| `APP_ORIGIN` | 未設定 | TLS 終端の後ろでブラウザから見たオリジン。Origin 検査に使う。 |
| `COMMIT_HASH` | — | ビルド時に埋め込むバージョン表示。 |

## データ

`DATA_DIR` には次のファイルができます。バックアップするならこのディレクトリごと取得してください。

| ファイル | 内容 |
| --- | --- |
| `relay.sqlite` | 接続先・API キー（ハッシュ）・実行履歴・生成物の一覧（`run_assets`）。実行履歴は 90 日で削除。 |
| `pin-hash` | PIN の Argon2id ハッシュ。 |
| `session-key` | セッション cookie の署名鍵。 |

`pin-hash` / `session-key` が壊れていると、GUI はログイン画面ではなく復旧手順を表示します。

## 開発

```sh
cd projects/u7agent-relay
bun run check   # oxlint / oxfmt / tsc / bun:test
```

Docker の test / final ステージは次のように確認できます。

```sh
docker build --target test ./projects/u7agent-relay
docker build --target final -t u7agent-relay ./projects/u7agent-relay
```

## 旧 LAB からの移行

`projects/_labs/u7agent-relay` の試作はこのプロジェクトへ統合しました。`.env` の `U7AGENT_SESSION_URL` と `U7AGENT_RELAY_TOKEN` は使わないため、起動後に GUI で接続先を登録し、キーを発行し直してください。旧トークンは 46 文字の `ur_` 形式ではないので、そのままでは通りません。
