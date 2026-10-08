# investigate（調査を子エージェントへ委譲する）

親の会話の context を使わずに調査（横断 grep、多数ファイルの読み込み、git 履歴の追跡）を行うための BFF ローカルツール。定義は `server/src/investigate-tool.ts`、子の実行は `server/src/investigate-runner.ts`、子セッションの生成条件は `server/src/agent.ts` の子モード（`CreateSessionInput.mode: "investigation"`）、実体の注入は `server/src/sessions.ts` の `investigateHost()`。既定値・上限・列挙はコードが正（`INVESTIGATE_*` の定数と各定義）。

compaction（[compaction.md](compaction.md)）は会話全体を要約に置き換えるため調査以外の文脈も一緒に失う。`investigate` は調査を別のセッションへ出し、親には報告だけを返して同じ問題を避ける。役割・モデルの差し替えはエージェント定義（[api-catalog.md](api-catalog.md)）が担うが、context を分ける手段はこのツールだけ。

## 目的と非ゴール

- 親が調べる内容を投げ、子が読み取り専用で調べ、親は結論・根拠・参照ファイルパスの要約だけを受け取る
- 実装作業の委譲、複数エージェントのオーケストレーション、子の永続化 / resume、ネスト表示は対象外
- 子のモデル選択とエージェント定義 / ファイルスキルの継承も対象外（子は固定の調査用プロンプトで走る）

## ツール契約（`investigate`）

