# ask_user（選択肢つきの質問カード）

モデルがユーザーへ確認したいことを、チャット本文の問いかけではなく構造化したカードで聞くための BFF ローカルツール。定義は `server/src/ask-user-tool.ts`、待機の所有は `SessionStore`（`server/src/sessions.ts` の `askQuestion` / `answerQuestion`）、イベント変換は `server/src/run-events.ts`、履歴の復元は `server/src/session-projection.ts`、カードは `client/src/components/chat/AskUserCard.tsx`。

`projects/simple-agent-poc` の `ask_user` と違い、**pause / resume の状態を持たない**。ツールの `execute()` が回答まで await するだけで、ランは `running` のまま HTTP リクエストから切り離されて続く（[architecture.md](architecture.md) の基本原則 1）。専用の再開 API も新しい SSE イベント種別も無い。

## ツール契約（`ask_user`）

- 1 回の呼び出しで 1〜4 問。各質問は `question`（500 文字）+ 任意の `header`（40）/ `type`（`choice` / `text`）/ `options`（最大 6、各 `label` 80・`description` 200）/ `multiSelect`（既定 false）/ `placeholder`
- `options` は入力補助で、自由記入は常に受け付ける。`options` が無ければ自由記入だけの質問になる
- 上限違反はツールエラーとして throw し、モデルにやり直させる（質問 / 回答を表示する data が残らないため）。引数の導出（`deriveAskUserQuestions()`）が形を判定できないときはカードを出さず、通常のツール履歴にエラーとして見せる
- `exposure: "model-only"`（codemode のスクリプトからは呼べない）。入れ子の配列 / オブジェクトを含むため provider の strict JSON schema は要求しない
- `execute()` は `AskUserHost.ask()` を await する。会話 id は定義の生成時に束縛し、モデルからは受け取らない
- 回答は `{ index, selected?, text?, skipped? }`。`index` は質問の添字で、質問文の文字列とは引かない（同じ質問文が 2 つあると壊れるため）。`skipped` は質問ごとの「回答しない」で、`selected` / `text` とは排他（同時指定は 400）。`selected` と `text` の同時指定は正しい形（選択肢を選んで補足を書ける）
- 全質問に 1 つずつ回答が要る。一部だけの回答は 400（UI も全質問が埋まるまで送信できない）
- 回答を `details` に載せ、モデルへは次の形の text を返す（`content` はツール結果として secret マスクを通る）

```text
ユーザーの回答:
1. <質問>
   - 選択: <label>, <label>
   - 自由記入: <text>
回答が得られました。同じ内容を質問し直さず、作業を続けてください。
```

