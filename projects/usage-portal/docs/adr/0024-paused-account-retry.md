# ADR 0024: 契約エラーのアカウントは自動更新を止め、明示的な再取得で再開する

- Status: accepted
- Date: 2026-11-18
- 関連: [ADR 0007](0007-opencode-multiple-accounts.md) の複数アカウント、[ADR 0019](0019-opencode-subscription-errors.md) の契約エラー、[ADR 0023](0023-provider-fetch-intervals.md) の取得間隔

## 背景

OpenCode Go は契約が無いアカウントで `subscription_required` を返す。これは待っても直らず、契約するまで
何度取得しても同じ失敗になる。取得間隔を provider ごとに設定できるようにしたため、この状態のアカウントも
他のアカウントと同じ間隔で上流を叩き続けていた。

再契約は画面の外で行われ、その反映後に利用枠を取り直す入口が「接続確認」しかなかった。接続確認は probe の
モデルと思考レベルを設定したアカウントにしか出ないため、未設定のアカウントは再契約しても自動更新の間隔まで
待つしかなかった。

## 決定

- 最後の取得エラーが `subscription_required` の source は「停止中」とみなし、通常の取得間隔では起こさない。
- 停止中の source は、失敗時刻から 6 時間後に 1 回だけ自動で再確認する。契約の反映を取りこぼさないための保険で、
  6 時間より短い間隔で叩き続けない。再確認が契約エラー以外で失敗したら、停止を引きずらず通常の間隔へ戻す。
- 停止中でも、明示的な再取得は予定を無視して走らせる。入口は 2 つ。取得に失敗したら `{ ok: false }` を返し、
  画面は成功として扱わない。
  - `POST /api/opencode/accounts/:id/refresh`。カードの `⋮` の「利用枠を取得し直す」から呼ぶ。probe の設定に依存しない。
  - 接続確認（`POST /api/opencode/accounts/:id/check`）。送信が上流に届いたら、そのアカウントの利用枠も取り直す。
- 再取得に成功したら error が消え、次の取得から通常の間隔へ戻る（停止中に成功した場合は、成功時刻から通常の間隔）。
- 取得間隔の変更（`reschedule`）やアカウント変更後の再取得は、停止中の source を前倒ししない。停止を解くのは
  上の 2 つの明示操作と、6 時間後の再確認、成功だけにする。
- 停止の判定は、保存済みの error（`provider_error`）だけで決める。別のフラグを保存しない。成功で error が消えれば
  自動的に再開する。
- 画面は状態ラベル（契約エラー）と、`⋮` の「利用枠を取得し直す」で再開できることを文言で示す。バーは
  `state` が `ok` のときだけなので、停止中は出ない。

採用しない案:

- 停止中の source を永久にスキップする: 上流の一時的な誤判定で二度と戻らない。6 時間の再確認を残す。
- 停止中も通常の間隔で叩く: 契約が無いあいだ同じ失敗を繰り返すだけで、上流への要求を無駄に増やす。
- 停止フラグを別テーブルに保存する: error とフラグの 2 つが食い違う状態を作らない。成功時の error 削除に任せる。
- 復活を接続確認だけにする: probe の設定が無いアカウントは再開できない。利用枠だけの再取得を別に用意する。
- 停止中もバーを出す: 進まないバーが「動いている」と誤読させる。

## 理由

`subscription_required` は時間で直らない唯一の分類で、止める対象として明確に区別できる。再開は人間の操作
（契約）が起点なので、画面から明示的に試せる入口を用意し、自動は保険として 6 時間に 1 回だけにする。
これで、契約の無いアカウントが他の取得間隔を圧迫しない。

## 影響

- `src/server/db.ts` に `loadProviderErrors` を追加し、`src/server.ts` の `fetchers()` が `pausedUntil` を組み立てる。
- `src/server/sampler.ts` は `UsageFetcher.pausedUntil` を見て予定を決め、`subscription_required` の失敗で
  次回を 6 時間後にし、`refreshSource(sourceId)` を公開する。
- `src/server/opencode/api.ts` に `refresh(id)`、`src/server/app.ts` に `POST /api/opencode/accounts/:id/refresh` を追加する。
- `src/server/probe/service.ts` は接続確認が上流に届いたら `kickOpenCode(accountId)` を呼ぶ。
- `src/client/components/OpenCodeAccountCard.tsx` に「利用枠を取得し直す」を追加する。
- 停止中は sample が増えないため、再開後の推移には穴が空く。
