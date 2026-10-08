# investigate（調査を子エージェントへ委譲する）

親の会話の context を使わずに調査（横断 grep、多数ファイルの読み込み、git 履歴の追跡）を行うための BFF ローカルツール。定義は `server/src/investigate-tool.ts`、子の実行は `server/src/investigate-runner.ts`、子セッションの生成条件は `server/src/agent.ts` の子モード（`CreateSessionInput.mode: "investigation"`）、実体の注入は `server/src/sessions.ts` の `investigateHost()`。

compaction（[compaction.md](compaction.md)）は会話全体を要約に置き換えるため調査以外の文脈も一緒に失う。`investigate` は調査を別のセッションへ出し、親には報告だけを返して同じ問題を避ける。役割・モデルの差し替えはエージェント定義（[api-catalog.md](api-catalog.md)）が担うが、context を分ける手段はこのツールだけ。

## 目的とスコープ

- 親が「調べて」と投げ、子が読み取り専用で調べ、親は結論・根拠・参照ファイルパスの要約だけを受け取る
- 実装作業の委譲、複数エージェントのオーケストレーション、子の永続化 / resume、ネスト表示は対象外
- 子のモデル選択とエージェント定義 / ファイルスキルの継承も対象外（子は固定の調査用プロンプトで走る）

## ツール契約（`investigate`）