- **abort / 取り消しでは throw せず `isError: true` を返す**: `details: { questions, answers: [] }` と「回答が得られないまま停止しました」。`AgentToolResult.isError` は「throw せず失敗を返し、`details` を UI に残す」契約で、throw すると SDK の `createErrorToolResult` が `details` を空にするため、停止後の再読込でカードを復元できなくなる
- 有効化は常時で、設定で切る導線は無い。`PI_AGENT_TOOLS` は `tools` の allowlist を作るため、**ask_user は環境変数では外せない**（`server/src/agent.ts`）。エージェント定義の `toolNames` では外せる（外すと新しい会話で公開されない。[api-catalog.md](api-catalog.md#ツール許可リスト)）

## 待機のライフサイクル

- 実体は `SessionRecord.questions`（`Map<toolCallId, PendingQuestion>`）。`record.tools` と同じ寿命で、次の `startRun` が初期化し、`stop` / `finish` / `deleteSession` / `close` が未 settle の分を取り消す
- 回答は 1 回だけ成立する。settle 済みの entry は tombstone として残し、同じ `toolCallId` への 2 回目は 409、未知の id は 404（2 タブで同時に答えても片方だけが成立する）。abort された待機は tombstone を残さず削除する
- 二重 settle を防ぐ（resolve / reject の後にもう片方を呼ばない）。abort は `AbortSignal` を正とし、`stop()` は signal が届かない実装のための保険としても取り消す
- **回答待ちの間は手動 compaction が 409、自動 compaction も走らない**（自動は「ツール完了後の次ターン前 / 新プロンプト前 / overflow 回復」でだけ発火し、待機中はその地点に来ない。[compaction.md](compaction.md)）
- タイムアウトは無い。放置するとランは `running` のまま残る（[運用影響](#運用影響と既知の制限)）

## 回答待ちと所要時間

- 回答待ちの間、実行中インジケータの経過時間は増えない。経過時間は `now - run.startedAt - ask_user の実行区間の和(now)` で、値が動かない間は演出の拍も進まない
- 区間は既存のツール計測（`ToolCall.startedAt` → `endedAt`、開いているものは評価時刻まで）だけを正とする。質問の登録 / settle には別の時刻を持たせない。和集合で数えるため、1 つの assistant メッセージで 2 枚の質問が並行に待っても二重に引かない。`startedAt` の無いカード（開始を観測しなかった / 旧サーバー）は区間を作らず、従来どおり待機を含めて数える
- BFF の確定値（`run_end.durationMs` / 履歴 item の `runDurationMs` と `turnEnd` / Discord 通知の所要時間）も同じ規則で、ランの作業時間になる。`finish()` は開いた区間を `endedAt` で閉じ、`tool_execution_end` が終端より後に届いても控えた値を書き換えない
- 演出と色の判定も、控除後の経過時間をそのまま使う（拍の間隔と色の閾値の正は `client/src/lib/elapsed.ts`）。圧縮時間と自動再試行の待機は BFF が動いている時間なので、従来どおり含める（対象は `ask_user` だけ。同じバッチで並行した他ツールの時間も、区間の和を引く結果として除かれる）

## UI

- カードは assistant バブルの本文の後に出し、汎用のツール履歴からは外す（スキル読み込みをバッジへ出しているのと同じ扱い。`client/src/lib/skillLoad.ts` の `nonSkillToolCards()` を表示とコピーで共有し、`#N` の行番号とコピー本文を一致させ続ける）
- 状態は「回答待ち / 送信中 / 回答済み / 回答なしで終了」。回答後は Q&A の記録として残し、質問（淡）と回答（濃）の組を並べる。記録の note「回答なしで終了」は回答の中身が 1 つも無いときに出し、**全問「回答しない」で settle した場合も出す**
- **質問は 1 問ずつ出す**。ヘッダーの `1 / N` と前後の chevron で切り替え、回答の有無では止めない（未回答のまま見比べられる）。`→` は回答（選択・自由記入・`回答しない`）が入るまで押せず、最後の質問では全問が埋まっていれば送信、未回答が残っていればその質問へ戻して「未回答の質問が N 件あります」を出す（`aria-label` もこの動きに合わせて「次の質問へ / 未回答の質問へ戻る / 回答を送る」と切り替える）。`✕` は閉じる操作で、回答済みはそのまま・未回答は「回答しない」にして送る（回答済みを捨てずに待機を終わらせる）。未回答が残っている間は、閉じたときに残りが「回答なし」になることをカード内の補足で示し、押すと確認を挟む。確認を開いている間にカードが失効した（会話の切替・削除・settle）ときは、確定しても送らない（確定時の会話へ古い回答を送らない）。未回答が無いときは送る内容が回答済みだけなので、補足も確認も出さない
- 選択肢は行そのものが選択の印になる。単一選択は番号や枠を出さず、選ぶと面と文字色で示す。`multiSelect` のときだけチェックを出す。自由記入も同じ並びの 1 行で、行のまま入力でき、入力があれば選択肢と同じ 1 件として数える
- フッターは `N 件選択` / `回答しない` / `→`。`回答しない` はその質問を「回答しない」にして次の質問へ進み、押した質問ではボタンを選択中の見た目にしてフッターにも「回答しない」と出す（戻ってきたときに未回答と区別でき、押し間違いに気づける。選択や入力で解除される）。送信中は「送信中…」に変わる。
- Enter は `→` と同じ（自由記入の本文に改行は入れない）。ただし **IME の変換確定 Enter では進めない**（`client/src/lib/composerKeys.ts` の `isImeComposingEnter()` を Composer と共有し、`isComposing` と `keyCode === 229` の両方を見る。片方だけ直すと日本語入力の確定で質問が変わる。[ui-layout.md](ui-layout.md) の入力欄の契約）。singleColumn は Enter を使わず `→` に任せる
- 回答待ちの間は入力欄の送信を無効化し、理由（`上の質問に回答してください（N件）`）を入力欄下の footnote に出し、停止は入力欄の行の控えの ■ として押せるままにする（回答を本文へ打って待機キューに積まれる事故を防ぐ。主スロットへ昇格させない理由は [ui-layout.md](ui-layout.md#入力欄の主ボタン送信と停止)）
- 回答待ちかどうかは `chat.runTools`（payload の `run.toolCalls`）から導出し、SSE の `status { state: "question" }` には依存しない。`resync` は activity を固定文言へ上書きし、`status` はリプレイされないため。`status` はライブの活動表示にだけ使う。**回答が settle した後は、回答待ちが無くなった時点で状態行の「回答を待っています…」を出さない**
- 左バーのセッション行は一覧 API の `awaitingAnswer` を見て「回答待ち」を出す（実行中とは別のラベルで、件数と理由は行に出さない。行の規則は [ui-layout.md](ui-layout.md#nav-モード)）。自分が開いていない会話の待機も、一覧のポーリングで届く
- 回答を送っても `tool_end` が届くまでは手元の入力を記録として見せる。同じ assistant バッチでも `tool_execution_end` は各ツールの実行が終わった時点で届くため、並行した `ask_user` でも回答した側から順に閉じる（バッチの `Promise.all` はツール結果メッセージの並びを揃えるだけ）
- a11y: 質問のまとまりは `role="group"` + `aria-label`（質問文）、選択肢の行は `aria-pressed`、ページャと `✕` は `aria-label`、自由記入は質問文つきの `aria-label`。フッターの状態（`N 件選択` / 「回答しない」/「未回答の質問が N 件あります」/「送信中…」）と `1 / N` は `aria-live="polite"` で読み上げる。閉じる操作の補足は `aria-live` を持たせない（フッターの状態と二重に読み上げない）。singleColumn でも同じ操作で、幅が狭いときは罫線の並びを保ったまま行が縦に伸びる

## 回答待ちカードの復帰

本文を持たない assistant メッセージ（tool call だけ）は表示対象にならず（`isDisplayableMessage()`）、`resync` は未確定の空 assistant バブルを落とす。ask_user は「run が止まって次のイベントが来ない」ため、他ツールと違って自己回復しない。

- `attachRunToolCards()` は補完先が無く、`runTools` に未回答の ask_user（`questions` があり `answers` が無く `phase === "running"`）があるときだけ、`ensureAssistant()` と同じ規則で assistant バブルを合成してからカードを補完する。他のツールは復元しない（表示バブル数 / `messageCount` を維持する既存契約を変えない）
- 合成したバブルは `entryId` を持たないライブバブルと同じ扱いで、回答の本文や履歴ページの適用で既存の突き合わせに乗る
- 履歴ページのマージ（`splitLive()`）は、回答待ちのカードを持つバブルを**末尾へ固定**する。待機中は次のイベントが来ず、先頭へ繰り上げると長い会話でカードが画面外に消える（本文を持たない assistant は履歴 item に現れず、突き合わせもされない）。判定は表示側と同じ `isPendingAskUserCard()` を使う
- 回答済み / 停止済みのカードは合成しない。本文を持たない assistant のカードは読み込み直後に出ない（`messages[].tools` の既知の制限と同じ。[api-sessions.md](api-sessions.md#get-apisessionsid)）
- 合成したバブルは `resync` のたびに作り直され、id も変わる。カードのローカル状態（入力中の `drafts` / 開いている `page` / 送信直後の `sent`）はこの描画に載っているため、**待機中や送信直後に `resync`（SSE 再接続）が入ると入力中の内容と「反映を待っています…」の表示は消える**。回答は POST の時点で確定しているので、`answers` が届けば記録に戻り、送信済みなら 409 を理由に出して権威ある状態を取り直す（[sessionActions.ts](../client/src/hooks/sessionActions.ts)）。バブルを run 内で安定させるのが本筋（未対応。v1 から同じ）

## mask 規則

- 回答はツール結果として渡るため、インライン拡張（`server/src/secret-guard.ts` の `createSecretRedactionExtension`）が **LLM・履歴・`tool_execution_end` の前に content を mask する**。質問 / 回答の本文に登録済みの秘密値があると、モデルにも `[REDACTED]` が届き、その回答では作業を続けられない（既知の制限）
- `details` はこの拡張の対象外なので、**`run-events` と `session-projection` が DTO に載せる前に** `questions` / `answers` を mask する（`askUserQuestionsOf()` / `askUserAnswersOf()`）。`details` の生値は `session.jsonl` に残る（[persistence.md](persistence.md)）

## 運用影響と既知の制限

- 未回答のまま放置するとランは `running` のままで、左バーの行も「回答待ち」になる（[UI](#ui)）。他クライアントの送信はキューに溜まり（最大 10 件で 429）、Discord の完了通知は回答するまで来ない。**設定 → 通知の「質問の通知」を On にしていれば、待機が始まった時点で 1 通届く**（全体通知が On のときだけ。会話の通知を On にした会話ではタイトルと第 1 問、Off の会話では本文なしで、件数は通知の引き金になった呼び出しのもので、並行する後続の呼び出しは載らない。[notifications.md](notifications.md#質問通知)）。回答待ちの間にキューへ入った送信は、回答してもすぐには始まらず、回答後にそのランが終わってから順に実行される（この理由は状態行の下の 1 行に出す）。`sweep` は busy を対象外にするためメモリにも残る。逃げ道は既存の停止ボタンだけで、停止はキューを破棄する（待機中の分はコンポーザー直上のブロックの `取り消し` から 1 件ずつ外せる。ランは止まらない）。[run-lifecycle.md](run-lifecycle.md#ライフサイクル--制限)
- **graceful な再デプロイ**（SIGTERM）では、`close()` が `abort()` を idle まで待ち、ツールが `isError: true` + `details` を返した結果が JSONL に残る。本文のある assistant なら「回答なしで終了」のカードが復元される。**強制終了（SIGKILL / OOM）や abort が Docker の stop grace に間に合わなかった場合**は toolResult が残らずカードも出ない。いずれの経路でも回答は失われ、ユーザーが新しいメッセージで再開する
- 再質問は「もう一度質問して」と送ればよい。モデルは前回の質問を文脈に持つため `ask_user` を出し直せる（`promptGuidelines` にもその場合だけは出し直すと書いてある）。カードは残った状態では無いことがあるため、専用の再質問ボタンは持たない
- 1 つの assistant メッセージで `ask_user` を並行に 2 回呼ぶと、カードが 2 枚同時に待機する。両方に回答するまでモデルは再開しない（SDK がバッチ全体の settle を待つ）。UI は複数待機でも壊れず、全カードが埋まるまで送信できない
- 回答待ちの間にサーバーが再起動するとランごと消える。会話には assistant の問いかけ（本文があれば）だけが残る

## 検証

- `server/test/ask-user.test.ts` — パラメータ検証、質問 / 回答の導出、モデル向け text、`execute` の details と abort、回答が 1 回だけ / 2 回目 409 / 未知 404、stop・delete での取り消し、`tool_start` / `tool_end` と payload・履歴の一致、mask、回答待ち中の compaction 409、HTTP エンドポイントの 200 / 400 / 404 / 409
- `client/test/askUser.test.ts` — 入力の純関数（質問ごとの回答済み判定・選択数・未回答の探索・閉じたときの回答・閉じるときの未回答数と確認・確認中のカードの失効・全質問が埋まるまで送信不可）、回答待ちの数え方と送信ブロックの文言（質問待ち + キュー送信の組み合わせを含む）、全問「回答しない」の note、閉じる操作の補足の描画、settle 後の状態行、reducer の状態遷移、本文を持たない ask_user の resync 復帰
- GUI 受入は [testing.md](testing.md#gui-の最小受入)
