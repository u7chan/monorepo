# エージェント / スキル API

規約と索引は [api.md](api.md) を参照する。定義は `server/src/agents.ts` のインメモリカタログで、再起動するとサンプル定義に戻る（[persistence.md](persistence.md)）。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/agents` | エージェントとスキルの一覧 |
| PUT | `/api/agents` | エージェント定義をJSONで一括置換 |
| POST | `/api/agents` | エージェント作成 `{ name, description, systemPrompt, skillIds, model?, thinkingLevel?, suggestions? }` |
| PATCH / PUT | `/api/agents/:id` | エージェント更新（キー省略は保持、`model` / `thinkingLevel` の `null` と `suggestions: []` は指定解除） |
| DELETE | `/api/agents/:id` | エージェント削除（最後の 1 体は削除不可） |
| GET | `/api/skills` | スキル一覧 |
| POST | `/api/skills` | スキル作成 `{ name, description, prompt }` |
| PATCH / PUT | `/api/skills/:id` | スキル更新 |
| DELETE | `/api/skills/:id` | スキル削除（エージェントの割り当てからも外れる） |

## エージェント定義の Model / Effort

エージェント定義には任意の `model`（`{ provider, id }`）と `thinkingLevel` を持たせられる。それぞれ独立して任意で、片方だけの指定や、Model 未指定で Effort だけの指定もできる。既定の組み込みエージェントはどちらも未指定。

- GET / export は未指定項目のキーを省略し、`null` は保存・応答に現れない。
- 更新要求はキー省略で保持、`model: null` / `thinkingLevel: null` で指定解除する。
- import はキー省略を未指定として受け付け、旧形式（追加項目なし）のファイルもそのまま使える。利用不能なモデル参照も形式が正しければ定義には保持できる（実行時に検証してエラーになる）。
- 不正な `ModelRef` や未知の `thinkingLevel` は 400。

```json
{
  "agents": [
    {
      "id": "agent-reviewer",
      "name": "コードレビュー",
      "description": "バグや保守性の問題を重要度順にレビューする",
      "systemPrompt": "…",
      "skillIds": ["skill-severity-review"],
      "model": { "provider": "openai", "id": "gpt-5.5" },
      "thinkingLevel": "high"
    }
  ],
  "skills": [
    {
      "id": "skill-severity-review",
      "name": "重要度順レビュー",
      "description": "指摘を重要度順に並べ、根拠と修正案を添える",
      "prompt": "指摘は重要度の高い順に並べてください。…"
    }
  ]
}
```

## エージェント定義の定型プロンプト

エージェント定義には任意の `suggestions`（`{ label, prompt }` の配列）を持たせられる。空の会話の firstview に `label` のボタンとして並び、押すと `prompt` をそのまま送信する（セッションタイトルの元にもなる）。既定の組み込みエージェントは `agent-builder` だけが 3 件を持つ。

- 未指定（空配列を含む）なら GET / export はキーを省略し、画面にもボタンを出さない（アプリ既定のフォールバックはない）。
- `label` は 60 文字、`prompt` は 500 文字で trim + 切り詰める。どちらかが空の要素は捨てる。
- 先頭から最大 6 件。`prompt` の重複は最初の 1 件だけ残し、重複は 6 件の枠を消費しない。
- 更新要求はキー省略で保持、`suggestions: []` で解除する。
- import はキー省略を未指定として受け付け、旧形式（追加項目なし）のファイルもそのまま使える。

```json
{
  "id": "agent-builder",
  "name": "コード実装",
  "suggestions": [
    { "label": "プロジェクトを説明して", "prompt": "このプロジェクトの構成を簡単に教えて" }
  ]
}
```

## エージェント定義のインポート / エクスポート

管理画面の「インポート」「エクスポート」から、エージェントとスキルを JSON ファイルで扱える。ファイルの形式は `/api/agents` の GET レスポンスと同じ。

```json
{
  "agents": [
    {
      "id": "agent-builder",
      "name": "コード実装",
      "description": "コードを読んで、安全に変更を実装する",
      "systemPrompt": "…",
      "skillIds": ["skill-change-report"]
    }
  ],
  "skills": [
    {
      "id": "skill-change-report",
      "name": "変更レポート",
      "description": "最後に変更点と確認方法を箇条書きで報告する",
      "prompt": "作業の最後に、変更したファイル・各変更の要点・動作確認の方法・残った課題を箇条書きで報告してください。"
    }
  ]
}
```

`PUT /api/agents` は現在のエージェント / スキル定義を読み込んだ内容で置き換える。既存の会話やセッションは変更しない。開発中のため `version` フィールドは持たせず、マイグレーションや後方互換性も考慮しない。

## 入力の正規化

- リクエストボディの形と型は `server/src/schema.ts` の body スキーマで検証する。必須判定と正規化（trim / 上限 / 未知キー）は `server/src/agents.ts` が正で、許容範囲は上記のとおり。
- エージェント名の必須チェックや `model` / `thinkingLevel` の正規化・日本語エラー文言は `agents.ts` 側が持つ。body スキーマを厳格化しないのは、空 body の PATCH を no-op として通し、必須判定をカタログの文言のまま残すため。