- 引数は `prompt`（文字列 1 本）だけ。子は親の会話を見ないため、自己完結した依頼を書かせる
- `exposure: "model-only"`（codemode のスクリプトからは呼ばせない）。`constrainedSampling` は付けない（引数が文字列 1 本で strict な構造化出力を要求しない）
- ツール名を `task` にしないのは、実装も頼めるという誤解をモデルへ与えないため
- 有効化は常時で、`PI_AGENT_TOOLS` の allowlist には依存させない（`ask_user` と同じ）。実体（host）未注入のときだけ落とす
- 報告は**子の最後の assistant メッセージ本文**。子のプロンプトで「結論 → 根拠 → 参照ファイル」の順を指示し、実際に読んだファイルのパスを必ず含めさせる
- `content`（モデルが読む本文）は 4,000 文字で切り詰め、末尾に `…` を付ける（最大 4,001 文字）。会話履歴のカードに出るのは `session-projection.ts` の `SUMMARY_TEXT_MAX`（900 文字）までで、全文を読む導線は無い
- `details` に子のツール実行回数・usage・終了理由（`completed` / `timeout` / `aborted` / `error`）・compaction 回数を載せる。`details` が provider へ渡る前提は置かない（provider 変換は `content` だけを読む）
- 打ち切り・失敗は **throw せず `isError: true` + `content`（理由 + 部分報告）** で返す。throw すると SDK の `createErrorToolResult` が `details` を空にするため（[ask-user.md](ask-user.md) と同じ理由）。子セッション作成の失敗（モデルが許可リストから外れていた場合の 400 など）も同じ形に変換する
- 空の `prompt` だけは throw する（残すデータが無く、モデルにやり直させる）
- 定義は `wrapToolDefinitionWithSecretMasker` で包み、ローカル定義の execute 由来の文字列を layer 2 でマスクする（[secrets.md](secrets.md#レイヤー)）

## 子の制約

`createSession()` の子モード（`mode: "investigation"`）が次を一括して切り替える。ツール単位のノブは増やさない。

- 子のツールは `read` / `grep` / `find` / `ls` / `bash` と `configuredTools()`（`PI_AGENT_TOOLS`）の積。`bash` を外している運用では子にも入らない
- 常時有効群（`ask_user` / `serve` / `web_search` / 画像生成 / `investigate`）を足さない。子は質問できず、再帰もできず、resume もできない
- 子用の append system prompt（`investigationSystemPrompt()`）を使い、cwd と `@<path>` 参照、ネットワーク（curl）の案内、読み取り専用の指示だけを残す。ファイル書き込み・`serve`・スキル作成・画像生成・Python の環境構築の案内は落とす
- ファイルスキル / カタログスキルの発見を行わず、`skillsOverride` も渡さない（サンドボックス往復を 1 つ減らし、子の system prompt に使えないスキルの索引を混ぜない）
- cwd は親と同じ、モデルは親セッションの現在のモデル、`ownerSessionId` は親。合成した調査用 AgentDef（固定の system prompt、`skillIds: []`）を渡す
- retry / compaction の設定は `SettingsManager.inMemory` 経由で既存のセッションと揃う

**子は `bash` を持つため、プロンプトで読み取り専用を指示しても書き込みは技術的に禁止できない**（親と同じ信頼境界）。`write` / `edit` を渡さないのは事故率を下げるためであって保証ではない。

## 打ち切り

- タイムアウトの既定値は 10 分（`INVESTIGATE_TIMEOUT_MS`）。`createInvestigateToolDefinitions({ timeoutMs })` の getter で `execute()` のたびに解決する。設定 UI / env は持たない
- `AbortSignal.any([親 run の signal, タイムアウト])` を子 runner へ渡し、`AbortController` + `clearTimeout` でタイマーを execute の間だけ保持する（`AbortSignal.timeout` の 10 分保持を残さない）
- 親の stop（`POST /stop`）とタイムアウトのどちらでも、そこまでの部分報告を `isError` で返す。理由は「停止しました」/「時間切れで打ち切りました」で、`details.outcome` は `aborted` / `timeout` になる
- `stop` / `deleteSession` / `close` はいずれも `session.abort()` を通り、ツールの signal が発火するので、子専用の掃除フックは持たない（[ask-user.md](ask-user.md) と同じ扱い）

## 並列と待ち行列

- 同時に走らせる子は**会話ごとに 3 件**まで（`INVESTIGATE_PARALLEL_MAX`）。超過した呼び出しは待ち行列へ積み、空きが出たら開始する
- 待機中の呼び出しは親の stop で開始前に `isError`（`details.outcome: "aborted"`）になり、子セッションも作らない
- 在庫（進行中の子と待ち行列）は runner モジュール内で会話 id ごとに持つ。`SessionRecord` には載せず、キュー / SSE / 購読 / sweep を持たない

## 進捗

- 子 runner は `onUpdate` に「現在の活動（直近の `tool_execution_start` の `name` + args 要約）」と「生成中の本文末尾（末尾 3 行 / 200 文字まで）」を渡す。本文 delta は 400 ms で間引き、ツール境界では間引かずに流す
- 文字列は runner 側で `maskSafe` を通し、ツール定義側の `wrapToolDefinitionWithSecretMasker` でも重ねてマスクする
- SDK はこれを親ランの `tool_execution_update` として配る。親の画面は完了時の要約カードだけで、実行中の進捗を live に出す経路はまだ無い

## 記録に残らないこと

- 子セッションは `SessionManager.inMemory` で作り（`sessionId` も `entries` も渡さない）、親の `session.jsonl` には子の過程が 1 行も残らない。親に残るのは、親が受け取った toolResult だけ
- 子は `SessionStore` の record にならず、SSE の購読もイベントログも持たない。サーバー再起動で親のランごと消え、子の結果も残らない（`ask_user` と同じ既知の制限）
- 子のツール呼び出しの履歴表示（ネスト表示）は無い

## mask 規則

- 子の報告は `content` としてインライン拡張（`createSecretRedactionExtension`）を通ってから LLM・履歴・`tool_execution_end` へ渡る
- `details` はこの拡張の対象外なので、載せる値に文字列を入れない（回数・usage・終了理由だけ）。進捗は runner が `maskSafe` する

## 残るリスク

- 子が compaction した場合、初期の調査結果が報告から抜けうる（`details.compactions` が切り分けの手がかり）
- 4,000 文字の切り詰めで末尾が落ちる（結論先頭フォーマットで緩和。子がフォーマットを守るかは実測しないと不明）
- `content` 4,000 文字に対してカードで読めるのは 900 文字まで
- 子セッション生成コストは子モードでスキル発見を省く分だけ下がるが、`resourceLoader.reload()` は残る
- 子の `bash` による書き込みは防げない（[子の制約](#子の制約)）

## 検証

- `server/test/investigate.test.ts` — ツール契約（引数 / 報告の切り詰めと `details` / `isError` / mask）、タイムアウトと親 stop での部分報告、子セッションの生成条件、進捗の間引きと mask、並列上限 3 と待ち行列、親 stop での待機分の打ち切り、子の過程が親の会話ストアに残らないこと
- `server/test/agents.test.ts` — 子の追加プロンプトと読み取り専用ツールの積
