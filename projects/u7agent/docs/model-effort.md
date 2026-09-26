# モデル / Effort の解決と変更

モデルの選択は「アプリ既定 → セッション作成時の指定 → チャット単位の変更」の 3 段階があり、実効値は常に pi セッション（`session.model` / `session.thinkingLevel`）を正とする。

プロバイダーの認証は `PI_MODEL` / `PI_MODELS` の解釈より前段で、`ModelRuntime.getAvailable()` の入力になる。設定 → モデルから登録したAPIキーは runtime overlay として環境変数や `auth.json` より優先され、登録・削除の直後に available を再計算する（[model-settings.md](model-settings.md)）。

## モデル state の再計算

available と診断は起動時に一度だけ読むのではなく、`readModelState()`（snapshot 読取 → `deriveModelState()`）で作り直し、`PiBff` の getter 群（`availableModels` / `modelOptions` / `selectedModel` / `defaultModelError` / `availabilityError` / `modelWhitelistExcludesAll` / `runtimeDiagnostics`）が常に同じ 1 参照を返す。再計算は認証変更のミューテーションロックの内側だけで行い、`getAvailable()` の失敗は「可用 0 + `availabilityError`」として公開する（古い可用一覧を成功として残さない）。導出そのものが失敗してもロックを壊さず、可用 0 の安全な state にする。`availabilityError` は health に出るため必ずマスカーを通す。

## アプリ既定の決定

アプリ既定モデルは `ModelRuntime.getAvailable()` の結果（認証済みモデルのみ）から決める。`PI_MODEL` を明示していればそれを使い、利用できない場合は別のモデルへ黙ってフォールバックせず `health.defaultModelError` として返す（`ready` は候補が 1 つ以上あれば true のまま）。`PI_MODEL` 未指定なら先頭候補を使う。

`PI_MODELS`（`provider/model` のカンマ区切り）を指定すると、available を組み立てる 1 箇所で whitelist との積を取り、そこから導出する `availableModels` / `modelOptions` / `selectedModel` / `resolveModel()` を一貫して絞り込む。個別にフィルタを足すと `PATCH /api/sessions/:id/settings` の経路から漏れるため、絞り込みはこの 1 箇所だけに置く。`PI_MODELS` 未指定は全件表示（後方互換）。whitelist と available の積が空なら（available の取得自体が例外になったときはそのエラーを優先）、`availabilityError` に `MODEL_WHITELIST_EMPTY_MESSAGE` を入れて `health.ready` を false にし、`errorCode: "model_whitelist_empty"` で原因が whitelist だと分かるようにする。認証が無い場合も whitelist が効いている以上候補は空になるため、このエラーは認証エラーより優先する。

モデル能力（対応する Effort の段階）は `@earendil-works/pi-ai` の公開ヘルパー `getSupportedThinkingLevels` / `clampThinkingLevel` を使う。`@earendil-works/pi-ai` は SDK と同じ 0.87.1 系を直接依存として持ち、推移依存の内部パスや dist 深部は import しない。

`thinkingLevel` の非対応値は SDK がモデル能力で補正する（BFF では模倣しない）。既定の Effort は `PI_MODEL` の末尾指定 → `PI_THINKING` → `medium` の優先順位で決まる。

## セッション作成時の解決

新規チャットの初期値は項目別に「作成時のチャット指定 → エージェント定義 → アプリ既定」の順で `SessionStore.create()` が解決し、`createAgentSession()` へ渡す。

```
POST /api/sessions { model?, thinkingLevel? }
  └─ create(): request ?? agent def ?? undefined (undefined はランタイムのアプリ既定)
       └─ pi.createSession(): available と厳密照合してから SDK 作成 (不在は 400 / 候補ゼロは 503)
```

## 復元時の解決

保存済みセッションを開くとき（BFF 再起動後・sweep 後の復元）は、保存値（`session.jsonl` の最後の `model_change` → meta の `model`）を `availableModels` と厳密照合し、候補があればそれを、無ければアプリ既定を使って `createAgentSession()` に渡す。`model` を明示しない SDK の自動復元は `PI_MODELS` の絞り込みを迂回するため使わない。

