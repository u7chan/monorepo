# ADR 0023: 取得間隔は provider ごとに設定し、SQLite に保存する

- Status: accepted
- Date: 2026-11-18
- 関連: [ADR 0001](0001-state-fetching.md) の client 60 秒 / BFF ポーリング、[ADR 0004](0004-usage-sampling-and-storage.md) の取得と保存、[ADR 0022](0022-fetch-status-display.md) の表示

## 背景

BFF はすべての provider を同じ間隔（`POLL_INTERVAL_MS`、既定 5 分）で取得していた。Codex は 1 資格情報、
OpenCode Go は最大 10 アカウントを並列に取得するため、OpenCode Go だけ上流への要求が 10 倍になる。
利用枠の窓は最小でも 5 時間で、5 分ごとに取っても値はほとんど変わらない。provider ごとに間隔を変えられれば、
レート制限に近い側だけを遅くできる。

どちらの usage API も公開された契約ではなく、レート制限の値も公表されていない。画面から任意の秒数を
受け付けると、上流を叩く回数を利用者が決められる状態になる。

## 決定

- 取得間隔は provider（`codex` / `opencode-go`）ごとに設定する。アカウント単位にはしない。
  OpenCode Go の要求回数は「間隔 × 登録アカウント数」になることを設定画面に明記する。
- 画面から選べる値は 5 / 10 / 30 / 60 / 120 分の 5 つに固定する。1 分は出さない。既定は 10 分。
- サーバーは値をホワイトリストで検証し、一覧に無い値は 400 で拒否する。
- 保存先は SQLite（schema v2 の `fetch_interval`）。sample と同じ DB にまとめ、再起動をまたいで残す。
- `POLL_INTERVAL_MS` は、画面から設定していない provider の既定値に降格する。優先順位は
  保存値 > env > 10 分。env の下限 1 分はそのまま残す（運用者の明示指定だけを許す）。
- sampler は単一のタイマーではなく、起動時と 60 秒ごとの tick で「予定を過ぎた source」だけを取る。
  source ごとに `nextDueAt` を持ち、single-flight も source 単位にする。1 つの provider の遅い取得が
  別の provider の予定を遅らせない。
- `kick` と `exclusive` の再取得は provider を指定できるようにし、Codex のサインインや OpenCode Go の
  アカウント変更で、関係ない provider を叩かない。
- 設定変更は次回予定だけを引き直し、その場では上流を叩かない（`reschedule`）。短くしたときは前倒しし、
  長くしたときは既に近い予定を遅らせない。
- `/api/usage` は source ごとに `fetchIntervalMs` と `nextFetchAt`（sampler の予定）を返す。
  `state` の停滞判定（2 間隔）も provider ごとの値を使う。
- 画面の設定は `⋮` の「取得間隔」に置く。サーバー全体に効くことを文言で示す。

採用しない案:

- アカウント単位の設定: 設定箇所が最大 10 個に増える割に、個人用途で調整したい理由が薄い。
  データモデルは provider 単位なので、必要になったら scope を足して拡張できる。
- 分ではなく秒・ミリ秒で自由入力: 上流のレート制限が非公開のまま、利用者が回数を決められてしまう。
- 1 分を選べるようにする: 利用枠の最小単位が 5 時間で、新しい情報がほとんど増えない。要求回数だけが増える。
- `settings.json` に保存: sample と同じ DB に入れたほうが、バックアップとマイグレーションが 1 本になる。
- provider ごとに独立したタイマー: アカウントの増減でタイマーを作り直す必要があり、tick 1 本のほうが単純。

## 理由

レート制限に近いのはアカウント数だけ上流要求が増える OpenCode Go で、そこだけ遅くできることに意味がある。
一方で、画面から選べる値を固定しなければ、その自由度がそのまま BAN リスクになる。5 分未満を出さず、
既定を 10 分にすることで、登録済みの端末はこれまでより上流への要求が半分になる。

## 影響

- `src/server/db.ts` が schema v2 と `fetch_interval` の読み書きを持つ。
- `src/server/fetch-intervals.ts` が既定値へのフォールバックを含む store になる。
- `src/server/sampler.ts` は `intervalMs` ではなく `intervalFor(provider)` を受け取り、tick / nextFetchAt /
  reschedule を公開する。
- `src/shared/fetch-interval.ts` の一覧をサーバーと画面で共有する。
- `src/client/components/FetchIntervalForm.tsx` が設定モーダルになる。
- 5 分より長い間隔では推移の点が減り、リセット線を取りこぼしやすくなる（ADR 0015）。リセット線が
  必要な場合は Codex を 60 分以下にする。
