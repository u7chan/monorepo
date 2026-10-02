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
- 実行環境の診断（`GET /v1/runtime/info`）も同じ認証の下に置く。診断の子プロセスは bash ツールの `spawnHook` を通らないため、環境を新規作成し、信頼ディレクトリで解決した絶対パスと固定引数だけを実行し、期限・同時数・出力上限を設ける（[sandbox-api.md](sandbox-api.md#検出の安全性と上限)）
- ツール実行APIはホストへ publish しない。BFF ⇄ サンドボックスは専用の内部ネットワークのみで到達する。トークンは BFF とサンドボックスの 2 サービスにのみ渡す（LLM 認証情報とは別の値）。ホスト上の別プロセスで起動する場合は `SANDBOX_HOST=127.0.0.1` を指定する（既定は `0.0.0.0` で LAN へ露出する）
- サンドボックスのツール API は 9418、serve（サービス）は 8080 に分ける。サービスだけをホストへ公開し、ブラウザの別タブで直接開く（以下の運用契約）。BFF に任意ポートの proxy は作らない。ファイルプレビューは従来どおり BFF が CSP / sandbox 付きで配る（[file-preview.md](file-preview.md)）。
- `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定のとき、BFF はセッション作成を 503 で拒否する（ローカル実行へのフォールバックなし）

## serve（サービス）の公開と起動・停止

エージェントは `0.0.0.0:8080` で人間に見せる Web サーバーを起動する。dev はホスト上の別プロセスなのでブラウザも 8080、prod はサンドボックスの `8016:8080` を公開する。ツール API の 9418 は公開しない。BFF の `PI_PREVIEW_PORT` はブラウザから見たポートだけを指定し、health の `previewPort` からチャットの「サービス」リンクへ渡す（HTTP / 同じ hostname の別ポート）。HTML プレビュー用の 8017 / `filePreviewPort` とは別系統。**UI 上の呼称は「サービス」**（このドキュメントの旧称「成果物」は使わない）。

- 公開枠は全会話で共有の 1 本。BFF は listen ポート（`server/src/preview-port.ts` の `SERVE_LISTEN_PORT` = 8080）へ TCP connect して稼働を判定する。HTTP は叩かない（アプリのロジックを実行せず、副作用も遅延も持ち込まない）。接続できなければ到達不可、500 を返すアプリでも到達可なら稼働中（正常性は見ない）。listen ポートは `PI_PREVIEW_PORT`（ブラウザから見たポート）とは別物で、`PI_FILE_PREVIEW_LISTEN_PORT` / `PI_FILE_PREVIEW_PORT` と同じく listen 側とブラウザ側を分ける。
- **稼働中は「閲覧中の会話のサービスが公開されている」の意味**で、ポートの空き状況ではない。稼働判定の一次情報は常にプローブで、記録は表示と操作権限のためだけに使う（コンテナ再作成後に記録が残っていても「稼働中」と嘘をつかない）。
- 稼働記録は全体で 1 つ。所有者セッション id / 作業ディレクトリ / 起動コマンド / 起動 PID / 起動時刻 / 起動世代を持ち、サンドボックスの作業領域の `<workspace root>/.u7agent/serve/state.json` へ同じ内容を書く（BFF 再起動後はそれを読んで復元する。BFF 単独の再起動では serve プロセスは消えない）。読み書きはサンドボックスの bash 実行経由で行い、BFF は作業領域に触れない。ログは同じ `<appdir>` 配下の `.u7agent/serve/app.log`（公開枠が 1 本なので 1 ファイル）。
- 所有者は「記録と**いま待受しているプロセス**の照合」（PID と起動時刻）で決める。記録があるだけでは所有者とみなさず、`mine`（閲覧中の会話）/ `other`（他会話）/ `unknown`（記録と一致しない）/ `none`（到達不可）に分ける。待受 PID は `/proc/net/tcp` の listen エントリの inode と `/proc/<pid>/fd` の照合で引く（`ss` / `fuser` / `lsof` はイメージに入っていないため）。
- 起動コマンド（作業ディレクトリ単位の成功実績）はアプリデータの `serve_commands` テーブルへ記録し、同じプロジェクトの他会話でも使える（[persistence.md](persistence.md#アプリデータsqlite)）。推測はせず、実際に serve して到達できたコマンドだけを記録する。
- 起動は既存のサンドボックス実行 API（`POST /v1/tools/bash/execute`）を BFF から呼ぶ。**新しいサンドボックス API は無い**。成功の境界は「バックグラウンド起動の shell が終わってから、期限（10 秒）までにプローブが到達可になること」。到達できたら「いま待受しているプロセス」を正として記録を書き直し、実績を更新する（失敗したコマンドで以前の成功を上書きしない）。失敗・中断でも起動を試みた事実（所有者・起動時刻・PID・ログ）は残す。
- 停止の対象は**常に「いま待受している PID」**で、記録の PID ではない。既知所有者（照合が一致）は所有者の会話だけが停止でき、起動元不明のときは誰でも停止できる（誰も止められないサーバーを残さないため）。待受 PID を特定できないときは停止せず、その理由を返す（エージェントへ依頼する導線を案内する）。停止後はプローブで解放を確認してから応答する。
- 起動 / 停止 / 置き換えは BFF 全体で 1 本に直列化し（`server/src/model-settings.ts` の `MutationLock`）、判定と実行をロックの内側で行う。置き換えは確認した起動世代と実行時の世代を再照合し、不一致は 409 にする。同時要求で「両方が到達不可を確認して起動する」状態を作らない。
- 状態の取得は閲覧中の会話から見た値を返し、**BFF の状態取得失敗（プローブ / サンドボックス呼び出しの失敗）と到達不可は別物**として扱う（失敗は 502 / 503、UI はリンクも操作も出さない）。
- エージェントには BFF ローカルの `serve` ツール（`start` / `stop` / `status`）と組み込みスキル `serve` を渡す。所有者はモデルに申告させず、BFF がツール呼び出し元の会話へ束縛する。起動の作法（`nohup`、`--host 0.0.0.0 --port 8080 --strictPort`、`curl -fsS http://127.0.0.1:8080/` での検証、ログの見方）は system prompt ではなくそのスキルが持つ（[api-catalog.md](api-catalog.md#組み込みスキル)）。
- エージェントが生の `bash` で起動した場合は所有者と起動コマンドが残らず、到達可でも「起動元不明」として表示する（禁止はしない。待受 PID の照合で誤表示は避ける）。
- 別タブのサービスはファイルプレビューの CSP / iframe sandbox を継承しない。自身の API / WebSocket / HMR を使える一方、ネットワーク通信も可能。BFF へのブラウザ書き込みは [Origin / CSRF 対策](api.md#ブラウザからの書き込みorigin--csrf-対策)で拒否する。
- localStorage はアプリ・HTML プレビューとは分離されるが、serve 枠を入れ替えても同じオリジンの保存領域を共有する。Cookie はポートでは分離されない。HTTP の LAN IP では secure context が必要なブラウザ API は利用できない。
- 無認証の LAN 公開面が 1 つ増える。信頼する閉域 LAN 内のみで使い、外部公開しない。LAN / WSL2 の別端末からはサービスのポートの到達（必要なら portproxy）も用意する。dev の 8080 が既に使われていると serve できない。固定枠を変える回避機能は作らない。
- コンテナ停止・再作成で serve プロセスは消える。自動復旧 / 自動再起動 / エラー時の自動再調査は持たない（UI は状態を出すだけで、勝手に起動し直さない）。複数 serve の同時公開、会話ごとのポート、別ポートの公開も対象外。

## パスと並行実行

- BFF のワークスペース root（`PI_APP_CWD=/workspace`）とサンドボックスの作業領域 root（`PI_SANDBOX_CWD=/workspace`）を同じコンテナ内パスに揃え、パス変換なしでサンドボックス側へ解決させる。セッションごとの作業ディレクトリは root 相対で渡し、サンドボックスが root と結合して実パスにする（[projects.md](projects.md)）。作業領域の永続マウントはサンドボックスだけへ付け、BFF には付けない
- `..` の適用順はカーネル（symlink を辿ってから `..`）に合わせ、lexical な畳み込みはしない。root 内外の判定は realpath で解決した実パスで行う
- `write` / `edit` はセッションの作業ディレクトリと `<root>/.agents/skills` の内側だけに書ける。ツール定義（実行 cwd）に加えて要求 cwd の lexical 形を許可 root に焼き込み、SDK が解決した絶対パスを `resolve()` で `..` まで畳んで比較する（realpath / `lstat` は使わない）。拒否は 200 の `error` イベントで返す（HTTP 400 の JSON ラッパーをモデルに見せない）。`read` / `grep` / `find` / `ls` / `bash` は制限しない。これはモデルの取り違えを防ぐファイルツールのポリシーで、`bash` のリダイレクトは塞げない（[projects.md](projects.md#write--edit-の書き込み範囲)）
- 実行は toolCallId / executionId 単位で独立し、複数セッションの並行実行でも要求と出力が混線しない。ブラウザ切断はランに影響せず、明示停止（`POST /stop` → `session.abort()`）だけが対象のツール実行を中断する

## 配布イメージと起動契約

- イメージは BFF とサンドボックスで共用し、`command` だけ差し替える（`node --import tsx src/sandbox/index.ts`）。CD（`final` ステージ）の単一イメージ前提を維持する
- イメージには bash / git / ripgrep / fd を事前搭載する。ripgrep・fd はサンドボックス内で必要。fd は pi SDK の find ツールが渡す `--no-require-git`（fd 9.0 で追加）を満たす必要があり、apt の fd-find はベースイメージの追随で要件を割る版（bookworm は 8.6.0）に戻り得るため、`scripts/install-fd.mjs` でリリースバイナリ（sha256 固定）を `test` / `final` の両ステージへ入れる（trixie の fd-find は 10.2.0 で条件を満たすが、取得方式は変えていない）
- HTTP 取得とアセット検証用に curl / jq / file / unzip / xz / zip も入れる。curl を正規手段にして `node -e` のワンライナー fetch へ迂回させないのが目的で、この一覧は `server/src/agent.ts` の `appendSystemPrompt` が名指しする。apt 行から落ちた場合は `final` ステージの `command -v` 検査でビルドが失敗する
- Python は 3.13 系（ベース `node:24-trixie-slim` の apt `python3`。実測 3.13.5）と uv（`ghcr.io/astral-sh/uv:0.12.18` から `/uv` / `/uvx` を COPY）を入れる。`python3-pip` は入れない — pip が要るのは `uv venv --seed` か `python3 -m venv` の ensurepip だけで、uv の経路は `uv pip install --python .venv/bin/python` で完結する。`command -v` 検査は uv を COPY した後の apt の RUN にあり、`python3` と `uv` も見る
- Python の依存は**作業ディレクトリ直下の `.venv`** に入れる。イメージ内の `/home/node` はコンテナのレイヤに属し、永続マウントは `/workspace`（と会話ストア）にしかないため、`~/.local` や `uv tool` の既定先に置いた依存は再作成で消える。`.venv` は作成時の絶対パスを内部に持つので、同じイメージ・同じマウント先・同じ絶対パスなら再作成後もそのまま使える（`uv venv` の既定は system Python を使い、`pyvenv.cfg` の `home` は apt の `/usr/bin` を指す）。ただし venv の運用は `appendSystemPrompt` の方針で、`~/.local` / `--target` / `--prefix` への導入は技術的に防いでいない（[残存リスク](#残存リスク)）
- サンドボックスは非rootの `node` ユーザー（UID/GID 1000）で動く。ホスト側の永続領域実パス・所有権・Compose 構成はデプロイ側リポジトリ（self-hosted-runner）で管理する（[persistence.md](persistence.md)）

## 残存リスク

- 非rootコンテナ・別プロセスは完全な隔離ではない。同一ユーザーのサンドボックス内では会話間のセキュリティ分離はなく、ファイル・ポート・Git の共有情報は競合し得る
- ホスト上の別プロセスとして起動したサンドボックスは BFF と同一ユーザー・同一環境になる。親シェルから export した APIキーは継承され、同一ユーザーが読める認証ファイル（`~/.pi/agent/auth.json` など）も読める。この構成の分離はプロセス分離であり、コンテナ分離ではない
- サンドボックスから外向きの通信は制限していない。ツールで実行したコードはネットワークへ到達できる。ネットワーク制限・リソース上限の具体値はデプロイ側の運用に委ねる
- ユーザーが作業領域へ置いたファイルの内容はツールから読める。認証情報を作業領域へ置かない運用とする
- `write` / `edit` の書き込み範囲はファイルツールのポリシーで、実行隔離ではない。同じファイルへ `bash` からは書ける。判定が lexical のため、作業領域内に置かれた symlink 経由の脱出（既存・壊れたリンクとも）も検知しない（親ディレクトリを作る `mkdir` はポリシー判定を通すので、拒否パスに親はできない）
- bash ツールの出力が切り詰められた場合、フル出力はサンドボックス内の一時ファイルへ書かれる。ファイル自体はマスクされないが、それを読むツール出力はマスクされる（[secrets.md](secrets.md)）
