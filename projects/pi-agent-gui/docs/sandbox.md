# ツール実行のサンドボックス分離

作業用ツール（read / bash / edit / write / grep / find / ls）は BFF プロセス内では実行しない。pi SDK の `customTools` で同名の組み込みツールを「サンドボックス実行APIを呼ぶリモート定義」で置き換え、BFF が任意の作業コードを実行する経路を無くす。この分離はコンテナ構成を前提とし、そこでは LLM 認証情報は BFF だけが保持し、サンドボックスのプロセス・環境変数・ファイルシステムには渡らない（ホスト上の別プロセスとして起動する場合は同一ユーザー・同一環境になるため、[残存リスク](#残存リスク)の制約を受ける）。

HTTP 契約と環境変数は [sandbox-api.md](sandbox-api.md)、APIキーのマスクは [secrets.md](secrets.md) を参照する。

## 構成

```
pi SDK (BFF)                       sandbox service (別プロセス / 別コンテナ)
  customTools (remote-tools.ts)         service.ts: SDK 組込みツールをローカル実行
   ├ execute() プロキシ  ── Bearer ──▶  POST /v1/tools/:tool/execute (NDJSON)
   ├ onUpdate ◀──── update イベント      (onUpdate を relay)
   └ result / error ◀── result / error   POST /v1/executions/:id/cancel
```

- `remote-tools.ts`: ツールのメタデータ（名前・説明・TypeBox スキーマ）はローカルで生成した SDK 組込み定義から借り、`execute` だけを差し替える。grep / find が BFF ローカルで rg / fd を起動しないよう、検索プロセスも含めてすべてサンドボックス側で完結する。未知のツール名（`powershell` など）は設定ミスとして例外にする
- `service.ts`: SDK のローカルツール実装を実ファイルシステムに対して実行し、NDJSON（`start` / `update` / `result` / `error`）で応答する。bash は `exposeSessionEnvironment: false` で生成しセッションメタ変数を子プロセスへ注入しない。さらに `spawnHook` で `PI_SANDBOX_TOKEN` を子プロセスの env から剥がす（サンドボックス内の唯一の秘密値がツール出力へ現れないようにする）
- `client.ts`: ストリームを解釈して SDK の `execute()` 契約（`onUpdate` / 最終結果 / abort）へ写し替える。abort は cancel エンドポイント（専用タイムアウト付き signal で送信。実行IDが判明後）と接続切断の両方でサンドボックスへ伝播し、サンドボックス側は SDK ツールの `AbortSignal` で子プロセスを殺す

## 認証と到達性

- すべての `/v1/*` は `Authorization: Bearer PI_SANDBOX_TOKEN` を要求し、長さを漏らさない定数時間比較で検証する。未認証は 401
- `/healthz` は無認証（Compose healthcheck 用）。ツール実行の情報は含まない
- ツール実行APIはホストへ publish しない。BFF ⇄ サンドボックスは専用の内部ネットワークのみで到達する。トークンは BFF とサンドボックスの 2 サービスにのみ渡す（LLM 認証情報とは別の値）。ホスト上の別プロセスで起動する場合は `SANDBOX_HOST=127.0.0.1` を指定する（既定は `0.0.0.0` で LAN へ露出する）
- `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定のとき、BFF はセッション作成を 503 で拒否する（ローカル実行へのフォールバックなし）

## パスと並行実行

- BFF のワークスペース root（`PI_APP_CWD=/workspace`）とサンドボックスの作業領域 root（`PI_SANDBOX_CWD=/workspace`）を同じコンテナ内パスに揃え、パス変換なしでサンドボックス側へ解決させる。セッションごとの作業ディレクトリは root 相対で渡し、サンドボックスが root と結合して実パスにする（[projects.md](projects.md)）。作業領域の永続マウントはサンドボックスだけへ付け、BFF には付けない
- `..` の適用順はカーネル（symlink を辿ってから `..`）に合わせ、lexical な畳み込みはしない。root 内外の判定は realpath で解決した実パスで行う
- 実行は toolCallId / executionId 単位で独立し、複数セッションの並行実行でも要求と出力が混線しない。ブラウザ切断はランに影響せず、明示停止（`POST /stop` → `session.abort()`）だけが対象のツール実行を中断する

## 配布イメージと起動契約

- イメージは BFF とサンドボックスで共用し、`command` だけ差し替える（`node --import tsx src/sandbox/index.ts`）。CD（`final` ステージ）の単一イメージ前提を維持する
- イメージには bash / git / ripgrep / fd を事前搭載する。ripgrep・fd はサンドボックス内で必要。fd は Debian の fd-find（bookworm は 8.6.0）だと pi SDK の find ツールが渡す `--no-require-git`（fd 9.0 で追加）を受け付けず git 管理外のディレクトリで必ず失敗するため、`scripts/install-fd.mjs` でリリースバイナリ（sha256 固定）を `test` / `final` の両ステージへ入れる
- サンドボックスは非rootの `node` ユーザー（UID/GID 1000）で動く。ホスト側の永続領域実パス・所有権・Compose 構成はデプロイ側リポジトリ（self-hosted-runner）で管理する（[persistence.md](persistence.md)）

## 残存リスク

- 非rootコンテナ・別プロセスは完全な隔離ではない。同一ユーザーのサンドボックス内では会話間のセキュリティ分離はなく、ファイル・ポート・Git の共有情報は競合し得る
- ホスト上の別プロセスとして起動したサンドボックスは BFF と同一ユーザー・同一環境になる。親シェルから export した APIキーは継承され、同一ユーザーが読める認証ファイル（`~/.pi/agent/auth.json` など）も読める。この構成の分離はプロセス分離であり、コンテナ分離ではない
- サンドボックスから外向きの通信は制限していない。ツールで実行したコードはネットワークへ到達できる。ネットワーク制限・リソース上限の具体値はデプロイ側の運用に委ねる
- ユーザーが作業領域へ置いたファイルの内容はツールから読める。認証情報を作業領域へ置かない運用とする
- bash ツールの出力が切り詰められた場合、フル出力はサンドボックス内の一時ファイルへ書かれる。ファイル自体はマスクされないが、それを読むツール出力はマスクされる（[secrets.md](secrets.md)）
