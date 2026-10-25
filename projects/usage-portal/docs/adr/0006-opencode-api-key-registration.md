# ADR 0006: OpenCode Go の API キーを Web UI から登録する

- Status: accepted
- Date: 2026-10-25

## 背景

OpenCode Go の利用枠を取るには API キーが要る。v1 は `OPENCODE_API_KEY` を `.env` からしか渡せず、キーの変更や
再発行のたびに `.env` を編集してコンテナを作り直す必要があった。スマホからの操作では完結できない。

Codex は Portal 専用の `CREDENTIAL_DIR` に `auth.json` を置き、Web UI のサインインで完結させている
（[0005](0005-codex-credentials-and-sign-in.md)）。OpenCode Go だけ `.env` に残すと、秘密の出所が 2 つになり、
どちらが実際に使われているかを画面から判断できない。

`docs/design.md` の非目的には「OpenCode Go の API key を Web UI から編集すること」とあるが、この制約を外す。

## 決定

- キーは `CREDENTIAL_DIR/opencode-key.json` に `{ version, apiKey, savedAt }` だけを持つ形で保存する。
  ディレクトリは 0700、ファイルは 0600。一時ファイルへ書いてから rename し、書き込み途中の JSON を
  sampler が読まないようにする。
- `OPENCODE_API_KEY` はコードから削除する。後方互換のフォールバックや自動移行は持たない。既存の `.env` の値は
  デプロイ後に画面から登録し直す。
- 画面の OpenCode Go カードに接続パネルを置き、`type="password"` の入力から登録・置き換え・解除できるようにする。
  保存済みなら保存日時を出し、キーの値も末尾の数文字も表示しない。
- 保存の前に、入力されたキーで `https://opencode.ai/inference/go/v1/usage` を 1 回叩いて検証する。
  - 200 かつ解釈できる応答のときだけ保存する
  - 401 / 403 は `invalid_key`（400）として保存しない
  - 通信失敗・schema 不一致・想定外の例外は `unavailable`（503）として保存しない
  - 検証で得た snapshot は、キーの保存と同じ排他区間で書く。直後の再取得が一時的に失敗しても、登録した値が出る
- 未登録の provider error は `config` ではなく `not_connected` にし、状態ラベルは provider を問わず「未接続」にする。
- 解除は `CREDENTIAL_DIR` のファイルと OpenCode Go の snapshot / error を削除する。sampler の排他区間で行い、
  先に始まっていた取得が古い値を書き戻さないようにする。
- 排他区間は呼ばれた順に直列化する。前の変更に続く再取得が終わるまで次の変更を始めない
  （解除の直後に前の取得が snapshot を書き戻す競合を防ぐ）。
- キーと DB の更新が食い違わないよう、DB 更新に失敗したらキーを操作前の値へ戻して 503 を返す。解除も同じ。
- API は PIN セッション必須とし、応答・ログ・DB にキーを出さない。

| Method | Path | 内容 |
| --- | --- | --- |
| GET | `/api/opencode/auth` | `{ configured, savedAt }`。値は返さない |
| PUT | `/api/opencode/key` | `{ apiKey }`。検証して保存。失敗は `invalid_key` / `unavailable` |
| DELETE | `/api/opencode/key` | キーと snapshot / error を削除して 204 |

採用しない案:

- `.env` を残して画面の登録を上書きにする: 秘密の出所が 2 つになり、「画面で消したのに取得できている」状態が起きる。
- SQLite（`DATA_DIR`）にキーを置く: `data/` は履歴としてバックアップする対象で、秘密を混ぜたくない。
- 保存時に検証しない: 誤ったキーが「取得エラー」として残り、原因が画面から分からない。検証の往復 1 回は操作時だけ。
- 末尾 4 桁のマスク表示: どのキーかを確かめるには足りず、画面に秘密の一部を出す理由にもならない。
- 画面から `.env` の値を初期値として読む: キーが未登録なのか、古い `.env` が効いているのかを区別できなくなる。

## 理由

- 秘密を `CREDENTIAL_DIR` に集約すると、バックアップ対象（`DATA_DIR`）と資格情報の扱いを分けられる。
- 保存前の検証と確定保存を 1 つの操作にまとめると、誤った値を保存して「取得エラー」になる状態を作らない。
- sampler は 5 分ごとにキーを読み直すため、登録・解除の反映にプロセスの再起動が要らない。

## 影響

- `OPENCODE_API_KEY` を読むコード・`.env.example`・README の環境変数表から該当行が消える。
- `self-hosted-runner` の `deploy/usage-portal.yml` から `env_file` を外し、`deploy/targets.json` の
  `requires_env_file` を false にできる（`PIN_HASH_B64` / `SESSION_SECRET` は先に廃止済み）。
- API キーの再発行・失効時は、OpenCode Go を開いて新しいキーを貼り付けるだけで直る。
- `/app/credentials` に置く秘密が 1 つ増える。バックアップやログには出さず、漏えい時は OpenCode Go 側でキーを失効させる。
- `docs/design.md` は親 checkout の写しのため更新しない。この ADR が非目的の該当項目を置き換える。
