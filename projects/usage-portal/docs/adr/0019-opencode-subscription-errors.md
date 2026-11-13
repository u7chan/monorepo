# ADR 0019: OpenCode Go の契約エラーをキー無効と分ける

- Status: accepted
- Date: 2026-11-13

## 背景

OpenCode Go の usage endpoint は、API キーが無効・未指定なら 401 `AuthError` を返す。一方、
サブスクリプションが無い（期限切れ・支払い停止）場合は 403 `EntitlementError`
（`OpenCode Go subscription required.`）を返す。

[0007](0007-opencode-multiple-accounts.md) は 401 / 403 をまとめて `invalid_key` としていた。このため
契約切れでも「API キーが受け付けられませんでした。画面から登録し直してください」と表示し、直らない操作へ
誘導していた。`stale` の共通文言「5 分後に自動で再試行します」も、待てば戻るように読めた。

`docs/design.md` は親 checkout の写しなので、この判断はここに記録する。

## 決定

- 401 は `config`（キー無効）のまま。403 は `subscription_required` として分ける。
- `/api/usage` の `error.code` に `subscription_required` を追加する。DB schema は変えない。
- 画面では `subscription_required` を「■ 契約エラー」とし、「更新停止」に含めない。
- 契約エラーの注記は「契約の反映後、自動で取得し直します。」に差し替える。5 分周期の取得は続ける。
- アカウント追加・編集でも 403 は `invalid_key` と混ぜず、契約状況の確認を促す。
- 上流の error body は引き続き読まない。分類は HTTP status だけで行う。
- [0007](0007-opencode-multiple-accounts.md) の「401 / 403 は `invalid_key`」はこの ADR が置き換える。

## 採用しない案

- 403 も `invalid_key` のまま: 契約切れでキーの再登録を促し、直らない操作へ誘導する。
- 403 の本文 `error.type` を見て分類: `fetchJson` はエラー応答の本文を読まない方針で、上流の本文を扱う理由がない。
  status で分けられる。
- 自動再試行を止める: 契約の反映後に自動で戻る経路を残したい。5 分周期はそのままにする。

## 理由

- status で区別できるため、本文やキーに触れずに原因を分けられる。
- 契約切れは待っても戻らない。キーの再登録ではなく契約状況の確認へ導く方が、次の操作が正しくなる。

## 影響

- 契約切れのアカウントは、次の取得（最大 5 分）から「契約エラー」になる。snapshot と履歴は変わらない。
- 403 が Cloudflare など別の理由で返る場合は契約エラーと表示する。現状の観測は 403 = `EntitlementError` のみ。
