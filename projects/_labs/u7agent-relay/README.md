# u7agent Relay

開発機から、固定の u7agent 会話への投稿と最終応答の取得を試す HTTP 中継です。u7agent の既存 API を使います。Node.js 26 があれば依存のインストールは不要です。

## Muse からの疎通だけ試す

モノレポのルートから起動します。Node.js が WSL 側にある場合は、PowerShell で `wsl.exe` を実行して WSL に入り、モノレポのルートへ移動してから実行してください。

```sh
cd projects/_labs/u7agent-relay
node server.mjs --health-only
```

`GET http://localhost:8787/healthz` は認証なしで `200 OK` と `u7agent-relay-ok` を返します。このモードではそれ以外のルートは無効で、u7agent にはアクセスしません。

### Windows PowerShell から Tailscale Serve を起動する

中継を起動したまま、別の PowerShell で `u7agent-relay-ok` が返ることを確認します。

```powershell
curl.exe -fsS http://localhost:8787/healthz
```

Tailscale のアクセスルールで接続元を絞ったうえで、次を実行します。

```powershell
& "$env:ProgramFiles\Tailscale\tailscale.exe" serve 8787
```

初回の設定画面では HTTPS 証明書だけを有効にし、Funnel のチェックは外します。PowerShell に表示された Tailnet 用 HTTPS URL の末尾に `/healthz` を付けて Muse に渡します。検証中は中継と Serve を起動したままにします。Subnet Route は不要です。

## 固定の会話へ中継する

検証専用の会話を作り、次の形式で `.env` を用意します。URL は既存の会話を開いたときの HTTPS URL、トークンは `openssl rand -hex 32` などで生成した専用の値を使います。実値はコミットやスキルの本文に含めません。

```dotenv
U7AGENT_SESSION_URL=https://agent.example.com/s/0123456789?space=space-0123456789abcdef
U7AGENT_RELAY_TOKEN=<生成したトークン>
```

ヘルスチェック専用プロセスを停止してから、以下を実行します。内部 CA を使う場合は開発機の信頼ストアへ CA を入れ、TLS の検証は無効にしません。

```sh
node --use-system-ca --env-file=.env server.mjs
```

待受はループバックのみです。既定ポートを使えない場合は `RELAY_PORT` を指定します。以下の2操作には `Authorization: Bearer <トークン>` が必要です。

| 操作 | 内容 |
| --- | --- |
| `POST /messages` | `Content-Type: application/json` と `{ "text": "依頼文" }` を渡す。受付は `202` と `{ "runId": "…" }`。実行中の追加投稿は `409`。 |
| `GET /replies/:runId` | `running` / `awaiting_answer` / `completed` / `stopped` / `error` を `status` に返す。完了時はその実行の最後の本文だけを `text` に返す。質問待ちは `sessionUrl` を開いて u7agent で回答する。 |

中継が直近に受け付けた実行だけ取得できます。再起動後の取得、GUI や他のクライアントからの同時投稿、ストリーミング、質問への回答は試作の対象外です。受理が `202` で `status: "queued"` の場合や投稿の結果が不明な場合は再送せず、会話の画面で確認してください。会話履歴全体やツール出力は返しません。

## テスト

次のコマンドで、実際の u7agent にアクセスせずに検証できます。

```sh
node --test
```

この試作はデプロイしないため、Dockerfile は用意していません。CI も Docker イメージをビルドしません。
