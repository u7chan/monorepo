# 会話の圧縮（compaction）表示

pi SDK はコンテキストが上限に近づくと会話を自動で compaction（古いメッセージを要約へ置き換えて context から外す）する。BFF はその結果を履歴として残し、GUI は圧縮位置の区切りと要約を出す。DTO と SSE イベントの契約は [api-sessions.md](api-sessions.md)、保存を見据えた要件は [persistence.md](persistence.md) を正とする。

## SDK が起きること

- `compaction_end` の時点で、SDK は compaction entry を SessionManager に積み、`session.messages` を「最新の compaction の要約 + `firstKeptEntryId` 以降 + 圧縮後に積まれた分」へ組み替える。`getBranch()` には圧縮前の元 entry も残る（BFF は `SessionManager.inMemory`）
- `CompactionEntry` は `id` / `parentId` / `timestamp` / `summary` / `firstKeptEntryId` / `tokensBefore` / `usage` / `fromHook` を持つ。`reason` と `estimatedTokensAfter` は `compaction_end` の `CompactionResult` にしか無く、いつでも読める `session.messages` からは復元できない
- SDK は最新の compaction しか context に残さないため、2 回目以降の圧縮では以前の圧縮位置が `messages` から失われる

## 表示仕様

| 項目 | 仕様 |
| --- | --- |
| 区切り | 圧縮位置に 1 行出す。例 `ここで会話を圧縮しました（自動: 68k tokens から）`。文言は `client/src/lib/compaction.ts` の純関数が持ち、compact（portrait / landscape）でも出す |
| 理由 | `manual` = 手動 / `threshold` = 自動 / `overflow` = 上限超過。区切りと要約一覧の両方で区別する |
| 数値 | 区切りに出すのは `tokensBefore` のみ（pi TUI と同じ）。`estimatedTokensAfter` は推定値であり Context ゲージ（provider 実測）と食い違って見えるため出さない。DTO には保持する |
| 要約 | 折りたたみ（既定は畳む）。開くと全要約を古い→新しいの通し番号付きで一覧表示する |
| 位置 | 区切りを位置に出せるのは最新の 1 件だけ（`beforeMessageIndex`）。位置は `messages` と同じ集合を数えて求め、entry は「compaction より手前か」の判定にだけ使う。複数回のときは「この会話は N 回圧縮されました」を要約一覧の先頭に出す |
| 圧縮前の元メッセージ | 表示しない（entry ベースの履歴 DTO は対象外） |
| 反映 | `compaction` イベントの後に届く `resync` で `messages` / `compactions` を置き換える。SDK は送信メッセージを履歴へ入れる前に compaction を走らせることがあるため、その場合は送信メッセージが入ってから `resync` を配る（先に配るとそのメッセージが履歴から消える）。リロード・再接続はサーバー payload を正とする |
| 失敗・中断 | `result` が無い / `aborted` / `errorMessage` ありのときは `compaction` も `resync` も配らず、履歴と区切りを変えない（既存の status 遷移とエラー表示に任せる） |

要約は `messages` に混ぜず `SessionPayload.compactions` として配り、`messages` は従来どおり role `user` / `assistant` だけにする。要約テキストは他の出力と同じマスカーを通してから配る。

## 環境変数（検証用）

| 変数 | 説明 |
| --- | --- |
| `PI_COMPACTION_RESERVE_TOKENS` | compaction を起こす閾値（コンテキストに残す余裕）。未設定・不正値は SDK 既定の `16384` |
| `PI_COMPACTION_KEEP_RECENT_TOKENS` | compaction 後に context へ残す直近トークン数。未設定・不正値は SDK 既定の `20000` |

## 検証

### 自動テスト（必須）

```bash
cd projects/pi-agent-gui
pnpm check   # typecheck + test + build
```

- `server/test/compaction.test.ts` — `server/test/stub-pi.ts` の `compact()` で `compaction_start` / `compaction_end` を発火させ、payload（要約の分離・`beforeMessageIndex`・複数回・`firstKeptEntryId` が metadata entry を指す場合・マスク）と SSE イベント（`compaction` → `resync`、異常系では配らない）を固定する。実 API は呼ばない
- `client/test/compaction.test.ts` — 区切り / 要約一覧のラベル整形を純関数として固定する（DOM は使わない）
- `client/test/chatReducer.test.ts` — `compaction` イベントの取り込みと resync の適用を固定する

### 実 API での目視（低コスト・任意）

閾値を意図的に下げれば、コンテキストを埋めずに数円以下で発火できる。`deepseek/deepseek-v4-flash`（$0.14/M input・1M context）で閾値 10k tokens なら 1 回の発火まで 1 円未満。

1. `PI_CODING_AGENT_DIR=/tmp/pi-agent-gui-compact-verify` を指定し、普段の `~/.pi/agent` を汚さない。`auth.json` をコピーし、`models.json` に contextWindow の override を書く（例: `providers.deepseek.modelOverrides."deepseek-v4-flash".contextWindow = 40000`）
2. 検証用 env で閾値を下げる（例: `PI_COMPACTION_RESERVE_TOKENS=30000` / `PI_COMPACTION_KEEP_RECENT_TOKENS=4000`）。contextWindow を触らない場合は `reserveTokens` だけで閾値を下げる。`pnpm dev` はプロジェクト root の `.env` を読むので、そこへ書くかシェルの環境変数で渡す
3. `PI_MODELS=deepseek/deepseek-v4-flash` で起動し、長文を貼って閾値を越えさせる（10k tokens 程度）
4. 確認: 区切り位置（圧縮前のメッセージが消え、区切りと要約に置き換わる）・要約の折りたたみ・リロード後の保持・2 回目の圧縮（再度長文を貼る）・Context ゲージの推移
5. 戻し方: 一時ディレクトリを消し、env を外すだけ（`models.json` の override も一時ディレクトリ内なので残らない）

目視の viewport は [ui-layout.md](ui-layout.md) の viewport 表（desktop 1440x900 / portrait 390x844 / landscape 844x390）に従う。確認するのは次の 2 点:

- 長い要約（1 行が長いテキスト）でも区切りと要約一覧が横に溢れない（`break-words` で折り返す）
- compact でも区切りの 1 行が出て、要約が畳まれたままである

compaction を手動で起こす UI は無い（SDK の auto compaction のみ）。BFF から `compact()` を呼ぶ導線は別件とする。
