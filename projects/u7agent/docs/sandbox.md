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
- サンドボックスのツール API は 9418、serve（サービス）は 8080 に分ける。8080 は publish せず、ブラウザへ公開するのは BFF の 3 本目のリスナー（サービス オリジン）だけにする（以下の運用契約）。BFF は任意ポートの proxy は作らないが、サービス 1 本だけはこのリスナーで受けて `PI_SANDBOX_URL` のホストの 8080 へ転送する。ファイルプレビューは従来どおり BFF が CSP / sandbox 付きで配る（[file-preview.md](file-preview.md)）。
- `PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN` が未設定のとき、BFF はセッション作成を 503 で拒否する（ローカル実行へのフォールバックなし）

## serve（サービス）の公開と起動・停止

エージェントは `0.0.0.0:8080` で人間に見せる Web サーバーを起動する。ツール API の 9418 は公開しない。ブラウザへ公開するのは BFF の 3 本目のリスナー（サービス オリジン）で、BFF が `PI_SANDBOX_URL` のホストの 8080 へ転送する。待受は `PI_SERVICE_LISTEN_PORT`（既定 4319）、ブラウザから見た値は `PI_PREVIEW_PORT`（未設定は待受へ寄せる。prod は compose が `8016:<待受>` を publish して 8016 を載せる）。health の `previewPort` は後者で、チャットの「サービス」リンクへ渡す（HTTP / 同じ hostname の別ポート）。HTML プレビュー用の 8017 / `filePreviewPort` とは別系統。**UI 上の呼称は「サービス」**（このドキュメントの旧称「成果物」は使わない）。dev（`pnpm dev`）も同じ経路を通り、アプリは 8080 のまま、ブラウザは BFF のサービス リスナーを開く。

