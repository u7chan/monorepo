# エージェント / スキル API

規約と索引は [api.md](api.md) を参照する。定義は `server/src/agents.ts` のカタログで、実体はアプリデータの SQLite へ保存し、再起動後も残る（[persistence.md](persistence.md)）。本文中の JSON の `id` は形を示す任意の例で、ビルトインは汎用アシスタント `agent-general`。初期状態はカタログスキル 0 件と、ユーザー定義のサンプル `agent-zundamon`（ずんだもん）1 体。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/agents` | ビルトイン + エージェント（ユーザー定義）とスキルの一覧（同梱の組み込みスキルを `builtinSkills` で含む） |
| POST | `/api/agents` | エージェント作成 `{ name, description, systemPrompt, skillIds, icon?, model?, thinkingLevel?, suggestions? }` |
| PATCH / PUT | `/api/agents/:id` | エージェント更新（キー省略は保持、`icon` / `model` / `thinkingLevel` の `null` と `suggestions: []` は指定解除。ビルトインは 400） |
| DELETE | `/api/agents/:id` | エージェント削除（ビルトインは 400。ユーザー定義は 0 件まで減らせる） |
| GET | `/api/skills` | スキル一覧 |
| GET | `/api/skills/files` | ファイルスキル（`.agents/skills`）の読み取り専用一覧 |
| POST | `/api/skills` | スキル作成 `{ name, description, body }` |
| PATCH / PUT | `/api/skills/:id` | スキル更新 |
| DELETE | `/api/skills/:id` | スキル削除（エージェントの割り当てからも外れる） |

## ビルトインの汎用エージェント

セッション作成の既定エージェントを保証するため、汎用アシスタント `agent-general` はサーバー所有のビルトインとしてユーザー定義の `agents` に入れない。

- GET の応答は `builtinAgent` を別フィールドで常に返し、`agents` はユーザー定義だけになる（0 件も許す）。
- `PATCH` / `DELETE /api/agents/agent-general` は 400（`Built-in agent cannot be updated` / `Built-in agent cannot be deleted`）。
- ビルトインは編集できない前提なので、model / Effort も固定（どちらも未指定 = アプリ既定）。変更はチャット単位の Model / Effort ピッカーで行う（[model-effort.md](model-effort.md)）。
- `POST /api/sessions` の `agentId` 省略時はこのビルトインを使うので、ユーザー定義が 0 件でもセッションを作れる。
- GET の応答は同梱の組み込みスキルを `builtinSkills`（`{ name, description }`）でも返す。これは全エージェントで常時有効な **ambient** なスキルで、`skillIds` では外せない（[組み込みスキル](#組み込みスキル)）。エージェント編集のスキル欄はこれをチェック済み・無効の行として出し、外せないことを示す。`/api/skills/files` はサンドボックス未設定で 503 になるため使わず、BFF 起動時に読み込み済みの registry をそのまま載せる。
- 初期状態の `agents` には、ユーザー定義のサンプルとしてずんだもん `agent-zundamon`（`systemPrompt` に語尾の指示、`skillIds` は空）が 1 体入る。`DELETE /api/agents/:id` で削除できる。サンプルは DB を新規作成したときだけ入るため、削除した定義は再起動でも戻らない。

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
  "builtinSkills": [{ "name": "skill-creator", "description": "スキルの作成を依頼されたときに使う" }],
  "agents": [
    {
      "id": "agent-zundamon",
      "name": "ずんだもん",
      "description": "「〜なのだ」「〜のだ」の語尾で話す",
      "systemPrompt": "ずんだもんの口調で話してください。…",
      "skillIds": []
    }
  ],
  "skills": []
}
```

## カタログスキル（設定 → スキル）

