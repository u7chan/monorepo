# Pi SDK steering の調査

調査日: 2026-10-20

これは調査時点の SDK とアプリ実装を対象にした開発調査の記録。製品仕様書や、アプリが作業フォルダへ生成する `HANDOFF.md` ではない。現行の挙動はコードとテストを正とし、依存更新や本体への組み込み時には再確認する。

## 調査の目的と到達点

- 実行中に修正指示を送っても、今の作業が終わってから追加されるため、途中で軌道修正できない。
- まず調査する依頼を受け、現行 BFF と SDK の仕様・実装・実体の挙動を確認した。
- **簡単な実装で現行の送信処理を模倣し、SDK の制御方法を比較したい**という追加依頼を受け、同日中に独立した最小実装と再実行できるテストを追加した（後述）。
- アプリ本体の送信処理は変更していない。現行 BFF のキュー動作もそのまま。

## 結論

遅延の理由は二つあり、分けて考える必要がある。

1. **現行 BFF は SDK の steering を使っていない。** 追加入力を独自キューに保持し、現在のランが完全終了してから次の `prompt()` を始める。
2. **SDK の `steer()` も即時中断ではない。** 現在の assistant 応答と、その応答が要求した全ツールの完了を待ち、次のモデル呼び出し前に修正指示を入れる。

したがって、「ランの完了まで待たず、次の判断から修正する」なら `steer()` が候補。「今の生成や長時間ツールを止めて修正する」なら、それだけでは不足し、`abort()` 後に同じセッションへ `prompt()` する経路が必要になる。

## 確認したバージョンと参照先

- `projects/u7agent/package.json` の SDK 指定は `@earendil-works/pi-coding-agent: ^1.3.0`。
- `projects/u7agent/pnpm-lock.yaml` の解決済みバージョンは `1.3.0`。`pi-agent-core` も `1.3.0`。
- ローカルにインストールされている同バージョンの SDK を読み、実行検証にも使用した。
- 初回調査時は u7agent の `node_modules` が無かった。最小実装の追加時に `pnpm install --frozen-lockfile` で既存依存を導入した。依存の追加・ロックファイルの変更は無い。

一次資料:

