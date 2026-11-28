# 利用枠の取得・保存と窓の扱い

- Status: accepted
- Date: 2026-11-23

## 背景

Codex・OpenCode Go・Claude・Gemini は、どれも利用枠を返すが形が違う。Codex は `rate_limit.primary_window` /
`secondary_window` に `used_percent` と `limit_window_seconds` を持ち、窓の意味は期間から決まる。
OpenCode Go は `usage.rolling` / `weekly` / `monthly` を固定で持ち、`resetsAt` は ISO 8601 で返る。
Claude と Gemini は公式 CLI の出力から読む。どれもこの用途向けの公開契約ではなく、窓が欠けることがある。

画面は「返ってきた窓だけ」を出し、取得できなかった provider は前回の値を残す。推移も出す。

## 決定

### 正規化と保存

- provider ごとに adapter を分け、上流の JSON を `unknown` として受け、手書きの type guard で必要な値だけ読む。
  正規化した `ProviderSnapshot`（plan / windows / notes / limitReached）だけを SQLite に保存する。
  上流の応答本文・例外文は DB・ログ・応答に残さない。
- Codex の窓は `limit_window_seconds` で種類を決める（6 時間以下は rolling、8 日以下は weekly、それ以上は monthly）。
  読めない値は rolling に寄せる。percent を読めた窓だけを `windows` に入れ、1 つも無ければ `schema` エラーにする。
- OpenCode Go の 3 窓は、API が返したものだけを出す。`status` が `ok` 以外なら上限到達と注記に反映する。
- Gemini は `/usage` の `gemini-*` の bucket だけを読み、`5h` を rolling、`weekly` を weekly に固定する。同じ window の
  bucket が複数あれば使用率の高い 1 本に畳み、`reset_time` が読めない・epoch でも窓は残して `resetsAt` を null にする
  （docs/adr/gemini-integration.md）。
- `usedPercent` は 0〜100 に clamp し、100 を超えたら「上限超過」を `notes` に出す。0% は欠損として落とさない。
- provider は並列に取得し、片方の失敗が他方を壊さない。失敗時は `provider_error` を upsert するだけで
  snapshot は保持する。成功時は snapshot の upsert、窓ごとの sample 追記、error の削除を 1 transaction で行う。
- sample は 30 日保持し、起動時と 24 時間ごとに削除する。

### 取得の予定

- 取得は source 単位の single-flight とし、起動時と 60 秒ごとの tick で「予定を過ぎた source」だけを取る。
  source ごとに `nextDueAt` を持ち、1 つの provider の遅い取得が別の provider の予定を遅らせない。
- 取得間隔は sampler に乗る provider（`codex` / `opencode-go`）ごとに設定する。Claude と Gemini は周期取得を
  持たないため対象外（固定の 15 分）。画面から選べる値は 5 / 10 / 30 / 60 / 120 分の 5 つに固定し、既定は 10 分。サーバーはホワイトリストで
  検証し、一覧に無い値は 400 で拒否する。保存先は SQLite（schema v2 の `fetch_interval`）。
- `POLL_INTERVAL_MS` は、画面から設定していない provider の既定値に降格する。優先順位は
  保存値 > env > 10 分。env の下限 1 分は運用者の明示指定として残す。
- 設定変更は次回予定だけを引き直し、その場では上流を叩かない（`reschedule`）。短くしたときは前倒しし、
  長くしたときは既に近い予定を遅らせない。
- `/api/usage` は source ごとに `fetchIntervalMs` と `nextFetchAt` を返す。`state` の停滞判定も
  provider ごとの値を使う。

### 状態と推移

- `state` は snapshot と error から決める。snapshot が無ければ `loading` / `error`、error があれば `stale`、
  取得からの経過が provider の閾値（既定は間隔の 2 倍、Claude と Gemini は 15 分）を超えても `stale`、それ以外は `ok`。
- 推移は窓ごとに返す。窓の期間ぶんの sample を `max(5 分, 履歴の範囲 / 48)` の bucket に間引き、各 bucket は
  平均ではなく最新の sample を代表点にする（リセットをまたぐ平均は実在しない値になるため）。表示は最大 48 点とし、
  2 点未満なら描かない。リセットは間引き前の sample で検出して別に返す。

### source id と履歴の引き継ぎ

