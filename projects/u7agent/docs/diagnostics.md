# セッション診断

不具合の切り分け用に、クライアントとサーバーの観測を 1 つの JSON へまとめて取り出す仕組み。対象は ask_user / 待機キュー / resync / 再接続 / 別タブが絡む「クライアントとサーバーのどちらがズレたのか」を決める場面で、**観測するだけで、どちらが正しいかは判定しない**。

- サーバー側: `GET /api/sessions/:id/diagnostics`（いつでも取れる）と `GET /api/sessions/:id/raw`（生ログ）。**どちらも未ロードの会話では SDK を復元しない**（復元が失敗する壊れた記録を取るための経路なので、観測が対象を変えない）
- クライアント側: このタブが受信した SSE の直近列と、chat reducer の状態（その瞬間しか取れない）
- 契約は [api-sessions.md](api-sessions.md#get-apisessionsiddiagnostics) と [api-sessions.md](api-sessions.md#get-apisessionsidraw)、実装は `server/src/diagnostics.ts` / `client/src/lib/diagnostics.ts`

## 入口

- 設定 → ランタイム の診断タブ（`/settings/runtime/diagnostics`）: 対象の会話を選んで同じ 2 つ。対象の選択と report は面（`client/src/components/runtime-settings/DiagnosticsTab.tsx`）が持ち、取り直しは面のツールバーに 1 つだけ置いて対象を選ぶまで無効にする（理由はカード内に 1 行で出す。カードは `client/src/components/SessionDiagnosticsCard.tsx`）。**チャットの描画が壊れていても取れる経路**で、設定ページを開いている間もチャットは mount されたまま（[ui-layout.md](ui-layout.md)）という既存の契約に乗る
- `window.u7agentDebug.snapshot()`: UI を増やさない入口。コピーと同じ文字列を返す（`Promise<string>`）
- **会話行の ⋯ には出さない。** 対象の選択・取れない理由・省略の報告まで含めて診断タブが上位集合で、開いていない会話の行からはクライアント状態の付かない劣化形しか取れなかったため（出さないことは `client/src/lib/sidebarRowMenu.ts` の項目一覧で固定する）

コピーは毎回、クライアント状態 + サーバーのダンプを 1 つの JSON にする。`kind` / `version` / `note` / `capturedAt` を先頭に置くのは、貼り付け先では画面の文脈が失われるため。相関キー（`sessionId` / `eventGeneration` / `lastSeq` / 採取時刻 / クライアントのビルド識別子）を必ず入れ、サーバーの `at` とクライアントの受信時刻は**両方**残す（片方だけでは遅延の向きが分からない）。

クライアント側の 3 つ（chat 状態 / 開いている会話 / SSE の記録）は要求の直前にまとめて控え、サーバーの応答を待つ間のイベントで 1 つの JSON に別の時点を混ぜない。対象の会話を開いていないときはクライアント分を付けず、トップレベルの相関キーは対象サーバーのダンプの値にする（開いている別の会話の観測値を持ち込まない）。クライアントの `lastSeq` / `eventGeneration` は、SSE が 1 件も届いていない間も payload（初期取得 / resync / 回復）で seed して埋める。世代が変わったとき（再起動 / sweep）は seq を新しい世代の値へ戻す。

## mask の範囲

- **診断 JSON に本文は入れない。** メッセージ・質問・回答の本文は載せず、件数と `skipped` の数、文字数に落とす。イベントの `data` は emit 時点で mask 済みの値を、種別ごとの要約（`server/src/diagnostics.ts` の `summarizeEventData`）で本文なしにしてから載せる（SSE の mask 規則は変えない。[secrets.md](secrets.md)）。会話タイトルも本文の先頭を含み得るため載せない（タイトルの由来と AI 要約の試行は `title` に載せ、状態・トリガー・モデル・Effort・usage・所要時間・失敗理由 / スキップ理由だけにして依頼本文と生成タイトルは含めない。`error` はマスクして 300 文字に切る）
- **生ログは mask 前。** `session.jsonl` をそのまま返すため、画面や履歴へ渡す前にマスクしている値も含まれる。毎回確認ダイアログを出し（既定の焦点はキャンセル、danger トーンにはしない）、注意書きを常設の折りたたみでも読めるようにする。`meta.json` / `sends.json` は同梱しない
- 内容の安全性は約束しない。共有する前に中身を確認する導線（注意書き）だけを出す

## 上限と省略

件数とバイトの上限を先に決め、超えたら古い方から落とし、**落とした件数と切り詰めた件数を画面と JSON の両方に出す**。無言の切り詰めは誤診の元になるため、`drops`（クライアント / サーバー / 切り詰め）を必ず残す。画面は結果行（設定 → ランタイム の診断タブのカード）が担う。数値そのものは `server/src/diagnostics.ts` / `client/src/lib/diagnostics.ts` の定数を正とする。

## 取れないもの

- クライアント状態は「そのタブのその瞬間」だけ。リロード後・タブを閉じた後は取れない（サーバーのダンプで補う）。別タブ / 別端末のクライアント状態も取れない
- 常時ディスクへ書く新しいログ、リモート送信 / テレメトリ、不具合の自動検知は持たない（`localStorage` / `sessionStorage` にも保存しない。v1 はメモリのみ）
- 突き合わせ表示は値を並べるだけで、不一致の強調やどちらが正しいかの判定はしない。サーバーが権威でもクライアントが 1 イベント遅れるのは正常で、強調は誤診を招くため
- ダンプを画面で読むビューは持たない（コピー / ファイル保存だけ）

## 運用

- 1 操作 1 ファイル。保存名は `u7agent-diagnostics-<id8>-<yyyymmdd-hhmm>.json` / `u7agent-raw-<id8>-<yyyymmdd-hhmm>.jsonl`（`client/src/lib/diagnostics.ts`）
- コピーに失敗した場合（非 secure context / 権限など）は内容を捨てず、同じ本文をファイルとして保存する逃げ道を出す（[file-preview.md](file-preview.md#コピー) の失敗表示と同じ作法）。コピーできる経路は `client/src/lib/copyToClipboard.ts` を正とする
- 圧縮は見た目の調整であり自動テストしない（[testing.md](testing.md)）。契約（本文を載せない / 上限を報告する / セッション切替でクライアント記録を捨てる）は `server/test/diagnostics.test.ts` / `client/test/diagnostics.test.ts` が固定する