- キャッシュは全レスポンスで `Cache-Control: no-store` へ正規化する（アプリが返した `Cache-Control` / `Expires` は落とす）。あわせて **GET / HEAD の再検証ヘッダ（`If-None-Match` / `If-Modified-Since`）だけは上流へ渡さない**。置き換え先の `Last-Modified` が置き換え元以下・同一のときに 304 が成立し、前のアプリの本文が再利用されるのを防ぐ（`Last-Modified` は URL をまたいで比較できない値。書き込みメソッドの `If-None-Match: *` など前提条件は透過させる）。
- 転送ではメソッド / パス / クエリ / ボディ / ストリーミング / `Range` / `Content-Encoding` を透過し、ホップバイホップ ヘッダ（`Connection` / `Transfer-Encoding` など）は落とす。`Location` が内部ホスト（`u7agent-sandbox:8080` / `127.0.0.1:8080` など）を指すときは、ブラウザから見たオリジンの URL へ直す。8080 へ到達できないときは短い 502 を返す（稼働中 / 停止中の判定は従来どおりプローブ）。
- 公開枠は全会話で共有の 1 本。BFF は listen ポート（`server/src/preview-port.ts` の `SERVE_LISTEN_PORT` = 8080）へ TCP connect して稼働を判定する。HTTP は叩かない（アプリのロジックを実行せず、副作用も遅延も持ち込まない）。接続できなければ到達不可、500 を返すアプリでも到達可なら稼働中（正常性は見ない）。転送先もこの 8080 固定で、ブラウザから見た `PI_PREVIEW_PORT` は BFF のサービス リスナーのポートを指す。
- **稼働中は「閲覧中の会話のサービスが公開されている」の意味**で、ポートの空き状況ではない。稼働判定の一次情報は常にプローブで、記録は表示と操作権限のためだけに使う（コンテナ再作成後に記録が残っていても「稼働中」と嘘をつかない）。
- 稼働記録は全体で 1 つ。所有者セッション id / 作業ディレクトリ / 起動コマンド / 起動 PID / 起動時刻 / 起動世代を持ち、サンドボックスの作業領域の `<workspace root>/.u7agent/serve/state.json` へ同じ内容を書く（BFF 再起動後はそれを読んで復元する。BFF 単独の再起動では serve プロセスは消えない）。読み書きはサンドボックスの bash 実行経由で行い、BFF は作業領域に触れない。ログは同じ `<appdir>` 配下の `.u7agent/serve/app.log`（公開枠が 1 本なので 1 ファイル）。
- 所有者は「記録と**いま待受しているプロセス**の照合」で決める。照合の根拠は待受ソケットの inode（`/proc/net/tcp` の listen エントリ）で、記録があるだけでは所有者とみなさず、`mine`（閲覧中の会話）/ `other`（他会話）/ `unknown`（記録と一致しない）/ `none`（到達不可）に分ける。**inode の読み取りは状態表示でも行うが、重い fd 走査（`/proc/<pid>/fd` をたどって PID を特定する処理）は必要なときだけ行う**（停止対象の決定と、起動したプロセスが待受を始めたかの判定）。**この走査は bash 実行ではなくサンドボックス service 本体で行う**（`GET /v1/procs/listeners`）: bash 実行は Landlock の ptrace 制限で他ドメインの `/proc/<pid>/fd` を読めない（自分の子孫は読める）ため、制限の外にいる service が代行する。走査は service の 1 プロセスで行い、fd ごとに外部コマンドを起動しない（高負荷時に 15 秒以上かかり、状態取得のタイムアウトと表示のスタックを起こしていた）。
- 起動コマンド（作業ディレクトリ単位の成功実績）はアプリデータの `serve_commands` テーブルへ記録し、同じプロジェクトの他会話でも使える（[persistence.md](persistence.md#アプリデータsqlite)）。推測はせず、実際に serve して到達できたコマンドだけを記録する。
- セッションの引っ越し（[api-sessions.md](api-sessions.md#post-apisessionsidmove)）は稼働中でも許可し、`serve_commands` は移動先の cwd へ付け替える。ただし `.u7agent/serve/state.json` の記録 cwd と稼働中プロセスの cwd inode は移動前に残るため、status の起動コマンドの cwd が実プロセスと食い違い得る（相対パスで動くアプリは継続し、絶対パス前提のアプリは壊れ得る）。これは既知の制限で、移動を 409 で止める案は採らない。
- 起動時の環境変数（作業環境 → 環境変数）は、`POST /v1/tools/bash/execute` の `env` フィールドで渡し、起動したプロセスの子孫へ継承させる。**値は起動スクリプトのコマンド文字列へ埋めない**（base64 化もしない）。解決は起動元の作業フォルダの `cwd` から行い、解決に失敗したら起動しない（[secrets.md](secrets.md#作業フォルダの環境変数)、[sandbox-api.md](sandbox-api.md#post-v1toolstoolexecute)）。サンドボックスの `bash` は子プロセスから `PI_SANDBOX_TOKEN` と master key を剥がす
- 起動・停止・記録の読み書きは既存のサンドボックス実行 API（`POST /v1/tools/bash/execute`）を BFF から呼ぶ（作業領域を触る処理は bash 実行に集め、BFF は作業領域に触れない）。待受ソケットと PID の観測だけは上の `GET /v1/procs/listeners`（読み取り専用）を使う。作業ディレクトリも起動コマンドも base64 で渡し、shell の構文として評価させない（パス中の `$` やバッククォートで起動が壊れない）。**起動したアプリは作業ディレクトリと `/tmp`・ホームのキャッシュの外へ書けない**（起動の writeScope に起動対象の workdir と `<root>/.u7agent/serve` だけを渡し、子孫へ Landlock が継承されるため。ログは `<root>/.u7agent/serve/app.log` に落とす）。成功の境界は「バックグラウンド起動の shell が終わってから、期限（10 秒）までにプローブが到達可になり、**かつ到達した待受プロセスがその起動に由来すること**（起動 PID 自身か、その子孫）を確かめられること」。期限超過した別の起動が遅れて listen しても、それを今回の成功とは扱わない（所有者も実績も更新しない）。到達できたら「いま待受しているプロセス」を正として記録を書き直し、実績を更新する（失敗したコマンドで以前の成功を上書きしない）。失敗・中断でも起動を試みた事実（所有者・起動時刻・PID・ログ）は残す。
- 停止の対象は**常に「いま待受している PID」**で、記録の PID ではない。会話からの停止では、既知所有者（照合が一致）は所有者の会話だけが停止でき、起動元不明のときは誰でも停止できる（誰も止められないサーバーを残さないため）。設定 → ランタイムからは会話の選択に関係なく全体を管理できる（[全体管理の契約](api.md#ランタイムからの全体管理)）。待受 PID を特定できないときは停止せず、その理由を返す（エージェントへ依頼する導線を案内する）。停止後はプローブで解放を確認してから応答する。
- 起動 / 停止 / 置き換えは BFF 全体で 1 本に直列化し（`server/src/model-settings.ts` の `MutationLock`）、判定と実行をロックの内側で行う。置き換えは確認した値（起動世代 + いま待受しているソケットの inode）と実行時の値を再照合し、不一致は 409 にする（記録を残したまま生の bash で入れ替わった場合も検知する）。同時要求で「両方が到達不可を確認して起動する」状態を作らない。
- 状態の取得は閲覧中の会話から見た値を返し、**BFF の状態取得失敗（プローブ / サンドボックス呼び出しの失敗）と到達不可は別物**として扱う（失敗は 502 / 503、UI はリンクも操作も出さない）。取得は短くキャッシュし、複数タブが同じ結果を使う（起動・停止の直後は必ず捨てる）。
- エージェントには BFF ローカルの `serve` ツール（`start` / `stop` / `status`）と組み込みスキル `serve` を渡す。所有者はモデルに申告させず、BFF がツール呼び出し元の会話へ束縛する。起動の作法（`nohup`、`--host 0.0.0.0 --port 8080 --strictPort`、`curl -fsS http://127.0.0.1:8080/` での検証、ログの見方）は system prompt ではなくそのスキルが持つ（[api-catalog.md](api-catalog.md#組み込みスキル)）。
- エージェントが生の `bash` で起動した場合は所有者と起動コマンドが残らず、到達可でも「起動元不明」として表示する（禁止はしない。待受 PID の照合で誤表示は避ける）。
- 別タブのサービスはファイルプレビューの CSP / iframe sandbox を継承しない。自身の HTTP API は使え、ネットワーク通信も可能。**WebSocket（upgrade）の転送は未実装**で、upgrade を使うアプリ（Vite の HMR を含む）はサービス オリジン経由では動かない（別 Issue とする）。BFF へのブラウザ書き込みは [Origin / CSRF 対策](api.md#ブラウザからの書き込みorigin--csrf-対策)で拒否する。
- localStorage はアプリ・HTML プレビューとは分離されるが、serve 枠を入れ替えても同じオリジンの保存領域を共有する。Cookie はポートでは分離されない。HTTP の LAN IP では secure context が必要なブラウザ API は利用できない。
- 無認証の LAN 公開面が 1 つ増える。信頼する閉域 LAN 内のみで使い、外部公開しない。LAN / WSL2 の別端末からはサービス オリジンのポート（dev は `PI_SERVICE_LISTEN_PORT` の 4319、prod は 8016）の到達（必要なら portproxy）も用意する。dev の 8080 が既に使われていると serve できない。固定枠を変える回避機能は作らない。
- コンテナ停止・再作成で serve プロセスは消える。自動復旧 / 自動再起動 / エラー時の自動再調査は持たない（UI は状態を出すだけで、勝手に起動し直さない）。複数 serve の同時公開、会話ごとのポート、別ポートの公開も対象外。

## パスと並行実行

- BFF のワークスペース root（`PI_APP_CWD=/workspace`）とサンドボックスの作業領域 root（`PI_SANDBOX_CWD=/workspace`）を同じコンテナ内パスに揃え、パス変換なしでサンドボックス側へ解決させる。セッションごとの作業ディレクトリは root 相対で渡し、サンドボックスが root と結合して実パスにする（[projects.md](projects.md)）。作業領域の永続マウントはサンドボックスだけへ付け、BFF には付けない
- `..` の適用順はカーネル（symlink を辿ってから `..`）に合わせ、lexical な畳み込みはしない。root 内外の判定は realpath で解決した実パスで行う
- **bash とその子プロセスは Landlock でファイルの作成・書き込み・削除・rename・truncate を制限する**。許可 root は実行ごとにサンドボックスが組み立て、pi SDK の `BashToolOptions.shellPath` に渡したラッパー（`u7agent-landlock`）が `PR_SET_NO_NEW_PRIVS` → `landlock_restrict_self` → `exec` する。結果は許可 root の外側で `EACCES`（HTTP 400 ではない）になり、リダイレクト・`cp`・`mv` も同じ。子プロセスへ継承されるため、bash から起動したサーバーやビルドも同じ制限の下で動く
  - エージェントの bash の許可 root（基準集合）は実行 cwd（realpath）・`<root>/.agents/skills`・`/tmp`・ホーム配下のキャッシュ（`~/.cache` / `~/.npm` / `~/.local/share/pnpm`）・`/dev/null` と `/dev/shm`。読み取りは制限しない（Landlock の read 権利は扱わない）
  - BFF 内部で走らせる bash（serve の観測・記録・起動・停止）は要求 cwd から基準集合を導出せず、呼び出し側が渡した `writeScope`（root 相対）だけを要求由来の root にする。固定の `/tmp` とキャッシュ、デバイスファイルは全実行で共通
  - ラッパーは許可 root の外の固定パス（イメージは `/usr/local/bin`、dev は `$HOME/.local/libexec/u7agent`）に置き、PATH ではなく実体（realpath）を確認してから使う。見つからない / カーネルが Landlock に対応しない / ABI 3 未満では**bash を実行しない**（fail-closed）。`bash` の実行は 200 の `error` イベントで理由を返し、サービス自体は起動して診断（設定 → ランタイム）で理由を見られる
  - Landlock は存在するパスにしか rule を付けられない。無ければ作ってよいと宣言された root（`<root>/.agents/skills`、`<root>/.u7agent/serve`、ホームのキャッシュ）だけを mkdir してから rule を追加し、要求由来のパスは作らない
  - 権利は ABI に応じて決める（ABI 3 未満は実行しない）。`LANDLOCK_ACCESS_FS_TRUNCATE` は ABI 3、`LANDLOCK_ACCESS_FS_REFER` は ABI 2 で追加された。ディレクトリ以外のパス（`/dev/null`）にはディレクトリ向けの権利を渡さない（`LANDLOCK_ACCESS_FS_MAKE_*` を渡すと `landlock_add_rule` が `EINVAL` になる）
- `write` / `edit` はセッションの作業ディレクトリと `<root>/.agents/skills` の内側だけに書ける。判定は SDK が解決した絶対パスを `resolve()` で `..` まで畳んだうえで行うが、**実在する候補は `realpath` で解決した実パスと許可 root の実パスを比較する**ため、cwd 内に置いた外部向け symlink 経由の脱出も拒否する（root 内を指す symlink は通す）。**許可 root の実パスは判定のたびに解決し直す**（未作成の root を祖先で固定すると、後から symlink に置き換えられたときに root 外を通してしまう）。拒否は 200 の `error` イベントで返す（HTTP 400 の JSON ラッパーをモデルに見せない）。`read` / `grep` / `find` / `ls` は制限しない（[projects.md](projects.md#write--edit-の書き込み範囲)）
- 実行は toolCallId / executionId 単位で独立し、複数セッションの並行実行でも要求と出力が混線しない。ブラウザ切断はランに影響せず、明示停止（`POST /stop` → `session.abort()`）だけが対象のツール実行を中断する

## 配布イメージと起動契約

- イメージは BFF とサンドボックスで共用し、`command` だけ差し替える（`node --import tsx src/sandbox/index.ts`）。CD（`final` ステージ）の単一イメージ前提を維持する
- イメージには bash / git / ripgrep / fd を事前搭載する。ripgrep・fd はサンドボックス内で必要。fd は pi SDK の find ツールが渡す `--no-require-git`（fd 9.0 で追加）を満たす必要があり、apt の fd-find はベースイメージの追随で要件を割る版（bookworm は 8.6.0）に戻り得るため、`scripts/install-fd.mjs` でリリースバイナリ（sha256 固定）を `test` / `final` の両ステージへ入れる（trixie の fd-find は 10.2.0 で条件を満たすが、取得方式は変えていない）
- **Landlock ラッパー（`scripts/landlock-exec.py` → イメージの `/usr/local/bin/u7agent-landlock`）を同梱する**。bash はこのラッパー経由でしか起動せず、ラッパーを解決できなければ実行しない。Python 実装なので `python3` が要る（`final` は既存の apt のもの）。dev は `pnpm dev` が `$HOME/.local/libexec/u7agent` へ配置する（許可 root の外に置き、エージェント自身に書き換えられないようにするため。単体でフォークを起こすときは `node scripts/install-landlock.mjs`）
- ラッパーの前提は **Linux かつ Landlock ABI 3 以上（カーネル 6.2 以上）**と、Landlock の 3 syscall を通す **Docker 24 以上**（既定 seccomp profile）。`test` ステージにも python3 とラッパーを入れ、ビルド時に `--abi` と「許可 root の外への書き込みが拒否されること」を probe する（テストの skip に頼らずビルドを失敗させる）。`final` には probe を置かない
- HTTP 取得とアセット検証用に curl / jq / file / unzip / xz / zip も入れる。curl を正規手段にして `node -e` のワンライナー fetch へ迂回させないのが目的で、この一覧は `server/src/agent.ts` の `appendSystemPrompt` が名指しする。apt 行から落ちた場合は `final` ステージの `command -v` 検査でビルドが失敗する
- Python は 3.13 系（ベース `node:24-trixie-slim` の apt `python3`。実測 3.13.5）と uv（`ghcr.io/astral-sh/uv:0.12.18` から `/uv` / `/uvx` を COPY）を入れる。`python3-pip` は入れない — pip が要るのは `uv venv --seed` か `python3 -m venv` の ensurepip だけで、uv の経路は `uv pip install --python .venv/bin/python` で完結する。`command -v` 検査は uv を COPY した後の apt の RUN にあり、`python3` と `uv` も見る
- Python の依存は**作業ディレクトリ直下の `.venv`** に入れる。イメージ内の `/home/node` はコンテナのレイヤに属し、永続マウントは `/workspace`（と会話ストア）にしかないため、`~/.local` や `uv tool` の既定先に置いた依存は再作成で消える。`.venv` は作成時の絶対パスを内部に持つので、同じイメージ・同じマウント先・同じ絶対パスなら再作成後もそのまま使える（`uv venv` の既定は system Python を使い、`pyvenv.cfg` の `home` は apt の `/usr/bin` を指す）。`--target` / `--prefix` を作業ディレクトリ内で使うことは方針として防いでいないが、`~/.local` 全体（`uv tool` の既定先を含む）は Landlock の許可 root の外なので bash の子プロセスからは書けない（pnpm 用の `~/.local/share/pnpm` だけを許可している。[残存リスク](#残存リスク)）
- サンドボックスは非rootの `node` ユーザー（UID/GID 1000）で動く。ホスト側の永続領域実パス・所有権・Compose 構成はデプロイ側リポジトリ（self-hosted-runner）で管理する（[persistence.md](persistence.md)）

## 残存リスク

- 転送はバッファせずストリームで返すが、大きいファイルや長時間の SSE では BFF 経由のオーバーヘッドが乗る
- この変更より前にブラウザへ保存された古い本文は、URL が同じである限り初回だけヒューリスティック鮮度で再利用され得る（リロードで解消する。URL をアプリごとに分ける案は公開枠の分割と同じ大きさで対象外）。サービス オリジンは共有のままなので、アプリ間で `localStorage` も共有され続ける
- デプロイは別リポジトリ（self-hosted-runner）の変更が要る。u7agent 側が `PI_SERVICE_LISTEN_PORT` を受けられる状態で、8016 の publish 先をサンドボックスの 8080 から BFF のサービス リスナーへ切り替える
- 非rootコンテナ・別プロセスは完全な隔離ではない。同一ユーザーのサンドボックス内では会話間のセキュリティ分離はなく、ファイル・ポート・Git の共有情報は競合し得る
- ホスト上の別プロセスとして起動したサンドボックスは BFF と同一ユーザー・同一環境になる。親シェルから export した APIキーは継承され、同一ユーザーが読める認証ファイル（`~/.pi/agent/auth.json` など）も読める。この構成の分離はプロセス分離であり、コンテナ分離ではない（`U7AGENT_SECRET_MASTER_KEY` も親シェルから継承するが、`bash` の子プロセスからは剥がす）
- サンドボックスから外向きの通信は制限していない。ツールで実行したコードはネットワークへ到達できる。ネットワーク制限・リソース上限の具体値はデプロイ側の運用に委ねる
- ユーザーが作業領域へ置いたファイルの内容はツールから読める。認証情報を作業領域へ置かない運用とする
- `write` / `edit` の許可場所はファイルツールのポリシーだが、bash 側は Landlock で強制される。同じプロジェクトの複数セッションは cwd を共有するため互いのファイルは壊せ、`/tmp` と `/dev/shm` も全セッション共有。読み取りは制限しないため、プロンプトインジェクションによる既存ファイルの持ち出しは残る
- Landlock は `chmod` / `chown` / `utime` / `setxattr` を制限できない（カーネルドキュメントの limitations）。許可 root の外でもファイル属性は変更できるため、**内容の作成・変更・削除・rename・truncate までが保証**で、他プロジェクトの破壊を完全には防げない。同じ理由で `flock` / `stat` / `chdir` も制限しない
- Landlock のない環境（Linux 6.2 未満、macOS、ラッパー未配置）では `bash` を実行できない（fail-closed）。dev は同一ユーザーで動くため、`~/.cache` / `~/.npm` の許可は開発者本人の実キャッシュへの書き込み許可になる。`pnpm dev` で検証するときは `PI_SESSION_STORE` を設定し、通常スペースの未所属 cwd が root になる縮退（root 全体が許可される）を避ける（[projects.md](projects.md#write--edit-の書き込み範囲)）
- ABI 4（Linux 6.8）では device ioctl が対象外（ABI 5 で追加）。外向き通信の制限（Landlock の network 権利、egress 制限）も対象外
- bash ツールの出力が切り詰められた場合、フル出力はサンドボックス内の一時ファイルへ書かれる。ファイル自体はマスクされないが、それを読むツール出力はマスクされる（[secrets.md](secrets.md)）