- DB の `provider` 列には provider id ではなく **source id** を入れる。
  - Codex: 未接続時は `codex`、サインイン済みは `codex:<chatgpt account id>`
  - OpenCode Go: `opencode-go:<account uuid>`
  - Claude: `claude`
  - Gemini: `gemini`
- DB の関数は provider id ではなく source id（`string`）を受ける。snapshot JSON の中の
  `ProviderSnapshot.provider` は provider id のまま。この対応は `db.ts` のコメントに残す。
- Codex の accountId は `auth.json` から読み、DB の `provider` 列（履歴のキー）にだけ入れる。
  `/api/usage` の `id`・snapshot・ログには出さない。
- サインアウトは snapshot と error だけを消し、sample は残す。同じアカウントで戻ると推移が続く。
  OpenCode Go のアカウント削除は sample も消し、同じ uuid で作り直したときに履歴が混ざらないようにする。
- 起動時にサインイン済みなら、旧キー `codex` の snapshot と sample を現在のアカウントのキーへ移す。
  error は移さない。移し先に同じ行があれば移さない。
- 起動時に `provider = 'opencode-go'` の旧行と、アカウント一覧に無い `opencode-go:` 行を消す。
  失敗しても起動は止めない。

### 窓の入れ子と停止

- 窓は入れ子で、月次 ⊃ 週次 ⊃ ローリングの順に外側が内側を制限する。OpenCode Go のローリングは 5 時間
  （API は `limit_window_seconds` を返さないため、id から引く）。
- 外側の窓が 100% のとき、内側の窓は「使用不可」として扱い、リセット時刻を出さない。
  自分のリセットでは解除されないため、時刻を出すと嘘になる。複数の外側が尽きているときは最も外側を理由にする。
- 窓の内外はラベル（ローリング / 週次 / 月次）で決める。期間が分からないラベルは比較に参加させない。
- 100% に達した窓自身も「もう使えない」状態とし、80〜99% の「残りわずか」とは分ける。待てば戻る状態と、
  待っても戻らない状態を同じ表示にしない。
- 窓を足すときは `WINDOW_LABELS` のいずれかのラベルにする。未知のラベルは停止判定の対象外になる。
- `limitReached` は provider 全体の状態として扱い、停止判定には使わない。窓ごとの使用率で決める。

## 採用しない案

- 上流の生 JSON をそのまま保存する: 画面の都合で書き換えたときに再解釈が要り、email や account id まで残る。
- 欠損した窓を `—` や「利用不可」で埋める: 実データに無い窓を出すと、利用枠の有無を誤解する。
- percent を 0〜1 に正規化する: OpenCode Go の `0.5` は 0.5%（百分率）で、正規化すると 50% と誤表示する。
- 取得をメモリだけに持つ: コンテナ再起動で前回値と推移が消える。
- アカウント単位の取得間隔: 設定箇所が最大 10 個に増える割に、個人用途で調整したい理由が薄い。
- 秒・ミリ秒の自由入力: 上流のレート制限が非公開のまま、利用者が回数を決められてしまう。
- 1 分を選べるようにする: 利用枠の最小単位が 5 時間で、新しい情報がほとんど増えない。
- `settings.json` に取得間隔を保存する: sample と同じ DB に入れたほうが、バックアップとマイグレーションが 1 本になる。
- 内側の窓を非表示にする: 外側が戻った直後に何が残っているか読めなくなる。
- 内側の窓にリセット時刻を残す: 解除されると誤読する。
- 窓の並び順で外側を決める: 並びは provider の実装詳細で、根拠が provider ごとに違う。
- サインアウトで sample も消す: 同じアカウントで戻ったときに推移が失われ、30 日保持の意味が無くなる。

## 影響

- `bun:sqlite` の `user_version` で schema を管理する。現在は v4（v1 で snapshot / error / sample、
  v2 で `fetch_interval`、v3 で Claude の開始予約、v4 で Claude のリセット枠）。Gemini は既存のテーブルへ
  source id `gemini` で追記するだけで、schema は変えない。
- `src/server/sampler.ts` は `intervalFor(provider)` を受け取り、tick / nextFetchAt / reschedule / kick /
  exclusive を公開する。`kick` と `exclusive` は provider を指定できる。
- 5 分より長い間隔では推移の点が減り、リセット線を取りこぼしやすくなる。必要な場合は Codex を 60 分以下にする。
- source id を含む `provider` 列の変更は、既存のテーブル定義を変えずに済ませる。`/api/usage` の `id` は
  Codex が `codex` のまま。
