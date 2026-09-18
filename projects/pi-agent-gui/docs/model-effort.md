# モデル / Effort の解決と変更

モデルの選択は「アプリ既定 → セッション作成時の指定 → チャット単位の変更」の 3 段階があり、実効値は常に pi セッション（`session.model` / `session.thinkingLevel`）を正とする。

## アプリ既定の決定

アプリ既定モデルは `ModelRuntime.getAvailable()` の結果（認証済みモデルのみ）から決める。`PI_MODEL` を明示していればそれを使い、利用できない場合は別のモデルへ黙ってフォールバックせず `health.defaultModelError` として返す（`ready` は候補が 1 つ以上あれば true のまま）。`PI_MODEL` 未指定なら先頭候補を使う。

`PI_MODELS`（`provider/model` のカンマ区切り）を指定すると、available を組み立てる 1 箇所で whitelist との積を取り、そこから導出する `availableModels` / `modelOptions` / `selectedModel` / `resolveModel()` を一貫して絞り込む。個別にフィルタを足すと `PATCH /api/sessions/:id/settings` の経路から漏れるため、絞り込みはこの 1 箇所だけに置く。`PI_MODELS` 未指定は全件表示（後方互換）。whitelist と available の積が空なら（available の取得自体が例外になったときはそのエラーを優先）、`availabilityError` に `MODEL_WHITELIST_EMPTY_MESSAGE` を入れて `health.ready` を false にし、`errorCode: "model_whitelist_empty"` で原因が whitelist だと分かるようにする。認証が無い場合も whitelist が効いている以上候補は空になるため、このエラーは認証エラーより優先する。

モデル能力（対応する Effort の段階）は `@earendil-works/pi-ai` の公開ヘルパー `getSupportedThinkingLevels` / `clampThinkingLevel` を使う。`@earendil-works/pi-ai` は SDK と同じ 0.85.1 系を直接依存として持ち、推移依存の内部パスや dist 深部は import しない。

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
- Effort は JSONL の最後の `thinking_level_change` を使い、現在のモデル能力で clamp する（clamp は決定的なので補正後の値を entry へ必ず追記する必要はない）。payload には SDK が持つ実効値を返す

## チャット単位の変更

`PATCH /api/sessions/:id/settings` は同じ SDK セッション・履歴・タイトルを保つ。

1. 実行中・キューあり・SDK 非 idle・設定変更中なら 409（変更前にフラグを同期的に予約する）。
2. モデルは available と厳密照合（不在は 400）。
3. モデルだけの変更では、変更前の実効 `thinkingLevel` を退避して `setModel(model, {persist:false})` の後に再適用する（SDK のモデル切替既定に任せない）。両方指定時は要求値を再適用する。
4. `finally` でフラグを解除し、SDK 補正後の実効値で `resync` イベントを記録して返す。

送信（`POST /api/sessions/:id/messages`）は text だけを受け取り、モデルはそのセッションの SDK セッションが持つ実効値（`session.model`）で決まる。送信ごとのモデル指定は無いため、表示（入力欄 / ヘッダー）と実際の送信先が食い違わないよう、クライアントは選択中セッションの実効モデルだけを表示する。

エージェント定義の Model / Effort（`agent.model` / `agent.thinkingLevel`）はセッション作成時の初期値にだけ使い、既存チャットへ遡及しない（[api-catalog.md](api-catalog.md)）。

## クライアント側の表示

入力欄の Model / Effort ピッカーは `Composer` に置く。セッションがあれば `resync` で受け取った実効値、未作成のチャットでは「作成前の選択 → 選択中エージェントの定義 → health のアプリ既定」をサーバーと同じ優先順位で表示する（導出は `client/src/lib/composerSettings.ts`）。生成中・キュー待ち・設定変更通信中はピッカーを無効化し、設定変更通信中は送信も待たせる。
