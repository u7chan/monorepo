# Gemini との連携（公式 CLI・取得の契機・ログアウトの例外）

- Status: accepted
- Date: 2026-11-28

## 背景

Google AI の利用枠（Antigravity の Gemini Models）をダッシュボードに出す。Google の個人向けサブスクリプションには、
Claude の OAuth usage API に相当する公開 API が無い。Antigravity CLI（`agy`）の print mode は読み取り専用の
slash command を非対話で実行でき、`/usage`（`/quota` の別名）が構造化された残量を返す。

- `agy -p "/usage" --output-format json` は `command.data.groups[].buckets[]` に `id`（`gemini-weekly` /
  `gemini-5h` / `3p-weekly` / `3p-5h`）、`window`（`weekly` / `5h`）、`remaining_fraction`、`reset_time`（UTC の
  ISO 8601）を返す。`num_turns: 0`・`usage` は全 0・`conversation_id` は空で、モデルは呼ばず会話も残らない。
- group に id は無く、`name` は自由文。bucket の `id` でグループを見分ける。
- 未ログインで `agy -p "/usage"` を実行すると OAuth ログイン待ちで止まる。`--print-timeout` でも、TTY 無し・
  stdin `/dev/null` でも止まらない。
- `agy models` は接続の判定に使える。ログイン済みは約 2 秒で exit 0、未ログインは約 1 秒で exit 1 と
  `Please sign in to view available models.` を stderr に出す。
- 設定ディレクトリの環境変数は無い。設定と token は `$HOME/.gemini/antigravity-cli` に置かれ、`HOME` を差し替えると
  分離できる。
- `/logout` は print mode で拒否され（資格情報を消す副作用が run を超えるため）、`agy logout` サブコマンドも無い。
- 返るのは Antigravity の Gemini Models グループの枠で、Gemini アプリ（gemini.google.com）や Gemini CLI の上限では
  ない。カードの固定文言でもそう伝え、プラン名は断定しない。

Claude と同じく、このポータルは PIN 認証・LAN 内・自分 1 人専用で、第三者に Gemini を提供しない。Google の規約で
CLI の非対話実行を自動で起こすことがどう扱われるかは確かめていない。

## 決定

### 取得の方法

- 公式 `agy` を子プロセスとして起動し、`agy -p "/usage" --output-format json` の `command.data.groups[].buckets[]`
  だけを読む。`response` の TSV は読まない。token を取り出して内部 API を直接叩かない。
- 読む bucket は `id` が `gemini-` で始まるものだけ。`3p-*`（Claude / GPT）は読まない。
- `window` の `5h` を rolling（id `rolling`、18000 秒）、`weekly` を weekly（id `weekly`、604800 秒）にする。
  窓の id は sample の主キー `(provider, window_id, captured_at)` に入るので、source の中で一意にし、変えない。
- 同じ window の bucket が複数あれば、使用率の最も高い bucket を採り、リセット時刻もその bucket から取る。
- `usedPercent = (1 - remaining_fraction) * 100` を 0〜100 に clamp し、100 を超えたときだけ「上限超過」の note を付ける。
- `reset_time` を ISO 8601 として読めないときは `resetsAt: null`。1970-01-01 の bucket も窓として残し、`resetsAt: null` に
  する。未知の `window` と、`remaining_fraction` が欠けた bucket は捨てる。窓が 1 つも残らなければ `schema` エラー。
- bucket の `name` / `description`（上流の自由文）は保存も表示もしない。ラベルは固定の日本語。
- 正規化した `ProviderSnapshot`（`provider: "gemini"`、source id は `gemini` 固定、plan は取れないので null）と sample
  だけを既存のテーブルへ保存する。CLI の出力本文・stderr・OAuth の URL・メールは DB・ログ・応答に残さない。
- 公式バイナリは改変せずに image へ入れ、`AGY_CLI_DISABLE_AUTO_UPDATE=1` で自動更新を止めて版を固定する。
  manifest は最新版だけを指すため、版を上げるときは両 arch の URL と SHA-512 を写し直し、fixture を実際の出力と
  突き合わせる。
- 子プロセスには `PATH` / `HOME`（`CREDENTIAL_DIR/antigravity`）/ `TZ=UTC` / `AGY_CLI_DISABLE_AUTO_UPDATE=1` だけを渡し、
  cwd は空の一時ディレクトリ、stdin は閉じる。期限は 15 秒で、超えたら SIGKILL する。

### 取得の契機

- 周期の sampler には乗せない。取るのは次の 2 つだけで、Claude と同じにする。
  - 画面を開いたとき（初回表示と、タブが見える状態へ戻ったとき）。前回の試行から 15 分以内なら CLI を起動せず、
    保存済みの値を使う。
  - カードの `⋮` メニューの「更新」。15 分の制限は受けないが、前回の試行から 60 秒は空ける。
- 絞る理由は、規約上の扱いを確かめていないこと。周期取得は、画面を見ていない間も機械的な起動を続ける。
  取得から 15 分を超えた値は `stale` として出し、更新は手動にする。失敗しても自動では再試行しない。