- [公式 SDK ドキュメント](https://pi.dev/docs/latest/sdk#prompting)
- SDK パッケージ内の `@earendil-works/pi-coding-agent/docs/sdk.md`、`@earendil-works/pi-coding-agent/docs/how-pi-works.md`、`@earendil-works/pi-coding-agent/docs/settings.md`、`@earendil-works/pi-coding-agent/docs/usage.md`
- SDK パッケージ内の `examples/sdk/01-minimal.ts`、`examples/sdk/12-full-control.ts`
- SDK パッケージ内の `dist/core/agent-session.js`、`dist/core/sdk.js`
- 依存 `@earendil-works/pi-agent-core` の `README.md`、`dist/agent-loop.js`、`dist/agent.js`

`latest` の内容は変わり得るため、再調査では実際に使うバージョンの実装を正にする。

## 調査時点のアプリで確認したこと

以下のパスは `projects/u7agent/` からの相対パス。行番号は調査時点の目安。

| 場所 | 現在の挙動 |
| --- | --- |
| `server/src/routes/sessions.ts:256` | 送信を受け付け、スキル・添付を展開して `store.postMessage()` へ渡す。steer / follow-up / 即時中断を選ぶ入力は無い |
| `server/src/sessions.ts:989` | `postMessage()`。実行中または手動圧縮中なら独自キューへ入れる |
| `server/src/sessions.ts:1024` | `record.queue.push({ text, runId })`。この時点では SDK へ渡さない |
| `server/src/sessions.ts:2251` | `startRun()`。`session.prompt(text)` をバックグラウンドで実行 |
| `server/src/sessions.ts:2342` | ランの `finish()` 後に、200ms 遅延で `pump()` を予約 |
| `server/src/sessions.ts:2459` | `pump()`。実行中なら何もせず、終了後にキュー先頭で新しいランを始める |
| `server/src/sessions.ts:1204` | `stop()`。BFF キューを破棄し、回答待ちを取り消して `session.abort()` を呼ぶ |
| `server/src/pi-runtime.ts` | BFF の `PiSessionLike` は `prompt(text)` / `abort()` のみを公開し、`steer()` や prompt の streaming オプションを型に含めていない |
| `client/src/hooks/sessionActions.ts:50` | 実行中の追加入力も POST する。現在のランの終了をクライアント側で待っているわけではない |
| `server/test/sessions-store.test.ts:51` | 実行中の送信をキューに積み、順番に別ランとして実行する既存テストがある |

調査時点の流れ:

```text
追加指示を POST
  → BFF の独自キューへ保存
  → 現在の作業を最後まで継続
  → agent_settled / finish()
  → 200ms 後に pump()
  → 新しい prompt()
```

**200ms の短縮だけでは本質的に改善しない。** 待っているのはラン全体の終了。

## SDK の制御方法と限界

| 操作 | 挙動 |
| --- | --- |
| `session.steer(text)` | 現在の assistant 応答と全ツールの終了後、次のモデル呼び出し前に注入 |
| `session.prompt(text, { streamingBehavior: "steer" })` | 実行中なら steering としてキューへ。アイドルなら通常のランを開始 |
| `session.followUp(text)` | ツール処理と steering を終え、現在の作業が自然終了する位置で追加指示を処理 |
| `session.prompt(text, { streamingBehavior: "followUp" })` | 実行中なら follow-up としてキューへ |
| `await session.abort()` | 現在の操作を中断し、アイドルになるまで待つ。追加の `waitForIdle()` は通常不要 |
| `session.clearQueue()` | SDK の未配信 steering / follow-up を取り出してクリア |

注意点:

- 同じ assistant 応答がツールを複数要求した場合、**逐次実行でも並列実行でも、そのバッチをすべて終えてから** steering を入れる。未実行の残りのツールを自動でスキップするわけではない。
- 生成途中の思考や最終回答も `steer()` では中断しない。ツールの無い長い最終回答では、回答を最後まで出した後に修正指示が入る。
- `steeringMode` の `"all"` / `"one-at-a-time"` は一度に配送するメッセージ数の設定。即時中断への切り替えではない。既定は `"one-at-a-time"`。
- `steer()` / `followUp()` の戻り値 `"queued"` はモデルへの反映完了ではなく受付を示す。拡張が入力を消費すると `"handled"` になる。
- アイドル時の `steer()` は通常の `prompt()` の代わりにはならない。最小再現では実行中であることを制御する。
- `abort()` は実行済みのファイル変更などを巻き戻さない。ツールの停止速度は AbortSignal 対応次第。
- `agent_end` だけでは SDK の自動継続や再試行が残り得る。ラン全体の終端を確認するなら `agent_settled` または元の `prompt()` の解決を見る。

## 実行して確認済みの 5 ケース

実際の SDK 1.3.0 で `createAgentSession()` を使用し、`ModelRuntime.streamSimple` の通信部分だけをモック化した。外部モデルへのリクエスト・実キー・実クォータは使用していない。

| ケース | 観測した結果 |
| --- | --- |
| 逐次ツール実行中の steer | tool 1 中に受け付けても tool 2 を実行し、その終了後に修正指示を注入 |
| 並列ツール実行中の steer | 片方の終了だけでは注入せず、両方の終了後に注入 |
| 応答生成中の steer | 元の応答を完了し、その後に修正指示を注入。生成の signal は abort されない |
| ツール実行中の follow-up | ツール結果を受けた通常の応答まで完了してから追加指示を注入 |
| 生成中の abort → キュー回収 → 再 prompt | 中断・アイドル化後に同じセッションで新指示を実行できた。**このケースでは abort だけだと未配信の steer が 1 件残った** |

すべて assertion 付きで成功。初回のスクリプトは標準入力で実行し、ファイルとして保存していない。後述の最小実装はリポジトリに保存済み。これは SDK 単体の検証であり、BFF / GUI の受入検証ではない。

代表的なイベント順:

```text
steer:
  元の user → モデル要求 1 → assistant(toolUse)
  → tool 1 開始 → steer 受付 → tool 1 終了
  → tool 2 開始 → tool 2 終了
  → 修正 user → モデル要求 2 → 修正後の assistant → agent_settled

follow-up:
  元の user → モデル要求 1 → assistant(toolUse) → ツール実行
  → モデル要求 2 → 元の作業の assistant(stop)
  → 追加 user → モデル要求 3 → 追加作業の assistant → agent_settled
```

## 追加した最小実装と再実行方法

以下のパスは `projects/u7agent/` からの相対パス。

- [scripts/steering-send.ts](../../scripts/steering-send.ts): 追加入力を渡す比較用の小さな関数。`queue` は元のラン完了後に `prompt()`、`steer` は実行中に `steer()`、`interrupt` は未配信キューをクリアして `await abort()` 後に同じセッションへ `prompt()` する。
- [server/test/sdk-steering.test.ts](../../server/test/sdk-steering.test.ts): SDK 実体を動かす独立した再現テスト。モデル応答だけを `registerProvider()` のカスタム `streamSimple` でモック化し、SDK のラン・ツール実行・キュー・停止は差し替えない。
- `package.json` の `probe:steering`: この調査だけを実行し、注入順序をログへ出す。既存の server テストにも自動的に含まれる。

```sh
cd projects/u7agent
pnpm install --frozen-lockfile
pnpm probe:steering
```

HTTP / React / BFF / サンドボックスは使用しない。認証・セッションは一時ディレクトリとメモリへ隔離し、終了時に破棄する。`fetch` の呼び出しを禁止し、呼び出し数がゼロであることも検査する。有料 API や既存の会話ストアは使わない。

### 比較結果

生成中・逐次ツール実行中それぞれの 3 方式、並列ツール中の steer、未配信 steer を抱えた状態からの中断の計 8 ケースが成功した。

| 場面 | queue（現行模倣） | steer | interrupt |
| --- | --- | --- | --- |
| 生成途中 | 元の応答とランの完了後に修正指示を送る | 元の応答は完了するが、ランを閉じずに修正指示を送る | 元の生成を打ち切り、アイドル化してから新指示を送る |
| 逐次ツールの 1 本目 | 2 本目と、ツール結果を受けた元の最終応答まで完了してから送る | 2 本目までは実行するが、元の最終応答の要求より先に修正指示を送る | 1 本目の signal を abort し、2 本目のツール本体を実行せずに新指示へ移る |

並列ツールも、片方の完了だけでは steer は入らず、バッチ全体の終了を待つ。中断モードでは、回収した未配信 steer を再実行しない。

これは**注入境界の確認**であり、実モデルが指示に従うかの評価や停止時間のベンチマークではない。現行 BFF の 200ms 遅延も再現していない。実モデル・サンドボックスの停止速度、連続送信、停止と送信の競合は未検証。比較用関数の中断は未配信キューを破棄するため、ユーザー入力を未送信として保護する本体実装へそのまま流用しない。

### 検証結果

- `pnpm probe:steering`: 8 件すべて成功。
- `pnpm check`: 成功（lint / format / docs / server・client 型チェック / テスト / client build）。server は 1553 件成功・25 件 skip、client は 1650 件成功。skip は既存の Playwright テストで、ブラウザ実行ファイルが未導入のため。
- 通常のチェック対象外である `scripts/steering-send.ts` も、新しいテストと合わせて `oxlint` と `oxfmt --check` を個別実行し、成功。
- GUI 受入と実モデルの呼び出しは未実施。本体の挙動は変更していない。

### 新たに観測した停止理由の注意点

SDK 1.3.0 では、ツールを中断した後の assistant に `stopReason: "error"`、`errorMessage: "This operation was aborted"` が残った。同じセッションへの次の `prompt()` は正常に完了した。

実装を追うと、ツール中断後の継続で、既に abort 済みの signal により `ModelRuntime` の次の要求準備が失敗し、依存 `pi-ai` の `dist/api/lazy.js` が準備中の例外を一律 `error` としてメッセージ化している。この停止はモック provider が返したモデルエラーではない。

したがって、本体へ中断経路を足すときも停止判定を `stopReason === "aborted"` だけに依存させない。現行 BFF は既に `run.stopRequested` を停止判定に使っている。今回 SDK や本体への修正はしていない。

## 最小調査の当初計画（上記の実装で実施）

本体へ組み込む前に、独立した小さなスクリプトで比較する。

1. **模倣範囲を絞る**: 1 セッション、最初の入力、処理中の追加入力、単純なキュー、疑似的に待つツールだけ。HTTP / React / 永続化 / サンドボックスは最初は持ち込まない。
2. 次の 3 経路を同じ入力シナリオで比較する。
   - 現行模倣: BFF 相当のキュー → 元の `prompt()` 完了後に次の `prompt()`。
   - Native steering: 実行中に `steer()` または `prompt(..., { streamingBehavior: "steer" })`。
   - 即時中断: SDK の未配信キューの扱いを明示して `await abort()` → 同じセッションへ `prompt()`。
3. 入力受付、assistant 完了、ツール開始・終了、修正 user の注入、次のモデル要求、`agent_settled` の順序をログに出す。
4. まず gate 付きの通信モックで順序を決定的に検証する。長い生成、長いツール、同じ応答内の複数ツールを別ケースにする。
5. 実モデルを使う体感検証は別段階にする。モックの結果を実モデルの判断・追従性まで保証するものとは扱わない。

最小ハーネスを再構成するときの部品:

- `createAgentSession()` と `SessionManager.inMemory()`。
- `SettingsManager.inMemory()` で retry / compaction / cache warming を無効化。
- 空の拡張・スキル・コンテキストを返す `ResourceLoader`。完全制御の形は SDK の `examples/sdk/12-full-control.ts` を参照。
- `ModelRuntime` に検証用モデルを登録し、`streamSimple` を `createAssistantMessageEventStream()` のモックへ差し替える。
- ツールやストリームの待機は gate で制御し、任意の sleep 時間にテストの成否を依存させない。保存済みのテストは既存の ES2023 型設定を変えずに動かすため、`Promise.withResolvers()` ではなく小さな gate ヘルパーを使う。

## 本体へ反映するときに残る設計課題

ここは未実装・未合意。最小調査の後に判断する。

- 通常送信を steer にするか、終了後の追加依頼と即時中断を操作として分けるか。
- 現状の「1 送信 = 1 runId / 1 prompt()」と、同じ SDK ラン内へ入る steering の対応付け。
  - `sessions.ts` の `onPromptMessage` は現状、すべての user を現在の `run.id` へ結び付ける。単に `steer()` を呼ぶだけでは、新しい送信 ID との対応が崩れる。
- `sends.json` の未送信記録、キューの 1 件取消、再起動後の復旧、SSE / ローカルエコーとの整合。
- 停止時の SDK キュー回収。既存の `stop()` が消しているのは BFF の独自キューであり、SDK キューとは別物。
- 手動圧縮中・retry 待機中・`ask_user` 回答待ち・ラン開始直前 / 終了直後の競合。
- 即時中断中に次の送信が来た場合の直列化と、古い指示の重複実行防止。
- サンドボックスの abort 伝播経路は既に `server/src/sandbox/client.ts` にある。ただし、実際の停止速度はこの調査では計測していない。

直ちに行わないこと: アプリ全体のキュー置換、ラン管理の変更、既存テストの仕様変更、実行済み副作用の巻き戻し。