エージェントへ割り当てるスキルは `{ name, description, body }`。`body` は会話の system prompt へは常時載せず、モデルが必要時に `read` で読む本文（[セッションへの渡し方](#セッションへの渡し方)）。エージェントを選ぶ前に作れて複数のエージェントで使い回せる点が「役割 / 基本指示」（`systemPrompt`）と違う。初期状態は 0 件で、口調のような常時効かせたい指示はエージェントの `systemPrompt` に置く（サンプルは `agent-zundamon`）。

- 本文のフィールド名は `body` で、UI のラベルも「本文」。エージェント側の `systemPrompt`（UI ラベル「役割 / 基本指示」）とは語を分ける。旧フィールド名 `prompt` は作成 / 更新とも 400（旧形式の互換は持たない）。
- 割り当ては `AgentDef.skillIds`。本文は作成時に `promptSnapshot` へ `<agent_skill name="…">` で固定するが、system prompt へは入れない — 索引（name / description / 仮想パス）だけを `skillsOverride` で渡し、モデルは必要時に `read` で読む（[session-files.md](session-files.md)）。本文の出所は作成時のスナップショットなので、定義を編集・削除してもこのセッションの本文は変わらない。
- 設定 → スキルの一覧は、この編集できるスキルと共通 / 組み込みの読み取り専用スキルを同じリストに並べる。カタログのスキルが 0 件のときは追加行の下にその旨を出す（[ui-layout.md](ui-layout.md#設定の編集フォームエージェント--スキル)）。

```json
{
  "skills": [
    {
      "id": "skill-example",
      "name": "重要度順レビュー",
      "description": "指摘を重要度順に並べ、根拠と修正案を添える",
      "body": "指摘は重要度の高い順に並べてください。…"
    }
  ]
}
```

### セッションへの渡し方

エージェントに割り当てたスキルは、SDK ネイティブのスキルと同じ「索引は常時、本文は必要時 `read`」の形で渡す。件数・本文長の上限が無いため、本文を system prompt へ常時載せない。

- `skillsOverride` へ渡す索引は name / description / location だけ。`location` は実体の無い仮想パス `<root>/.u7agent/agent-skills/<name>/SKILL.md`（`server/src/catalog-skills.ts`）。名前は 1 セグメントに percent encoding してから使うので、`a/b` や `..foo` のような名前でも置き場の外へは出ない。一覧の `relativePath` とチャットの `[skill]` バッジはデコードした元の名前で見せる（`location` / `path` は `read` に渡す encoded のまま）
- モデルの `read` は BFF が横取りし、セッションの `promptSnapshot` にある本文を返す（サンドボックスへ送らない）。`ls` / `find` / `grep` / `bash` からは見えない（組み込みと同じ割り切り）
- 同名のファイル / 組み込みスキルがある行は索引からも落とす（優先順位 `project > user > builtin > catalog` を一覧と一致させる）。カタログ同士の重複は先勝ち
- `read` は `classifySkillRead()` に拾われるため、チャットの assistant バブルに `[skill] <name>` バッジが出る

## ファイルスキル（`.agents/skills`）

共通（`<PI_APP_CWD>/.agents/skills`）とプロジェクト（セッションの cwd 配下の `.agents/skills`）のスキル、およびアプリに同梱した**組み込みスキル**は、エージェントに紐づかない **ambient** なスキルとしてセッションへ注入される。エージェント定義の `skillIds` とは別で、設定画面に出るのは共通分と組み込み分の読み取り専用一覧だけ（編集・削除・割り当ての操作は持たない）。優先順位は `プロジェクト > 共通 > 組み込み` で、同名は注入時に一意化する（ファイルの改名・削除・マージはしない）。発見と合成は `server/src/file-skills.ts`、同梱物は `server/src/builtin-skills.ts` が持つ。

チャット側では `GET /api/sessions/:id/skills` がこの 4 種類（プロジェクト / 共通 / 組み込み / エージェント定義のスキル）を優先順位つきで返し、入力補助の一覧と `/skill:` の展開（送信時に本文を取得）が同じ解決を共有する（[api-sessions.md](api-sessions.md#get-apisessionsidskills)、[persistence.md](persistence.md#スキルの扱い)）。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/skills/files` | 共通スキルと組み込みスキルの一覧（読み取り専用）。サンドボックス未設定は 503、サンドボックス側の失敗は 502 |

```json
{
  "skills": [
    {
      "name": "example",
      "description": "例のスキル",
      "path": "/workspace/.agents/skills/example/SKILL.md",
      "relativePath": ".agents/skills/example/SKILL.md",
      "scope": "user",
      "disableModelInvocation": false,
      "shadowed": [
        {
          "path": "/workspace/.agents/skills/example-2/SKILL.md",
          "relativePath": ".agents/skills/example-2/SKILL.md"
        }
      ],
      "overridden": false
    },
    {
      "name": "skill-creator",
      "description": "スキルの作成を依頼されたときに使う",
      "path": "/workspace/.u7agent/builtin-skills/skill-creator/SKILL.md",
      "relativePath": ".u7agent/builtin-skills/skill-creator/SKILL.md",
      "scope": "builtin",
      "disableModelInvocation": false,
      "shadowed": [],
      "overridden": false,
      "version": "3",
      "body": "---\nname: skill-creator\n---\n..."
    }
  ]
}
```

- 同名のスキルは優先順位（プロジェクト > 共通 > 組み込み、同じスコープ内は発見順）で一意化し、影になったファイルを `shadowed` に入れる。一覧では影になった分を警告として表示する
- 組み込みが同名のユーザースキルに負けた場合は、組み込み側の行を残して `overridden: true` を立てる（一覧では「上書きされています」）。`shadowed` はファイル同士の重複だけに使い、同じ関係を二重に出さない
- 設定 → スキルの一覧は、編集できる catalog のスキルと同じリストに共通分と組み込み分を**読み取り専用スキル**として並べる。再読み込みはこのブロックの見出しに 1 つだけ置く（この API は両方を 1 回で返すため、グループ側に置くと片方だけを更新するように見える）。組み込み行の button は本文ビューを開くだけで、読み上げ名は名前行（名前 / スコープ / 版）に閉じ、説明・パス・警告は button の外のテキストにする（行全体のクリックは `after` の overlay で保つ）
- ファイルスキルの本文は応答に含めない。モデルは `path` を `read` で読み、本文は `read` 時点のファイル内容になる（作成後に編集すればその内容、削除すれば読取り失敗）。組み込みはワークスペースに実体が無いため、`body` / `version` を一覧へ載せる（`body` は SKILL.md の frontmatter 込みの全文）
- `.agents/skills` がまだ無い workspace ではエラーにせず、組み込みだけを返す（サンドボックスの 404 を空の一覧として扱う）。サンドボックス未設定は 503、接続失敗・走査の期限切れ（[sandbox-api.md](sandbox-api.md#get-v1skills)）は 502
- 発見一覧はセッション作成・復元のたびに取り直す。復元は `meta.projectCwd` を起点にするため、プロジェクト登録が外れていても同じスキルが見える
- `disable-model-invocation` のスキルは system prompt の `available_skills` から外れる（本文は `path` を `read` すれば読める）。一覧が fat になる場合はこれで逃がす
- エージェント定義のスキルはファイルスキルと混同させないため、`promptSnapshot` へ `<agent_skill>` タグで本文を固定し、モデルには仮想パス `<root>/.u7agent/agent-skills/<name>/SKILL.md` を索引で渡す。`read` は BFF が横取りしてスナップショットの本文を返す（[session-files.md](session-files.md)）

### 組み込みスキル

- `server/src/builtin-skills/<name>/SKILL.md` をアプリに同梱し、起動時に SDK の `loadSkillsFromDir` で読み込む（frontmatter の検証も SDK に委譲し、同梱物が壊れていれば起動しない）。版は `server/src/builtin-skills.ts` の `VERSIONS` で宣言し、一覧に表示する。SKILL.md を読まなくても置き場所を外さないよう、system prompt にも置き場（プロジェクト所属は作業ディレクトリ配下の `.agents/skills`、未所属は `<root>/.agents/skills`）を明記してある（`server/src/agent.ts` の `appendSystemPrompt`）
- ワークスペースへ実体を作らない（git status を汚さず、アプリ更新で常に最新、改変不可）。`path` は仮想パス `<root>/.u7agent/builtin-skills/<name>/SKILL.md` で、`.u7agent` 配下なのでプロジェクトとしては登録できない。SDK の `sourceInfo.scope` に組み込みが無いため `temporary`（path 扱い）にする
- モデルの `read` は BFF が横取りして同梱の本文を返す（サンドボックスへ送らない）。`ls` / `grep` / `find` / `bash` からは見えない。`PI_AGENT_TOOLS` から `read` を外した構成ではモデルは本文を読めず、一覧表示だけになる
- 仮想パスは実ファイルが無く、`write` / `edit` の書き込み範囲（セッションの作業ディレクトリと `<root>/.agents/skills`）の外なので変更できない（同梱物を変えるにはイメージを更新する）。`read` は常に同梱の本文を返す
- カタログ（`GET /api/agents`）と `skillIds` の対象外（[persistence.md](persistence.md#スキルの扱い)）
- 同梱物を追加するときは `server/src/builtin-skills/<name>/SKILL.md` を足し、`VERSIONS` に版を追加する（Docker は `server/src/` ごとイメージへ入るので Dockerfile の変更は不要）

## エージェント定義のアイコン

エージェント定義には任意の `icon`（webp / png の data URL）を持たせられる。設定 → エージェント で画像を選ぶと、クライアントが 256×256 へ contain で縮小し、webp（返せない環境は png）へ再エンコードしてから `icon` として送る。元画像の形式・大きさは問わず、保存されるのは常にこの 1 経路の結果になる。

- 受理するのは `data:image/webp;base64,` と `data:image/png;base64,` だけ。svg はスクリプトを持ち込めるため受理しない（jpeg / gif も常に再エンコードされるため受理しない）。
- デコード後の生バイトは 16 KiB 以下。超過は 400（`Icon must be at most 16 KiB`）。単体の作成 / 更新は body 上限 64 KiB なので、16 KiB なら `systemPrompt` と同居できる。
- 形式違いと非正規の base64（`AAA` のような端数、再エンコードと一致しない値）は 400。先頭の署名（PNG / `RIFF....WEBP`）までは見るが、最後までデコードできるかは見ない（クライアントが常に再エンコードするため実運用では一致し、表示側は読み込み失敗で `SparkleIcon` に落ちる）。`text()` の trim + slice は通さない（base64 を切ると壊れた画像が保存される）。
- 未指定はキーを省略し、`null` は保存・応答に現れない。更新はキー省略で保持、`icon: null` で解除する（`model` / `thinkingLevel` と同じ規則）。
- セッションはアイコンのスナップショットを持たない（`AgentPayloadInfo` は変更しない）。assistant の表示名は作成時のスナップショット（`SessionPayload.agent.name`）、アイコンは `agentId` からカタログを live 解決する。そのため定義を編集すると、既存セッションの名前は古いままアイコンだけが変わる。
- 表示する場所は 設定一覧 / 設定エディタ / コンポーザー / セッション行 / assistant の吹き出し / firstview。未設定と画像の読み込み失敗は `✦`（`SparkleIcon`）へフォールバックする。

```json
{
  "id": "agent-example",
  "name": "コードレビュー",
  "icon": "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoQABAABUB8JQBOgCHwAP7+4AAAAA=="
}
```

## エージェント定義の Model / Effort

エージェント定義には任意の `model`（`{ provider, id }`）と `thinkingLevel` を持たせられる。それぞれ独立して任意で、片方だけの指定や、Model 未指定で Effort だけの指定もできる。ビルトインの汎用アシスタントはどちらも未指定。

- GET は未指定項目のキーを省略し、`null` は保存・応答に現れない。
- 更新要求はキー省略で保持、`model: null` / `thinkingLevel: null` で指定解除する。
- 作成 / 更新の body はキー省略を未指定として受け付け、追加項目の無い定義もそのまま使える。利用不能なモデル参照も形式が正しければ定義には保持できる（実行時に検証してエラーになる）。
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
      "body": "指摘は重要度の高い順に並べてください。…"
    }
  ]
}
```

## エージェント定義の定型プロンプト

エージェント定義には任意の `suggestions`（`{ label, prompt }` の配列）を持たせられる。空の会話の firstview に `label` のボタンとして並び、押すと `prompt` をそのまま送信する（セッションタイトルの元にもなる）。ビルトインの `agent-general` だけが 3 件を持つ。

- 未指定（空配列を含む）なら GET はキーを省略し、画面にもボタンを出さない（アプリ既定のフォールバックはない）。
- `label` は 60 文字、`prompt` は 500 文字で trim + 切り詰める。どちらかが空の要素は捨てる。
- 先頭から最大 6 件。`prompt` の重複は最初の 1 件だけ残し、重複は 6 件の枠を消費しない。
- 更新要求はキー省略で保持、`suggestions: []` で解除する。
- 作成 / 更新の body はキー省略を未指定として受け付け、追加項目の無い定義もそのまま使える。

```json
{
  "id": "agent-example",
  "name": "コード実装",
  "suggestions": [
    { "label": "プロジェクトを説明して", "prompt": "このプロジェクトの構成を簡単に教えて" }
  ]
}
```

## 入力の正規化

- リクエストボディの形と型は `server/src/schema.ts` の body スキーマで検証する。必須判定と正規化（trim / 上限 / 未知キー）は `server/src/agents.ts` が正で、許容範囲は上記のとおり。
- エージェント名の必須チェックや `model` / `thinkingLevel` の正規化・日本語エラー文言は `agents.ts` 側が持つ。body スキーマを厳格化しないのは、空 body の PATCH を no-op として通し、必須判定をカタログの文言のまま残すため。