- 取得は認証必須・同一 origin 検査つきの `POST /api/gemini/refresh`。`GET /api/usage` は保存済みの値を読むだけで、
  上流へ取りに行かない。同時要求は single-flight にまとめる。
- 周期取得の無い provider（`claude` / `gemini`）の判定は `src/shared/on-demand.ts` の 1 か所に置き、
  server の stale 判定・取得間隔と、client の文言が同じ判定を使う。

### 接続の判定

- `agy models` で判定する。exit 0 は connected。exit 1 で stderr に既定のサインイン文言（
  `Please sign in to view available models.`）が含まれるときは `not_connected`。期限超過とそれ以外の失敗は
  `upstream`、起動できないときは `config`。ネットワークの失敗を未接続と取り違えないよう、文言まで見る。
- `/usage` は connected のときだけ起動する。未接続のまま起動すると OAuth 待ちで固まり、期限は外側の kill でしか
  止められない。`/usage` の JSON を解釈できなければ `schema`。
- stderr は判定にだけ使い、保存・ログ・応答に出さない。
- サインインは Web UI で中継しない。端末から `docker exec -it -e HOME=/app/credentials/antigravity <コンテナ名> agy` を
  実行し、`agy` 自身にサインインさせる。カードは取得前と `not_connected` では出さず、それ以外のエラーでは
  ログアウトの入口を残すために出す。未接続のあいだは全体メニューの「Gemini」に手順と「接続を確認」を置く。

### ログアウト（Claude と変える例外）

- `POST /api/gemini/logout` は `$HOME/.gemini/antigravity-cli/antigravity-oauth-token` を、**読まずに**削除する。
  token の読み取り・保存・送信はしない。これだけを例外とする。`agy` には非対話のログアウトが無く、CLI に任せられない。
- Claude は CLI の `auth logout` に任せ、進行中の取得を待たない。Gemini は、進行中の `agy` が token を書き戻す余地を
  残さないために、取得と直列にして待つ。手順は次のとおり。
  1. 世代を進め、ログアウト中の印を立てる。以後の refresh は CLI を起動せず `skipped: logout` を返す。
  2. 進行中の取得があれば終わるまで待ち、その結果は書き戻さない。
  3. token を unlink する。ファイルが無い（ENOENT）ときは削除済みとして先へ進む。それ以外の失敗は 503。
  4. `agy models` を 1 回実行する。`not_connected` なら snapshot と error を消し（sample は残す）、手動更新の
     60 秒の下限を戻して 204。connected のままなら状態を残して 409 `logout_incomplete`。それ以外なら状態を残して
     503 `logout_failed`。もう一度実行すると、ENOENT から同じ確認に進む。
- 応答の上限は、進行中の取得（最大 30 秒）と確認（15 秒）を足した 45 秒。
- Claude のログアウトは変えない。Claude でも logout 後に資格情報が戻る事象が出たら、別途同じ待ち方を検討する。

## 採用しない案

- 対話の `/logout` を案内するだけにする: print mode では拒否され、利用者が端末で別操作をしない限りカードが残る。
- token を読んで内部 API を叩く: 資格情報をこのアプリのコードが扱うことになり、規約上の扱いが不明なまま
  リスクだけが増える。
- sampler に乗せる: 画面を見ていない間も、機械的な起動が続く。
- epoch の bucket を捨てる: 未使用の 5 時間窓まで消える。epoch が「枠なし」を意味すると分かったら見直す。
- `3p-*`（Claude / GPT）のグループも出す: quota の無い窓が並び、Gemini の枠と取り違える。
- 進行中の取得を待たずに削除する: `agy` が終了時に token を書き戻すと、ログアウトしたのにカードが戻る。

## 非ゴール

- Gemini アプリ（gemini.google.com）の日次上限、Gemini CLI の枠、AI credits（`/credits`）
- Antigravity 経由の Claude / GPT の枠（`3p-*`）
- 5 時間窓の開始予約
- 複数 Google アカウント、共有
- 稼働状況ページへのリンク

## 影響

- 画面を見ていない間は更新されない。sample は画面を開いた時刻にだけ増え、推移に欠けが出る。
- 出力は公開契約ではない（changelog は構造化 payload に触れているが、公式ドキュメントに schema は無い）。形が
  変わったら `schema` エラーになる。pin した版の fixture で固定し、版を上げるときは差分を見る。
- 規約の解釈は変わり得る。公式 CLI を未改変で使い、自分のアカウントだけを対象にする前提が崩れる変更（共有、
  複数アカウント、バイナリの改変、トークンの直接利用）は、この決定を見直してから行う。
- image は CLI のぶん大きくなる（tar.gz で約 99 MiB、展開後 約 281 MB）。
- OS の keyring を使うホスト（`bun run dev`）では、`HOME` の分離と token の削除だけではログアウトにならない可能性が
  ある。その場合は 409 `logout_incomplete` になり、カードは残る。
- 取得が 15 秒を超える環境では `upstream` になる。延ばすなら、ログアウトの応答の上限も合わせて直す。
