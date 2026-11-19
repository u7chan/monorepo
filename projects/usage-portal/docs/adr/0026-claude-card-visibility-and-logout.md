# ADR 0026: Claude のカードは認証済みのときだけ出し、非表示はログアウトにする

- Status: accepted
- Date: 2026-11-19
- 一部置き換え: [ADR 0022](0022-claude-usage-via-cli.md) の「取得の契機は 2 つだけ」と「未接続のカードに手順を出す」
- 関連: [ADR 0010](0010-menu-and-modal-layout.md) のインライン確認、[ADR 0012](0012-codex-signout-in-card-menu.md) のカードのメニュー、[ADR 0018](0018-codex-trend-across-signout.md) の sample の保持

## 背景

Claude の利用枠は公式 CLI の `/usage` から取る（ADR 0022）。サインインは Web UI で中継せず、端末で
`claude auth login` を実行する。GUI からサインインできない前提では、未認証・サブスク未契約のあいだも
Claude カードを常に出すと、操作できない案内が残り続けてノイズになる。

非表示を別のフラグ（DB や localStorage）で持つと、非表示中に再ログインをどう検知するかと、スマホと PC で
状態を揃える保存先が問題になる。Claude の非表示をログアウト（資格情報の破棄）に寄せれば、表示を
`claude auth status` の結果から導出でき、別のフラグを持たずに済む。

## 決定

- 可視性は `/api/usage` の `error` と `capturedAt` から導出する（`src/client/lib/claude.ts` の `showsClaudeCard`）。
  - `error.code === "not_connected"` は出さない。
  - `capturedAt === null` かつ `error === null`（loading・snapshot 無し）は出さない。
  - 取得済み、または `reauth_required` / `subscription_required` / `upstream` / `schema` / `config` の取得エラーは出す。
  - `/api/usage` の `loading` 契約と `placeholderSources` は変えない。loading は predicate で隠れる。
- 非表示はログアウトにする。カードの `⋮` の「ログアウトして非表示」（`danger: true`）から、カード内のインライン確認を
  経て `POST /api/claude/logout` を呼ぶ（ADR 0010 と同じく、確認のためにモーダルを重ねない）。
  サーバーは `claude auth logout` を公式 CLI で実行し、成功したら `deleteProviderState("claude")` で snapshot と error を
  消す。資格情報は CLI が破棄し、アプリは読まない。sample は残す（ADR 0018 と同じ理由で、再ログイン後の推移を引き継ぐ）。
- 取得の契機を 1 つ足す。カードが無いあいだは、ヘッダーの全体メニューに「Claude」を出し、モーダルに状態・TTY コマンド・
  「接続を確認」を置く。カードが出ている間は出さない（カードの `⋮` と役割が重複するため）。
  - ADR 0012 の「全体と接続ごとの操作を混ぜない」の例外。カードが存在しない状態なので、置き場は全体メニューしかない。
  - 出すのは `/api/usage` の応答後（`usage !== null`）かつカードが非表示のときだけ。初回ロード中は出さない。
  - 「接続を確認」は `refresh("manual")`。15 分の自動制限を受けず、前回の試行から 60 秒空ける。ログイン自体は中継しない。
  - 結果（refreshed / cooldown / logout / failed）はカードと同じ文言ヘルパーを使う。`showsClaudeCard` が true に
    なった時点でモーダルを閉じ、カードへ切り替える（refreshed / reauth / subscription / upstream / schema / config のどれでも）。
- ログアウトは取得を待たない。`ClaudeUsageService` に世代番号と `loggingOut` を持つ。
  - logout 開始時に世代番号を進め、同期的に `loggingOut` を立てる。
  - 進行中の attempt は開始時の世代番号を保持し、成功・失敗の保存直前に現在の世代と照合する。一致しなければ保存せず
    `{ state: "skipped", reason: "logout" }` を返す。logout の CLI が先に終わって `loggingOut` を下ろした後でも、
    古い attempt は snapshot / error を書き戻さない。
  - `loggingOut` 中の refresh は CLI を起動せず、すぐ `skipped: logout` を返す。`loggingOut` は成功・失敗のどちらでも下ろす。
  - logout の応答は、CLI の 15 秒の期限に収める。
- 成功時にメモリ上の手動 cooldown をリセットする。再ログイン後の「接続を確認」が 60 秒待ちにならないようにするため。
  auto は DB の snapshot / error が消えるので、次のページ表示で `auth status` が 1 回走る。
- ログアウトの結果は、カードが predicate で消えるためカード内に出せない。ヘッダー下のページレベルの `role="status"` 行に
  「Claude からログアウトしました。」を出し、次の Claude の操作または再読み込みまで残す。
  全体メニューの「ログアウト」（PIN セッション）とは文言を分ける。
- サブスクリプションの失効は判定しない（ADR 0022 のまま）。無効な資格情報は `loggedIn: false` /
  `loginExpiresAt` の期限切れ / `authMethod !== "claude.ai"` で扱い、利用者はカードの「ログアウトして非表示」で消す。
  Max が free に落ちて `/usage` の行が変わった場合は `schema` の取得エラーとして見える。
- `authMethod` が `api_key_helper` など設定ファイル由来の場合、`claude auth logout` では消えず、カードが戻り得る。
  `subscription_required` のカードと、カードが無いときの Claude のモーダルに、`CLAUDE_CONFIG_DIR` の設定から
  API キーの指定を外す条件つきの手順を出す。非表示フラグは追加しない。

## 採用しない案

- 非表示フラグを DB / localStorage に持つ: 再ログインを検知する契機が別に要り、端末ごとに状態がずれる。
- カードを消すだけでログアウトしない: 資格情報が残り、次の `auth status` が未接続を返せば結局カードが戻る。
  消す操作と資格情報の破棄を一致させる。
- Claude のログアウトを全体メニューの「ログアウト」（PIN セッション）に混ぜる: 対象が違う。
- 取得の完了を待ってからログアウトする: CLI が 2 回続き、応答が最大 30 秒になる。世代番号で書き戻しだけを止める。
- ログアウトの直後に自動で `auth status` を叩く: ログアウトした直後に 1 回だけ通信し、未接続を書き戻す。
  画面を開いたときの auto に任せる。

## 影響

- 未接続のあいだはカードが無い。サインインの手順と確認は全体メニューの「Claude」から開く。
- 再ログインは端末で `claude auth login` を実行し、全体メニューの「接続を確認」（またはページの再読み込み）でカードが戻る。
  サブスクリプションを再契約しただけでは戻らず、TTY での再ログインが要る。
- ログアウトで sample は残るため、再ログイン後の推移に以前の履歴が混ざる（ADR 0018 と同じ）。
- 実資格情報がある状態の `claude auth logout` の出力と、資格情報ファイルの削除・権限は実機で確認する。
- 進行中の取得とログアウトが同時に CLI を起動すると、ロックなどでログアウトが失敗し得る。503 の再試行で解消する前提にする。
- 既存の `/api/claude/refresh` の応答時間（auth + usage で最大 30 秒）と `Bun.serve` の `idleTimeout` の関係は未検証のまま。
