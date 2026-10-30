# サンドボックスのランタイム診断 API

サンドボックス自身の実行環境（ツール・バージョン・制約）と、待受ソケット / 所有 PID の観測の内部 API。どちらも認証必須・読み取り専用で、観測だけを行い状態を変えない。認証と規約は [sandbox-api.md](sandbox-api.md)、利用者から見た診断は [diagnostics.md](diagnostics.md) を参照する。

## `GET /v1/runtime/info`

サンドボックス自身の実行環境と、allowlist のうち実在したコマンドのバージョンを返す。BFF の `GET /api/runtime/environment` がこの API を呼び、状態コード付きの公開 DTO へ写す（[api.md](api.md#実行環境サンドボックス診断)）。

```json
// response
{
  "environment": {
    "os": "Debian GNU/Linux 13 (trixie)",
    "arch": "x86_64",
    "user": "node",
    "isRoot": false,
    "workspace": "/workspace"
  },
  "commands": [
    { "name": "curl", "version": "8.14.1" },
    { "name": "npm", "version": null }
  ],
  "landlock": { "state": "enabled", "abi": 6, "minAbi": 3 }
}
```

- `environment` は OS の名称と版（`/etc/os-release` の `PRETTY_NAME`。取れなければ `不明`）、正規化した CPU アーキテクチャ（`x86_64` / `aarch64` など）、実行ユーザー名、UID 0 で動いているか、ワークスペース root。環境変数の値・認証ファイル・ホストの情報は返さない
- `commands` は固定 allowlist（`curl` / `node` / `npm` / `npx` / `python3` / `uv` / `git` / `rg` / `fd` / `jq` / `file` / `tar` / `gzip` / `unzip` / `zip` / `xz` / `openssl` / `bash`）のうち実在したものだけを allowlist の順で返す。Dockerfile のビルド用ステージにしか無いツールは含まれない。`version` は出力から抽出・正規化した値で、存在は確認できたが取れなかったときは `null`（UI は「バージョン不明」）。検出できなかったコマンドは一覧に含めない
- `landlock` は bash に適用する Landlock の状態。`state` は `enabled` / `unavailable`、`abi` はカーネルが対応する ABI（取れなければ `null`）、`minAbi` は実行に要求する最低 ABI（3）。`unavailable` のときだけ `reason`（`wrapper_missing` / `unsupported` / `abi_unsupported` / `probe_failed`）を付け、`enabled` 以外では bash を実行しない。ラッパーのパスや内部エラーは返さない（[sandbox.md](sandbox.md#パスと並行実行)）
- `version` は生の stdout / stderr を返さない。抽出は数字とドットだけの最初のトークンで、警告や内部パスは落とす

### 検出の安全性と上限

診断の子プロセスには SDK の `spawnHook`（bash ツールの `PI_SANDBOX_TOKEN` 除去）が適用されない。診断自体を新しい漏えい経路にしないよう、次を守る（定数は `server/src/sandbox/runtime-info.ts`）。

- 環境は `process.env` を継承せず新規作成する（`PATH` / `HOME` / `LANG` / `LC_ALL` / `TERM` だけ）。`PI_SANDBOX_TOKEN`、LLM キー、`NODE_OPTIONS` / `LD_PRELOAD` / `PYTHONPATH` / `BASH_ENV` は渡さない。`HOME` は存在しない固定値で、ユーザー別の設定やフックを読ませない
- `PATH` は信頼できるシステムディレクトリ（`/usr/local/sbin` `/usr/local/bin` `/usr/sbin` `/usr/bin` `/sbin` `/bin`）だけで組む。実行ファイルはそこで解決した絶対パスを使い、symlink は実体まで解決して、実体が信頼ディレクトリの外なら採用しない（ワークスペースや書き込み可能な PATH 上の偽コマンドを使わない）。`cwd` はワークスペース外の固定値（`/`）
- 起動はシェルを介さず、allowlist の名前と固定引数だけを使う。リクエスト値はコマンド名にも引数にも入らない
- 1 コマンド 1 秒（`RUNTIME_PROBE_PER_COMMAND_TIMEOUT_MS`）・同時 4（`RUNTIME_PROBE_MAX_CONCURRENCY`）・全体 5 秒（`RUNTIME_PROBE_TOTAL_TIMEOUT_MS`）。全体の期限を過ぎたら残りは起動せず、存在を確認できたコマンドは `version: null` で返す
- 出力は stdout + stderr の合計 64 KiB（`RUNTIME_PROBE_MAX_OUTPUT_BYTES`）を上限とし、読み込み完了を待たずストリーム受信中に打ち切る。打ち切りと期限超過では `detached` で作ったプロセスグループごと SIGKILL し、孫プロセスを残さない

この対応は診断用子プロセスからの漏えいを防ぐもので、同一ユーザーが読めるファイルや、すでに許可された `bash` 実行に対する完全な秘密隔離を保証しない（[sandbox.md](sandbox.md#残存リスク)）。

## `GET /v1/procs/listeners`

指定ポートの待受ソケットと、`scan=true` のときだけその所有プロセスを返す。serve の所有者照合（起動の確認と停止対象の特定）が使う内部 API。`from` / `to` のレンジ指定では、待受のあるポートの一覧を返す。

```
GET /v1/procs/listeners?port=8080&scan=true
```

```json
// response
{
  "inodes": [1270278],
  "addressScopes": ["loopback"],
  "listener": {
    "pid": 237424,
    "startedAt": 1700000000000,
    "inodes": [1270278],
    "ancestors": [237424, 237400]
  }
}
```

```
GET /v1/procs/listeners?from=18000&to=18099
```

```json
// response
{ "ports": [{ "port": 18000, "inodes": [1270280] }] }
```

- `inodes` — `/proc/net/tcp` と `/proc/net/tcp6` の LISTEN エントリから取った、指定ポートの待受ソケット inode（昇順）。待受が無ければ空配列。状態表示はこれと記録の inode の照合だけで所有者を分類する
- `addressScopes` — `inodes` と同じ添字で対応する待受アドレスの種別。`loopback` は IPv4 の 127.0.0.0/8 と IPv6 の `::1`、`any` は `0.0.0.0` と `::`、それ以外は `other`。v4-mapped（`::ffff:127.0.0.1` など）は IPv4 へ正規化してから分類する。同じポートに複数の待受ソケットが並ぶ場合は `inodes` の並びに合わせる。待受がループバックに限定されているかの判定に使う
- `listener` — `scan=true`（文字列の完全一致）のときだけ特定する。`pid` / `startedAt`（`/proc/<pid>/stat` の起動時刻。PID 再利用の照合に使う。0 は不明）/ `inodes` / `ancestors`（自身から親をたどった PID。起動 PID の子孫かの判定に使う）。特定できなければ `null`。`scan` が省略・他の値なら `listener` を返さず（`inodes` と `addressScopes` だけ）、fd 走査をしない
- **この走査だけは bash 実行ではなくサンドボックス service 本体のプロセスで行う**。bash 実行は Landlock の ptrace 制限で他ドメインの `/proc/<pid>/fd` を読めない（自分の子孫は読める）ため、制限の外にいる service が代行する。`/proc/<pid>/fd` は readlink できるプロセス（同一ユーザーで生存中）だけを見る
- レンジは `from` / `to` の両方で指定し、`port` とは排他（同時指定は 400）。どちらも 1..65535 の整数で、`from <= to`、`to - from + 1 <= 100` を満たす必要がある。応答の `ports` は待受のあったポートだけ（待受ゼロのポートは省く）をポート昇順で返し、`inodes` は昇順。レンジでは所有 PID の fd 走査をせず、`addressScopes` も返さない。`scan=true` をレンジと併用すると 400（一覧のポーリングに重い走査を乗せない）
- `port` / `from` / `to` が不正なら 400。読み取り専用で、ファイルは変更しない
- BFF 側はこの API の接続と本文に期限（既定 5 秒）を掛け、超過は他のサンドボックス失敗と同じ 502 にする（serve の操作は直列化されており、待ち続けると後続の操作が詰まるため）
- 認証は他の `/v1/*` と同じ Bearer 必須。BFF の serve 実装だけが呼び、モデルはツール引数から指定できない
