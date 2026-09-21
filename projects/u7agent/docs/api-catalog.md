# エージェント / スキル API

規約と索引は [api.md](api.md) を参照する。定義は `server/src/agents.ts` のインメモリカタログで、再起動するとサンプル定義に戻る（[persistence.md](persistence.md)）。本文中の JSON の `id` は形を示す任意の例で、ビルトインは汎用アシスタント `agent-general`、初期状態のスキルはどのエージェントにも割り当てていないサンプル `skill-zundamon-speech` だけ。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/agents` | ビルトイン + エージェント（ユーザー定義）とスキルの一覧 |
| PUT | `/api/agents` | エージェント（ユーザー定義）の定義をJSONで一括置換（ビルトインは含めない） |
| POST | `/api/agents` | エージェント作成 `{ name, description, systemPrompt, skillIds, model?, thinkingLevel?, suggestions? }` |
| PATCH / PUT | `/api/agents/:id` | エージェント更新（キー省略は保持、`model` / `thinkingLevel` の `null` と `suggestions: []` は指定解除。ビルトインは 400） |
| DELETE | `/api/agents/:id` | エージェント削除（ビルトインは 400。ユーザー定義は 0 件まで減らせる） |
| GET | `/api/skills` | スキル一覧 |
| POST | `/api/skills` | スキル作成 `{ name, description, prompt }` |
| PATCH / PUT | `/api/skills/:id` | スキル更新 |
| DELETE | `/api/skills/:id` | スキル削除（エージェントの割り当てからも外れる） |

## ビルトインの汎用エージェント

セッション作成の既定エージェントを保証するため、汎用アシスタント `agent-general` はサーバー所有のビルトインとして置換対象の `agents` に入れない。

- GET / PUT の応答は `builtinAgent` を別フィールドで常に返し、`agents` はユーザー定義だけになる（0 件も許す）。
- `PATCH` / `DELETE /api/agents/agent-general` は 400（`Built-in agent cannot be updated` / `Built-in agent cannot be deleted`）。
- `PUT /api/agents` の `agents` にビルトイン id が含まれていたら 400（`Agent id agent-general is reserved for the built-in agent`）。送った定義がそのまま入るのが置換の意味なので、黙って捨てない。
- ビルトインは編集できない前提なので、model / Effort も固定（どちらも未指定 = アプリ既定）。変更はチャット単位の Model / Effort ピッカーで行う（[model-effort.md](model-effort.md)）。
- `POST /api/sessions` の `agentId` 省略時はこのビルトインを使うので、ユーザー定義が 0 件でもセッションを作れる。

```json
{
  "builtinAgent": {
    "id": "agent-general",
    "name": "汎用アシスタント",
    "description": "役割や口調を設定していない既定のエージェント",
    "systemPrompt": "",
    "skillIds": [],
    "suggestions": [{ "label": "プロジェクトを説明して", "prompt": "このプロジェクトの構成を簡単に教えて" }]
  },
  "agents": [],
  "skills": []
}
```

## エージェント定義の Model / Effort

エージェント定義には任意の `model`（`{ provider, id }`）と `thinkingLevel` を持たせられる。それぞれ独立して任意で、片方だけの指定や、Model 未指定で Effort だけの指定もできる。ビルトインの汎用アシスタントはどちらも未指定。

- GET / export は未指定項目のキーを省略し、`null` は保存・応答に現れない。
- 更新要求はキー省略で保持、`model: null` / `thinkingLevel: null` で指定解除する。
- 取り込みはキー省略を未指定として受け付け、追加項目の無い定義もそのまま使える。利用不能なモデル参照も形式が正しければ定義には保持できる（実行時に検証してエラーになる）。
- 不正な `ModelRef` や未知の `thinkingLevel` は 400。

```json
{
  "agents": [
    {
      "id": "agent-example",
      "name": "コードレビュー",
      "description": "バグや保守性の問題を重要度順にレビューする",
      "systemPrompt": "…",
      "skillIds": ["skill-example"],
      "model": { "provider": "openai", "id": "gpt-5.5" },
      "thinkingLevel": "high"
    }
  ],
  "skills": [
    {
      "id": "skill-example",
      "name": "重要度順レビュー",
      "description": "指摘を重要度順に並べ、根拠と修正案を添える",
      "prompt": "指摘は重要度の高い順に並べてください。…"
    }
  ]
}
```

## エージェント定義の定型プロンプト

エージェント定義には任意の `suggestions`（`{ label, prompt }` の配列）を持たせられる。空の会話の firstview に `label` のボタンとして並び、押すと `prompt` をそのまま送信する（セッションタイトルの元にもなる）。ビルトインの `agent-general` だけが 3 件を持つ。

- 未指定（空配列を含む）なら GET / export はキーを省略し、画面にもボタンを出さない（アプリ既定のフォールバックはない）。
- `label` は 60 文字、`prompt` は 500 文字で trim + 切り詰める。どちらかが空の要素は捨てる。
- 先頭から最大 6 件。`prompt` の重複は最初の 1 件だけ残し、重複は 6 件の枠を消費しない。
- 更新要求はキー省略で保持、`suggestions: []` で解除する。
- 取り込みはキー省略を未指定として受け付け、追加項目の無い定義もそのまま使える。

```json
{
  "id": "agent-example",
  "name": "コード実装",
  "suggestions": [
    { "label": "プロジェクトを説明して", "prompt": "このプロジェクトの構成を簡単に教えて" }
  ]
}
```

## エージェント定義のインポート / エクスポート

設定の「バックアップ」ページ（`client/src/components/BackupPage.tsx`）から、チェックした対象を JSON ファイルで扱える。
エージェントとスキルは `data.definitions` に入り、その値が `PUT /api/agents` のボディになる。ビルトインの汎用エージェントは `agents` に含まれないので、書き出しにも乗らず、取り込みでも置き換わらない。
封筒（`app` / `schema` / `exportedAt` / `data`）と対象の一覧は [persistence.md](persistence.md) を参照する。

```json
{
  "app": "u7agent",
  "schema": 1,
  "exportedAt": "2026-02-01T12:34:56.789Z",
  "data": {
    "definitions": {
      "agents": [
        {
          "id": "agent-example",
          "name": "コード実装",
          "description": "コードを読んで、安全に変更を実装する",
          "systemPrompt": "…",
          "skillIds": ["skill-example"]
        }
      ],
      "skills": [
        {
          "id": "skill-example",
          "name": "変更レポート",
          "description": "最後に変更点と確認方法を箇条書きで報告する",
          "prompt": "作業の最後に、変更したファイル・各変更の要点・動作確認の方法・残った課題を箇条書きで報告してください。"
        }
      ]
    }
  }
}
```

`data.definitions` は現在のエージェント（ユーザー定義）/ スキル定義を置き換える（`PUT /api/agents`）。ビルトインの汎用エージェントは対象外で、その id を `agents` に含むファイルは 400 になる。既存の会話やセッションは変更しない。
封筒なしで `agents` / `skills` を直下に持つ旧形式のファイルは受理しない。
封筒の `schema` が一致しないファイルも読み込まず、エラーを表示する（開発中のため移行は持たない）。

## 入力の正規化

- リクエストボディの形と型は `server/src/schema.ts` の body スキーマで検証する。必須判定と正規化（trim / 上限 / 未知キー）は `server/src/agents.ts` が正で、許容範囲は上記のとおり。
- エージェント名の必須チェックや `model` / `thinkingLevel` の正規化・日本語エラー文言は `agents.ts` 側が持つ。body スキーマを厳格化しないのは、空 body の PATCH を no-op として通し、必須判定をカタログの文言のまま残すため。