- フォールバックしたときは実効モデルを `model_change` entry へ追記して保存し、meta の `model` も更新する。元モデルが後で候補に戻っても、続きを別モデルで進めたセッションは元へ戻らない
- 利用可能なモデルが 1 つも無いときはセッションを開く要求を 503 で拒否し、一覧（meta）からは消さない
- 設定 → モデルでキーを削除した provider の会話も同じ規則で解決する。未ロードの会話は次の復元時に候補が無ければアプリ既定へフォールバックし、フォールバックした実効値を保存する
- Effort は JSONL の最後の `thinking_level_change` を使い、現在のモデル能力で clamp する（clamp は決定的なので補正後の値を entry へ必ず追記する必要はない）。payload には SDK が持つ実効値を返す

## チャット単位の変更

`PATCH /api/sessions/:id/settings` は同じ SDK セッション・履歴・タイトルを保つ。

1. 実行中・キューあり・SDK 非 idle・設定変更中なら 409（変更前にフラグを同期的に予約する）。
2. モデルは available と厳密照合（不在は 400）。
3. モデルだけの変更では、変更前の実効 `thinkingLevel` を退避して `setModel(model, {persist:false})` の後に再適用する（SDK のモデル切替既定に任せない）。両方指定時は要求値を再適用する。
4. `finally` でフラグを解除し、SDK 補正後の実効値で `resync` イベントを記録して返す。

送信（`POST /api/sessions/:id/messages`）は text だけを受け取り、モデルはそのセッションの SDK セッションが持つ実効値（`session.model`）で決まる。送信ごとのモデル指定は無いため、表示（入力欄 / ヘッダー）と実際の送信先が食い違わないよう、クライアントは選択中セッションの実効モデルだけを表示する。

エージェント定義の Model / Effort（`agent.model` / `agent.thinkingLevel`）はセッション作成時の初期値にだけ使い、既存チャットへ遡及しない（[api-catalog.md](api-catalog.md)）。

## 既存の会話への影響（認証の変更）

設定 → モデルからAPIキーを登録・削除しても、**起動中のセッションのモデルは自動で切り替えない**。

- 削除した provider のキーだけで認証していた会話は、次回の送信が認証で失敗しうる（環境変数や `auth.json` の認証があればそちらが使われる）
- 未ロードの会話は復元時に上の「復元時の解決」を通るため、`PI_MODELS` の候補が無ければ別のモデルへ落ちる。このとき切替は `model_change` へ保存され、元に戻らない
- `applied_unsynced`（保存済み・未反映）の間は、available が古いまま公開 state に残りうる。実際の送信は SDK が持つ認証に従うため、選択中モデルの送信が失敗する可能性がある（設定 → モデルに警告と再同期の導線を出す）

## クライアント側の表示

入力欄の Model / Effort ピッカーは `Composer` に置く。セッションがあれば `resync` で受け取った実効値、未作成のチャットでは「作成前の選択 → 選択中エージェントの定義 → health のアプリ既定」をサーバーと同じ優先順位で表示する（導出は `client/src/lib/composerSettings.ts`）。同じ実効値は入力欄の上の状態行（`client/src/components/composer/ComposerStatus.tsx`）にも出し、ピッカーを畳んでいても使用中モデルが分かるようにする。表示名は候補を引ければ `ModelOption.name`、引けなければ `provider/id` を使う。ピッカーを開いている間も表示は実効値のままで、変更したときは `resync` が返った時点で入れ替わる（クライアントでは楽観的に書き換えない。サーバーが SDK 補正後の値を返すまで実際の送信先と食い違い得るため）。生成中・キュー待ち・設定変更通信中はピッカーを無効化し、設定変更通信中は送信も待たせる。compact で畳んでいるときも、モデルが利用できない警告と送信できない理由は入力欄の下に出る。

compact（portrait / landscape）では、送信が成立した時点でパネルを畳む。狭い画面で入力欄の上を占め、実行中はピッカーを無効化していて操作できないため。畳む合図は送信の成立（`sending` の立ち上がり）で、入力欄からの送信だけでなく `ChatArea` の suggestion からの送信も同じ扱いにする。desktop は送信しても開いたままにする。畳む条件に portrait を要求しないのは、ソフトキーボードで `window.innerHeight` が縮むと入力中に landscape へ切り替わる端末があるため（[ui-layout.md](ui-layout.md)）。
