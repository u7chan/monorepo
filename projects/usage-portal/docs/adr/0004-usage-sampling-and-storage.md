# ADR 0004: 利用枠の取得・正規化と SQLite への保存

- Status: accepted
- Date: 2026-10-25
- 一部置き換え: [ADR 0008](0008-remaining-gauge-and-window-trend.md)（24 時間の推移）

## 背景

Codex と OpenCode Go は、どちらも利用枠を返すが形が違う。Codex は `rate_limit.primary_window` /
`secondary_window` に `used_percent` と `limit_window_seconds` を持ち、窓の意味は期間から決まる。
OpenCode Go は `usage.rolling` / `weekly` / `monthly` を固定で持ち、`resetsAt` は ISO 8601 で返る。
どちらもこの用途向けの公開契約ではなく、窓が欠けることがある（Codex は週次が返らないプランがある）。

画面は「返ってきた窓だけ」を出し、取得できなかった provider は前回の値を残す必要がある。24 時間の推移も出す。

## 決定

- provider ごとに adapter を分け、上流の JSON を `unknown` として受け、手書きの type guard で必要な値だけ読む。
  正規化した `ProviderSnapshot`（plan / windows / notes / limitReached）だけを SQLite に保存する。
- Codex の窓は `limit_window_seconds` で種類を決める（6 時間以下は rolling、8 日以下は weekly、それ以上は monthly）。
  読めない値は rolling に寄せる。percent を読めた窓だけを `windows` に入れ、1 つも無ければ `schema` エラーにする。
- OpenCode Go の 3 窓は、API が返したものだけを出す。`status` が `ok` 以外なら上限到達と注記に反映する。
- `usedPercent` は 0〜100 に clamp し、100 を超えたら「上限超過」を `notes` に出す。0% は欠損として落とさない。
- provider は並列に取得し、片方の失敗が他方を壊さない。失敗時は `provider_error` を upsert するだけで snapshot は保持する。
- 成功時は snapshot の upsert、窓ごとの sample 追記、error の削除を 1 transaction で行う。
- 取得は single-flight。起動直後と `POLL_INTERVAL_MS`（既定 5 分）ごとに走らせる。sample は 30 日保持し、起動時と 24 時間ごとに削除する。
- 24 時間の推移は、最新 snapshot で最も使用率が高い窓（同値なら期間が短い窓）の sample を 30 分 bucket の平均に丸め、
  最大 48 点にする。2 点未満なら描かない。
- `state` は snapshot と error から決める。snapshot が無ければ `loading` / `error`、error があれば `stale`、
  `now - capturedAt > 2 * POLL_INTERVAL_MS` でも `stale`、それ以外は `ok`。

採用しない案:

- 上流の生 JSON をそのまま保存する: 画面の都合で書き換えたときに再解釈が要り、上流の識別子（email / account id）まで残る。
- 欠損した窓を `—` や「利用不可」で埋める: 実データに無い窓を出すと、利用枠の有無を誤解する。
- percent を 0〜1 に正規化する: OpenCode Go の `0.5` は 0.5%（百分率）で、正規化すると 50% と誤表示する。
- 取得のたびに provider を取り直す（キャッシュをメモリだけにする）: コンテナ再起動で前回値と推移が消える。

## 理由

- 正規化を通すことで、client は provider 固有の JSON を知らずに 1 つの描画ロジックで済む。
- 失敗を provider 単位で閉じるため、OpenCode Go のキーが無くても Codex の数値は出る。
- 1 transaction にまとめると、snapshot と sample が食い違う中間状態を画面に出さずに済む。

## 影響

- `bun:sqlite` の `user_version` で schema を管理する。v1 で `provider_snapshot` / `provider_error` / `usage_sample` を作る。
- `data/usage.sqlite` が 30 日分の sample を持つ。不要なら削除してよい（履歴だけが消える）。
- 上流の応答本文・例外文は DB・ログ・応答に残さない。ログは provider 名と分類（と HTTP status を含む固定文言）だけにする。