- 引数は `prompt`（文字列 1 本）だけ。子は親の会話を見ないため、自己完結した依頼を書かせる
- `exposure: "model-only"`（codemode のスクリプトからは呼ばせない）。`constrainedSampling` は付けない（引数が文字列 1 本で strict な構造化出力を要求しない）
- ツール名を `task` にしないのは、実装も頼めるという誤解をモデルへ与えないため
- 有効化は常時で、`PI_AGENT_TOOLS` の allowlist には依存させない（`ask_user` と同じ）。実体（host）未注入のときだけ落とす
- 報告は**子の最後の assistant メッセージ本文**。子のプロンプトで「結論 → 根拠 → 参照ファイル」の順を指示し、実際に読んだファイルのパスを必ず含めさせる
- `content`（モデルが読む本文）は `INVESTIGATE_REPORT_MAX` で切り詰める。**切り詰めの前に全文を mask する**のは、切り詰めた後では境界に掛かった秘密値が末尾を欠いた断片になり、後段の maskSafe（完全一致と先頭部分一致）でも検出できないため
- 結果の内訳は `details` に載せる（終了理由・usage など。形はコードが正）。`details` が provider へ渡る前提は置かない（provider 変換は `content` だけを読む）
- 打ち切り・失敗は **throw せず `isError: true` + `content`（理由 + 部分報告）** で返す。throw すると SDK の `createErrorToolResult` が `details` を空にするため（[ask-user.md](ask-user.md) と同じ理由）。子セッション作成の失敗（モデルが許可リストから外れている場合など）も同じ形に変換する
- 空の `prompt` だけは throw する（残すデータが無く、モデルにやり直させる）
- 定義は `wrapToolDefinitionWithSecretMasker` で包み、ローカル定義の execute 由来の文字列を layer 2 でマスクする（[secrets.md](secrets.md#レイヤー)）

## 子の制約

`createSession()` の子モード（`mode: "investigation"`）が次を一括して切り替える。ツール単位のノブは増やさない。

- 子のツールは読み取り専用の集合と `configuredTools()`（`PI_AGENT_TOOLS`）の積。`bash` を外している運用では子にも入らない
- BFF ローカルツールの常時有効群を足さない。子はユーザーへ質問できず、再帰できず、resume もできない（対象の一覧はコードが正）
- 子用の append system prompt（`investigationSystemPrompt()`）に切り替え、読み取り専用の調査に要る案内だけを残す（親向けの作業案内は子に渡さない）
- ファイルスキル / カタログスキルの発見を行わず、`skillsOverride` も渡さない（サンドボックス往復を減らし、子の system prompt に使えないスキルの索引を混ぜない）
- cwd は親と同じ、モデルは親セッションの現在のモデル、`ownerSessionId` は親。合成した調査用 AgentDef（固定の system prompt、スキルなし）を渡す
- retry / compaction の設定は `SettingsManager.inMemory` 経由で既存のセッションと揃う

**子は `bash` を持つため、プロンプトで読み取り専用を指示しても書き込みは技術的に禁止できない**（親と同じ信頼境界）。`write` / `edit` を渡さないのは事故率を下げるためであって保証ではない。

## 打ち切り

- タイムアウトは `INVESTIGATE_TIMEOUT_MS`。`createInvestigateToolDefinitions({ timeoutMs })` の getter が `execute()` のたびに解決する。設定 UI / env は持たない
- `AbortSignal.any([親 run の signal, タイムアウト])` を子 runner へ渡し、タイマーは execute の間だけ保持する（`AbortSignal.timeout` の保持を残さない）
- 親の stop（`POST /stop`）とタイムアウトのどちらでも、そこまでの部分報告を `isError` で返す。両者は理由で区別し、`content` の先頭に付ける
- 子自身の失敗（SDK が `prompt()` を resolve しても最後の assistant の `stopReason` が `error` になる provider の失敗や retry 枯渇、`prompt()` の reject）も `isError` にする。`prompt()` の解決だけでは子の成功を判定できない
- `stop` / `deleteSession` / `close` はいずれも `session.abort()` を通り、ツールの signal が発火するので、子専用の掃除フックは持たない（[ask-user.md](ask-user.md) と同じ扱い）

## 並列と待ち行列

- 同時に走らせる子の数は会話ごとに `INVESTIGATE_PARALLEL_MAX` まで。超過した呼び出しは待ち行列へ積み、空きが出たら開始する
- 待機中の呼び出しは親の stop で開始前に `isError` になり、子セッションも作らない
- 在庫（進行中の子と待ち行列）は runner モジュール内で会話 id ごとに持つ。`SessionRecord` には載せず、キュー / SSE / 購読 / sweep を持たない

## 進捗

- 子 runner は `onUpdate` に「現在の活動（直近のツール実行の要約）」と「生成中の本文末尾」を渡し、本文 delta は間引いて流す（量と間隔はコードが正。ツール境界では間引かない）
- 文字列は runner 側で `maskSafe` を通し、ツール定義側の `wrapToolDefinitionWithSecretMasker` でも重ねてマスクする
- SDK はこれを親ランの `tool_execution_update` として配る。親の画面は完了時の要約カードだけで、実行中の進捗を live に出す経路はまだ無い

## 記録に残らないこと

- 子セッションは `SessionManager.inMemory` で作り（`sessionId` も `entries` も渡さない）、親の `session.jsonl` には子の過程が残らない。親に残るのは、親が受け取った toolResult だけ
- 子は `SessionStore` の record にならず、SSE の購読もイベントログも持たない。サーバー再起動で親のランごと消え、子の結果も残らない（`ask_user` と同じ既知の制限）
- 子のツール呼び出しの履歴表示（ネスト表示）は無い

## mask 規則

- 子の報告は `content` としてインライン拡張（`createSecretRedactionExtension`）を通ってから LLM・履歴・`tool_execution_end` へ渡る。ツール自身も切り詰めの前に全文を mask する（[ツール契約](#ツール契約investigate)）
- `details` はこの拡張の対象外なので、載せる値に文字列を入れない。進捗は runner が `maskSafe` する

## 残るリスク

- 子が compaction した場合、初期の調査結果が報告から抜けうる（compaction 回数（`details`）が切り分けの手がかり）
- `INVESTIGATE_REPORT_MAX` の切り詰めで末尾が落ちる（結論先頭フォーマットで緩和。子がフォーマットを守るかは実測しないと不明）
- 報告はカードの表示上限（`SUMMARY_TEXT_MAX`）で切られ、全文を読む導線は無い
- 子セッション生成コストは子モードでスキル発見を省く分だけ下がるが、`resourceLoader.reload()` は残る
- 子の `bash` による書き込みは防げない（[子の制約](#子の制約)）

## 検証

契約は `pnpm check` の server テストが固定する（ツール契約・打ち切り・並列と待ち行列・子の過程が残らないこと）。
