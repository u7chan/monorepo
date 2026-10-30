# エージェント / スキル API

規約と索引は [api.md](api.md) を参照する。エージェント定義は `server/src/agents.ts` のカタログで、実体はアプリデータの SQLite へ保存し、再起動後も残る（[persistence.md](persistence.md)）。スキルはファイル（`.agents/skills`）と組み込みだけを正とし、GUI で登録する DB カタログは無い。本文中の JSON の `id` は形を示す任意の例で、ビルトインは汎用アシスタント `agent-general`。初期状態はユーザー定義のサンプル `agent-zundamon`（ずんだもん）1 体。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/agents` | ビルトイン + エージェント（ユーザー定義）の一覧（同梱の組み込みスキルを `builtinSkills`、アプリが扱うツールを `tools` で含む） |
| POST | `/api/agents` | エージェント作成 `{ name, description, systemPrompt, commonSkillNames?, builtinSkillNames?, toolNames?, icon?, model?, thinkingLevel?, promptIds? }` |
| PATCH / PUT | `/api/agents/:id` | エージェント更新（キー省略は保持、`icon` / `model` / `thinkingLevel` / `commonSkillNames` / `builtinSkillNames` / `toolNames` の `null` と `promptIds: []` は指定解除。ビルトインは 400） |
| GET | `/api/prompts` | 定型プロンプトのマスタ一覧 `{ prompts }`（使用先 `usedBy` つき、組み込みが先） |
| POST | `/api/prompts` | 自作マスタの作成 `{ label, prompt }`（種別と ID はサーバーが決める） |
| GET | `/api/prompts/:id` | マスタ 1 件 `{ prompt }` |
| PATCH / PUT | `/api/prompts/:id` | 自作マスタの更新（キー省略は保持。組み込みは 400） |
| DELETE | `/api/prompts/:id` | 自作マスタの削除（使用中は 409 + `usedBy`、組み込みは 400、未知は 404） |
| PATCH | `/api/agents/order` | 表示順の保存 `{ ids }`（応答は並べ替え後の `{ agents }`。ビルトインは対象外） |
| DELETE | `/api/agents/:id` | エージェント削除（ビルトインは 400。ユーザー定義は 0 件まで減らせる） |
| GET | `/api/skills/files` | ファイルスキル（`.agents/skills`）と組み込みスキルの一覧 |

## エージェントの表示順

一覧の並びは端末ごとの表示設定（`localStorage`）ではなく、定義のプロパティとしてアプリデータへ保存する。正をサーバーの配列順にすれば、設定一覧・チャットのピッカー・選択の復元が自動で揃い、クライアントに並べ替えの合成ロジックを持ち込まない（[persistence.md](persistence.md#アプリデータsqlite)）。

- GET の `agents` は保存された並び順で返り、UI はそれを表示順に使う。`sortOrder` は app-db の内部に閉じ、`AgentDef` と応答形は変えない。
- ビルトインは先頭固定とし、並べ替えの対象にしない（`ids` に渡しても捨てる）。DB の行を持たず `POST /api/sessions` の既定も兼ねるため、「先頭 = 既定」を保つ。
- `ids` の正規化は「存在しない参照は捨てる」と同じ方針: 採用するのは既存のユーザー定義の id だけで、未知の id・重複・ビルトインは捨て、渡されなかった行は元の相対順で末尾に回す。`[]` と全件未知は現行順のまま。応答は正規化後の一覧で、これが以後の GET と一致する。
- 追加した定義は末尾に付く。更新（PATCH / PUT）では位置を動かさない（名前やアイコンの保存で並びが変わらない）。
- 保存は全件を 1 トランザクションで書き直し、途中で失敗したら 1 つも書かない。件数の上限は body スキーマが持つ。

```json
{ "ids": ["agent-example", "agent-zundamon"] }
```

## ビルトインの汎用エージェント

セッション作成の既定エージェントを保証するため、汎用アシスタント `agent-general` はサーバー所有のビルトインとしてユーザー定義の `agents` に入れない。

- GET の応答は `builtinAgent` を別フィールドで常に返し、`agents` はユーザー定義だけになる（0 件も許す）。
- `PATCH` / `DELETE /api/agents/agent-general` は 400（`Built-in agent cannot be updated` / `Built-in agent cannot be deleted`）。
- ビルトインは編集できない前提なので、model / Effort も固定（どちらも未指定 = アプリ既定）。変更はチャット単位の Model / Effort ピッカーで行う（[model-effort.md](model-effort.md)）。
- `POST /api/sessions` の `agentId` 省略時はこのビルトインを使うので、ユーザー定義が 0 件でもセッションを作れる。
- GET の応答は同梱の組み込みスキルを `builtinSkills`（各件 `{ name, description, version }`）でも返す。これは全エージェントへ注がれる **ambient** なスキルで、既定は全部 ON。外すのはエージェント定義の `builtinSkillNames`（[エージェント定義のスキル許可リスト](#エージェント定義のスキル許可リスト)）。エージェント編集のスキル欄はこれをチェック可能な行として出し、外した分はそのエージェントの会話へ読み込まれない。ビルトインの閲覧ビューは許可リストを持たない（= 常に全部 ON）ので、チェックを出さず共通 / 組み込みを読み取り専用で並べる。`/api/skills/files` はサンドボックス未設定で 503 になるため使わず、BFF 起動時に読み込み済みの registry をそのまま載せる。
- GET の応答はアプリが扱うツールも `tools`（各件 `{ name, description, group, available, reason? }`）で返す。`group` はサンドボックスで動く `sandbox` と BFF ローカルの `app` で、画面のグループ分けに使う。`available` と `reason` は**取得時点のアプリ側の実効**（`PI_AGENT_TOOLS` / コンテンツ生成のキー / Web 検索の実行時トグル / `serve` の実体 / `ask_user` / `investigate`）で、エージェントの許可リストは掛けない（[ツール許可リスト](#ツール許可リスト)）。理由の文言はクライアント側の対応表が持ち、応答にはコードだけを載せる。
- 初期状態の `agents` には、ユーザー定義のサンプルとしてずんだもん `agent-zundamon`（`systemPrompt` に語尾の指示）が 1 体入る。`DELETE /api/agents/:id` で削除できる。サンプルは DB を新規作成したときだけ入るため、削除した定義は再起動でも戻らない。

```json
{
  "builtinAgent": {
    "id": "agent-general",
    "name": "汎用アシスタント",
    "description": "役割や口調を設定していない既定のエージェント",
    "systemPrompt": "",
    "prompts": [
      { "id": "prompt-builtin-project-overview", "kind": "builtin", "label": "プロジェクトを説明して", "prompt": "このプロジェクトの構成を簡単に教えて" }
    ]
  },
  "builtinSkills": [{ "name": "skill-creator", "description": "スキルの作成を依頼されたときに使う", "version": "3" }],
  "tools": [
    { "name": "read", "description": "ファイルの内容を読む（スキル本文の読み込みも含む）", "group": "sandbox", "available": true },
    { "name": "web_search", "description": "Web を検索して上位ページの抜粋を取る", "group": "app", "available": false, "reason": "app_disabled" }
  ],
  "prompts": [{ "id": "prompt-builtin-project-overview", "kind": "builtin", "label": "プロジェクトを説明して", "prompt": "このプロジェクトの構成を簡単に教えて" }],
  "agents": [
    {
      "id": "agent-zundamon",
      "name": "ずんだもん",
      "description": "「〜なのだ」「〜のだ」の語尾で話す",
      "systemPrompt": "ずんだもんの口調で話してください。…"
    }
  ]
}
```

## DB カタログの撤去

GUI で登録するスキル定義と `agents.skillIds` の割り当て（DB カタログ）は撤去済み。スキルの現行定義はファイルスキルと組み込みスキルだけで、同名の現行ファイルがあれば普通のファイルスキルとして使える。

- 旧 `/api/skills` と `/api/skills/:id` の CRUD は無い（新しい API へも転送せず、通常の未対応 API として 404 になる）。`GET /api/agents` はスキル定義の一覧を返さない。
- エージェントの作成 / 更新要求に `skillIds` が来た場合は、無視して成功にせず 400（`skillIds is no longer supported`）で拒否し、共通ファイルへ副作用を持たない。
- スキルのデータはファイルへ書き出さず、旧 ID → name の対応表・割り当て変換・旧カタログの実行互換・専用の移行ロールバックは作らない。旧カタログの本文は履歴の表示にだけ残り、現在の `read` / `/skill:` / 索引には使わない（[api-sessions.md](api-sessions.md#スキル読み込みskillloads--skill)）。
- 古い会話（旧 `agent.skillIds` / `agent.skills` / `promptSnapshot.skills` 入りの meta）は開いて履歴を閲覧でき、開き直して再保存しても旧キーは復活しない（[session-files.md](session-files.md#metajson)）。
- **新しい DB を古いビルドで開く巻き戻しは非対応**（他データも消え得る。[persistence.md](persistence.md#アプリデータsqlite)）。


## ファイルスキル（`.agents/skills`）

共通（`<PI_APP_CWD>/.agents/skills`）とプロジェクト（セッションの cwd 配下の `.agents/skills`）のスキル、およびアプリに同梱した**組み込みスキル**はセッションへ注入される。プロジェクトはエージェントに紐づかない **ambient** なスキルで、共通分は `commonSkillNames`、組み込み分は `builtinSkillNames` でエージェント別に絞れる（[エージェント定義のスキル許可リスト](#エージェント定義のスキル許可リスト)）。設定画面に出るのは共通分と組み込み分で、**共通分だけ** GUI から作成・編集・削除できる（変えられるのは説明と本文だけで、名前は作成時に決まり変更できない。プロジェクト分と組み込みは読み取り専用のまま）。組み込みを上書きしているときの見え方と、どのエージェントで有効かはエージェント編集のスキル欄と、ビルトインの閲覧ビューで見る。優先順位は `プロジェクト > 共通 > 組み込み` で、同名は一意化する。許可リストはこの一意化の**前**に当てるため、外した共通 / 組み込みスキルと同名の下位側（プロジェクト / 共通）は浮上して有効になる（ファイルの改名・削除・マージはしない）。発見と合成は `server/src/file-skills.ts`、同梱物は `server/src/builtin-skills.ts` が持つ。

チャット側では `GET /api/sessions/:id/skills` がこの 3 種類（プロジェクト / 共通 / 組み込み）を優先順位つきで返し、入力補助の一覧と `/skill:` の展開（送信時に本文を取得）が同じ解決を共有する。セッション未確定の `GET /api/skills/session` は同じ解決をセッション作成前に走らせ、新規チャットのピッカーへ同じ形で返す（[api-session-turns.md](api-session-turns.md#get-apisessionsidskills)、[api-session-turns.md](api-session-turns.md#get-apiskillssession)、[persistence.md](persistence.md#スキルの扱い)）。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/skills/files` | 共通スキルと組み込みスキルの一覧。サンドボックス未設定は 503、サンドボックス側の失敗は 502 |
| GET | `/api/skills/files/export` | 共通スキル（`.agents/skills`）の ZIP エクスポート（保存名は `skills.zip`）。`.agents/skills` が無ければ 404、上限超過は 413 |
| GET | `/api/skills/files/export/check` | エクスポートの見積り（`kind` / `name` / `bytes` / `entries` / `skipped`）。download の `check` と同じ形で、UI は 413 の理由を先に出す |
| POST | `/api/skills/files/import` | 共通スキルの ZIP 取り込み（raw body。`?dryRun=true` / `?replace=<名前>` の繰り返し）。構造不正は 400 / 413 で何も書かず、plan / apply で応答の形が違う |
| GET | `/api/skills/files/detail` | 共通スキル 1 件の編集内容（`?relativePath=`）。name / description / 未 trim の body / relativePath / fileVersion / 編集可否と理由 |
| POST | `/api/skills/files` | 共通スキルの新規作成（`{ name, description, body }`）。既存ディレクトリ・同名の共通スキルは 409 |
| PATCH | `/api/skills/files` | 共通スキルの保存（`{ relativePath, fileVersion, description, body }`）。name は受け付けず、版の不一致は 409 |
| GET | `/api/skills/files/delete-preview` | 削除する専用フォルダ・付随ファイル・`treeVersion`（`?relativePath=`）。何も変更しない |
| DELETE | `/api/skills/files` | 専用フォルダを配下ごと削除（`?relativePath=&treeVersion=`）。成功は 204、版の不一致は 409 |

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
- 設定 → スキルの一覧は、共通分と組み込み分を**ファイルスキル**として並べる。「すべて / 組み込み / 共通」のスコープタブと検索を付け、「すべて」では組み込みを先頭にする。行は名前・版・「自動起動なし」・説明（1 行 + `title`）・使用中エージェント数にし、相対パスは詳細へ譲る。**「新しいスキル」の追加行は一覧の固定フッター**に、**インポート / エクスポート / 再読み込みは一覧の頭の帯**（`TabToolbar`）に置き（設定 → モデルと同じ位置）、追加行は**一覧を取得できたときだけ出す**（取得中 / 失敗の理由は一覧側の注記が示す。取得できないまま書き始めても保存で失敗するだけになる）。右ペインの案内も同じで、取得できていない間は「新しいスキル」からの作成を案内しない。行の選択は**一覧の root 相対 `relativePath`** で持ち、変更要求のキーと揃える（名前が同じでも別の行として扱う。上書きされた組み込みは同名の共通行と並ぶ）。読み上げ名は名前行（名前 / スコープ / 版）に閉じ、説明・警告・使用中エージェント数は button の外のテキストにする（行全体のクリックは `after` の overlay で保つ）。**使用中エージェント数**は catalog から client 側で数え、エージェントごとに許可リストを適用した後の実効集合を使う（`undefined` / `null` は全可視、`[]` はなし、同名は共通を優先。ビルトインの汎用アシスタントと既存セッションは対象外）。一覧の `overridden` だけで一律 0 にせず、カタログ未取得のときは 0 と断定せず件数を出さない。正は `client/src/lib/skillUsage.ts`（[ui-layout.md](ui-layout.md#設定の編集フォームエージェント--スキル)）
- 本文ビュー（`FileSkillPanel`）は **本文 / ファイル / 使用中** の 3 タブ + メタの 1 行（置き場 / 更新 / 使用中）で組む。説明はヘッダに置かず**本文タブの先頭に全文**を出し、編集 / 削除は詳細ヘッダの操作にする。最終更新は詳細の `mtime`（SKILL.md の更新時刻）を表示用に整形した目安で、編集内容を取得していない行（組み込みと、まだ詳細を開いていない行）には出さない。保存の競合検出に使う `fileVersion`（SKILL.md のバイト列の SHA-256）は画面に出さない。本文のコピーボタンは表示と同じ生テキストをコピーし、常時表示にする（hover で隠さない）。共通行は編集内容の `body`（frontmatter を除いた本文。閉じ行の改行は境界として含めず、改行は LF）、組み込みとプレビュー経由の行は frontmatter 込みの全文で、`FilePreview` の「本文をコピー」は表示用に正規化した本文（CRLF / CR → LF、末尾の空行を落とす）なので、行の種別ごとに別の契約になる（[file-preview.md](file-preview.md#コピー)）
- ファイルスキルは「本文 / ファイル / 使用中」のタブを持つ。使用中は読み取り専用のエージェント一覧で、ここから割り当ては変えない。ファイルタブは `FileBrowser` を root = SKILL.md の親ディレクトリで置き、`references/` / `scripts/` / `assets/` のファイルをタブ / 行番号 / ハイライト / HTML・Markdown・画像プレビューで開ける（[file-tree.md](file-tree.md#画面と-root)）。ファイルタブではメタ行（置き場）が `display` で隠れるため、ツリーの root を `FileBrowser` の上に caption として出す（パンくずは画面 root 相対なので、root は面ごとのヘッダ側に置く）。ダウンロード / 削除 / リネームの導線は出さない（`FileBrowser` の `readOnly`）が、行の ⋯ にはパスのコピー（相対 / 絶対）だけを残す。出す条件は `scope !== "builtin"` かつ workspace root 相対の `.../SKILL.md` の親が取れることで、判定は `client/src/lib/fileSkills.ts` の `fileSkillDir` が行う（絶対パス（POSIX / ドライブ / UNC）・空・`..` を含むパスは拒否）。組み込みは実体の無い仮想パスなのでタブを出さない
- ファイルタブは初回に開いたときだけ mount し、以降は `display` で隠して保持する（タブと選んだファイルを行き来しても取り直さない）。`filesOpened` は詳細を開いている間だけ持ち、一覧へ戻ると詳細ごと unmount して次の選択で取り直す
- チャットの本文からは、共通スキル配下の絶対パス（`<root>/.agents/skills/<name>/<file>`）をクリックすると**同じ見え方の読み取り専用の面**がチャットの右パネル / sheet に開く（`SkillFilesContent`。[file-tree.md](file-tree.md#面のモード作業フォルダとスキル)）。見た目（root の表示 / ツリー / タブ / 行番号 / ハイライト / HTML・Markdown・画像プレビュー）と `readOnly`（ダウンロード / 削除 / リネームを出さず、パスのコピーだけを残す）はこのファイルタブと同じで、違うのは**一覧（`GET /api/skills/files`）を引かずに root と path だけで開く**点と、作業フォルダ面とモードで往復する点。スキルを作った直後や、一覧に載らない配置（`SKILL.md` 以外）でも開ける。`fileSkillDir` の条件（末尾 `SKILL.md` など）は一覧の `relativePath` から親 root を導くときだけのもので、参照のパスには適用しない（参照の探索は `.agents/skills/` の下を見るだけで、`<name>` の下なら何でも skill dir にする）
- ファイルスキルの本文は一覧の応答に含めない。モデルは `path` を `read` で読み、本文は `read` 時点のファイル内容になる（作成後に編集すればその内容、削除すれば読取り失敗）。設定の本文ビューも同じで、共通行は選択のたびに（同じ行を押し直したときも）`GET /api/skills/files/detail` で `relativePath` を読み直す（この応答の本文が編集フォームの初期値になり、閲覧と保存が同じ取得結果を見る）。共通行以外は `GET /api/files/preview` を使い、2 MiB 超・バイナリ・削除済みはサンドボックスの文言をそのまま出す。組み込みはワークスペースに実体が無いため、`body` / `version` を一覧へ載せ、本文ビューはこの `body` をそのまま出す（`body` は SKILL.md の frontmatter 込みの全文）
- 共通行の編集は名前を表示のみ（新規だけ入力）、説明と本文だけを編集できる。本文は frontmatter の閉じ行の直後から始まるため、本文欄と API の `body` は**閉じ行の改行を除いた**本文で、保存では必ず付け直す（先頭空行を消しても閉じ行と本文を癒着させない。本文中の改行と前後の空白はそのまま扱う）。自動起動の切替（`disable-model-invocation`）と YAML 全文の編集は出さない。新規はフォームの名前から `<root>/.agents/skills/<name>/SKILL.md` を作る（サーバーが組み立て、既存ディレクトリ・同名の共通スキルは 409。上書きも連番化もしない）。編集内容が保存できないファイル（frontmatter が特殊、内容が読込不能）は閲覧だけを許し、理由を本文ビューの注記に出す
- 保存が 409 で止まったときは入力した内容をフォームに残し、`再読み込み` を促す（強制上書き・自動再送は作らない）。削除は専用フォルダと付随ファイルの一覧・`treeVersion` を `delete-preview` で取り直してから確認を出し、取り消したら何も変更しない。成功後は一覧を取り直し、選択を解除する。保存 / 削除の後に対象が切り替わっても、古い本文や成功の通知を別の対象へ混ぜない（取得は対象ごとの世代で無効化する）
- 保存の要求は既存の BFF の上限（64 KiB）のままにする。超過は 413 で拒否し、本文を切り詰めない。この上限を超えるスキルは閲覧だけを許し、編集内容の応答（`editable: false`）とフォームの注記で理由を示す（切り詰めて保存はしない）
- エクスポート / インポート（`export` / `export/check` / `import`）はサンドボックス側で完結させ、BFF は本文と応答を検証して中継するだけにする。`import` は一覧を 2 回引かず、plan はスキルを何も変更せず（受信 ZIP の置き場として `.agents` を作ることはある）、apply は適用した結果を返す（一覧を取り直すのは画面側で、帯の再読み込み 1 つを使う）。詳細な契約と検証は [sandbox-api-skills.md](sandbox-api-skills.md#スキルのエクスポート--インポート) を参照する
- 画面の導線は同じ `.agents/skills` 全体への操作なので、一覧の**頭の帯**（`TabToolbar`。設定 → モデルと同じ形）に**エクスポート**と**インポート**を置く（スクロールする行の外なので、件数が増えても位置が下がらない）。狭い幅で 3 つが入らないときは帯の操作を折り返す（帯は `overflow-hidden` なので、はみ出させると押せない操作ができる）。**ラベルは「持ち出し / 取り込み」ではなく「エクスポート / インポート」にする** — 何が出入りするか (ZIP) をラベルだけで読めるようにし、ダウンロードと同じカタカナ技術語に揃える。エクスポートは除外の指定が無いため確認ダイアログを出さず、`export/check` の見積りだけを見て `<a download>` のプログラム的クリックで始める（`.agents/skills` が無い 404、上限超過 413、0 件は理由を注記へ出す）。インポートは選んだ `File` を保持したまま plan（`dryRun=true`）を 1 回取り、`new` / `identical` / `conflict` / `invalid` を状態と理由つきで並べる専用ダイアログを出す。**置き換えを選べるのは `conflict` だけ**で、既定では 1 つも選ばず、全選択も `conflict` だけを対象にする（`new` は常に取り込み、`identical` は常に書き込まず、`invalid` は常にスキップする）。適用は plan と**同じ `File`** を `replace` つきで送り、`applied` / `skipped` を出してから一覧を取り直し、取り込んだスキルを選択する（選択はダイアログを閉じてから行う）。plan / apply の失敗は理由をそのまま注記へ出し、部分適用の結果は出さず一覧だけ取り直す（巻き戻すのはサーバー）。送信中の二重送信は画面側で止め、適用中はダイアログを閉じさせない（結果と一覧の取り直しを取りこぼさない）。ファイル選択の取消では何もしない。判定と状態遷移は `client/src/lib/skillArchive.ts`、文言は `client/src/lib/fileSkills.ts` が正
- `.agents/skills` がまだ無い workspace ではエラーにせず、組み込みだけを返す（サンドボックスの 404 を空の一覧として扱う）。サンドボックス未設定は 503、接続失敗・走査の期限切れ（[sandbox-api-skills.md](sandbox-api-skills.md#get-v1skills)）は 502
- 発見一覧はセッション作成・復元のたびに取り直す。復元は `meta.projectCwd` を起点にするため、プロジェクト登録が外れていても同じスキルが見える
- `disable-model-invocation` のスキルは system prompt の `available_skills` から外れる（本文は `path` を `read` すれば読める）。一覧が fat になる場合はこれで逃がす。エージェント定義の `allowNaturalInvocation: false` も同じく全スキルを索引から外す（[自然文での発火](#自然文での発火)）

### 組み込みスキル

- `server/src/builtin-skills/<name>/SKILL.md` をアプリに同梱し、起動時に SDK の `loadSkillsFromDir` で読み込む（frontmatter の検証も SDK に委譲し、同梱物が壊れていれば起動しない）。版は `server/src/builtin-skills.ts` の `VERSIONS` で宣言し、一覧に表示する。SKILL.md を読まなくても置き場所を外さないよう、system prompt にも置き場（プロジェクト所属は作業ディレクトリ配下の `.agents/skills`、未所属は `<root>/.agents/skills`）を明記してある（`server/src/agent.ts` の `appendSystemPrompt`）
- ワークスペースへ実体を作らない（git status を汚さず、アプリ更新で常に最新、改変不可）。`path` は仮想パス `<root>/.u7agent/builtin-skills/<name>/SKILL.md` で、`.u7agent` 配下なのでプロジェクトとしては登録できない。SDK の `sourceInfo.scope` に組み込みが無いため `temporary`（path 扱い）にする
- モデルの `read` は BFF が横取りして同梱の本文を返す（サンドボックスへ送らない）。`ls` / `grep` / `find` / `bash` からは見えない。`PI_AGENT_TOOLS` から `read` を外した構成ではモデルは本文を読めず、一覧表示だけになる（エージェント定義の `toolNames` でも同じく外せる。[ツール許可リスト](#ツール許可リスト)）
- 仮想パスは実ファイルが無く、`write` / `edit` の書き込み範囲（セッションの作業ディレクトリと `<root>/.agents/skills`）の外なので変更できない（同梱物を変えるにはイメージを更新する）。`read` は常に同梱の本文を返す
- カタログ（`GET /api/agents`）の対象外。ビルトインの汎用アシスタントは `allowNaturalInvocation` が `false` 固定で、自然文では発火しない（[自然文での発火](#自然文での発火)）。エージェント別の ON / OFF は `builtinSkillNames`（[エージェント定義のスキル許可リスト](#エージェント定義のスキル許可リスト)）で行い、外した組み込みは一覧（`GET /api/sessions/:id/skills`）・`skillsOverride` の索引・`read` の横取り・system prompt の案内（`appendSystemPrompt` の `serve` / `skill-creator` への言及）・`serve` ツールの説明（`createServeToolDefinitions` の skill 参照）のすべてから消える。同名のファイルスキルがあるときはファイル側が浮上し、`overridden` の行も出なくなる
- 同梱物を追加するときは `server/src/builtin-skills/<name>/SKILL.md` を足し、`VERSIONS` に版を追加する（Docker は `server/src/` ごとイメージへ入るので Dockerfile の変更は不要）
- 同梱しているスキルの名前と版は `server/src/builtin-skills.ts` の `VERSIONS`、本文と使い方は各 `SKILL.md` が正（設定 → スキルにも出る）。`serve` は `serve` ツールと同じ経路を使い、起動に成功したコマンドがその作業ディレクトリの実績として記録される（[sandbox.md](sandbox.md#serveサービスの公開と起動停止)）。**自己検証は `debug_start` で 127.0.0.1 の 18000 帯を使い、ユーザーへ見せるときだけ `start` で 8080 に出す**（デバッグ起動は実績へ記録されない）。`browser` はヘッドレスブラウザでの確認と撮影を担い、デバッグ用 serve のポートを `127.0.0.1` で開く（[browser.md](browser.md)）。起動の作法を `appendSystemPrompt` に書かないのは、契約の正をスキル側の 1 箇所に保つため。環境変数の種別ごとの注入先も同じ理由で、要約だけを `serve` ツールの guideline に短く置き、契約の正はスキルに保つ

## エージェント定義のアイコン

エージェント定義には任意の `icon`（webp / png の data URL）を持たせられる。設定 → エージェント で画像を選ぶと、クライアントが 256×256 へ contain で縮小し、webp（返せない環境は png）へ再エンコードしてから `icon` として送る。元画像の形式・大きさは問わず、保存されるのは常にこの 1 経路の結果になる。

- 受理するのは `data:image/webp;base64,` と `data:image/png;base64,` だけ。svg はスクリプトを持ち込めるため受理しない（jpeg / gif も常に再エンコードされるため受理しない）。
- デコード後の生バイトは 16 KiB 以下。超過は 400（`Icon must be at most 16 KiB`）。単体の作成 / 更新は body 上限 64 KiB なので、16 KiB なら `systemPrompt` と同居できる。
- 形式違いと非正規の base64（`AAA` のような端数、再エンコードと一致しない値）は 400。先頭の署名（PNG / `RIFF....WEBP`）までは見るが、最後までデコードできるかは見ない（クライアントが常に再エンコードするため実運用では一致し、表示側は読み込み失敗で `SparkleIcon` に落ちる）。`text()` の trim + slice は通さない（base64 を切ると壊れた画像が保存される）。
- 未指定はキーを省略し、`null` は保存・応答に現れない。更新はキー省略で保持、`icon: null` で解除する（`model` / `thinkingLevel` と同じ規則）。
- セッションはアイコンのスナップショットを持たない（`AgentPayloadInfo` は変更しない）。assistant の表示名は作成時のスナップショット（`SessionPayload.agent.name`）、アイコンは `agentId` からカタログを live 解決する。そのため定義を編集すると、既存セッションの名前は古いままアイコンだけが変わる。
- 表示する場所は 設定一覧 / 設定エディタ / コンポーザー / エージェント選択のリスト / セッション行 / assistant の吹き出し / firstview。未設定と画像の読み込み失敗は星のマーク（`SparkleIcon`）へフォールバックする。

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
- 作成の body はキー省略を未指定として受け付け、追加項目の無い定義もそのまま使える。利用不能なモデル参照も形式が正しければ定義には保持できる（実行時に検証してエラーになる）。
- 不正な `ModelRef` や未知の `thinkingLevel` は 400。

```json
{
  "agents": [
    {
      "id": "agent-example",
      "name": "コードレビュー",
      "description": "バグや保守性の問題を重要度順にレビューする",
      "systemPrompt": "…",
      "model": { "provider": "<provider>", "id": "<id>" },
      "thinkingLevel": "high"
    }
  ]
}
```

## 定型プロンプトのマスタと参照

空の会話に出す定型文は、エージェントから独立したアプリ共通のマスタ（`prompts`）として持つ。エージェントはマスタを順序付きの `promptIds` で参照し、応答では解決済みの `prompts`（`{ id, kind, label, prompt }` の配列）として載る。空の会話の firstview に `label` のボタンとして並び、押すと入力欄のチップになり、送信時に本文と結合される（セッションタイトルの元は結合前の本文）。

- マスタの種別は `builtin` と `custom`。組み込みは閲覧・参照のみで、編集・削除は 400。同じ本文を使いたいときは自作として登録する。
- `GET /api/agents` の `prompts` は選択肢（全マスタ）で、`agents[].prompts` は各エージェントが参照している解決済みの値。どちらも並びはサーバーが決め、表示の同一性は `id`（同じ本文の別マスタを本文でまとめない）。
- エージェントの作成・更新は `promptIds` を受け、**未指定は現状維持、`[]` は全解除**。未知・重複・上限超過は保存の前に 400 で断り、部分保存しない。新しい自作エージェントへ組み込みを自動では足さない。
- 旧 `suggestions` の書き込みは 400（`suggestions is no longer supported; use promptIds`）。黙って捨てて保存成功と誤認させない。
- マスタは `label` / `prompt` を trim して保存し、上限はそれぞれ 60 / 500 文字（超過は切らずに 400）。**作成は両項目が必須**で、未指定・空文字は保存前に 400（更新は省略した項目を現在値のまま保つ）。一意制約は付けず、同文の別マスタを持てる。マスタ全体の件数に上限は掛けず、エージェント 1 体の参照上限だけを DB と API の両方で守る。
- 使用中の削除は 409 で、応答の `usedBy`（`{ agentId, agentName, builtin }`）に使用先を返す。データは変更しない。エージェントを削除してもマスタは残り、参照だけが外部キーの `ON DELETE CASCADE` で消える。
- 組み込みの汎用アシスタントは固定 ID の 3 件をコード上の一覧から参照する（`agent_prompts` の行は持たず、外部キーは弱めない）。この参照は変更できず、`usedBy` では `builtin: true` として出る。

```json
{
  "id": "agent-example",
  "name": "コード実装",
  "promptIds": ["prompt-builtin-project-overview", "prompt-example-custom"]
}
```

## エージェント定義のスキル許可リスト

エージェント定義には任意の `commonSkillNames`（共通スキル）と `builtinSkillNames`（組み込みスキル）を持たせられる。どちらも対象スコープの `name` の配列で、対象は名前のとおり `<PI_APP_CWD>/.agents/skills` の共通分とアプリ同梱の組み込み分だけ。プロジェクトのスキルは絞れない。名前の正は一覧の `name`（`SKILL.md` の frontmatter `name`）で、ディレクトリ名ではない。

- 未指定（キーなし）は既定（共通 = 全可視、組み込み = 全部 ON）、`[]` はすべて OFF。この 2 つは混同しない（保存の NULL と `"[]"` に対応する。[persistence.md](persistence.md#スキルの扱い)）
- 更新要求はキー省略で保持、`null` で解除（未指定へ戻す）。`[]` は「すべて OFF」への上書きで、解除ではない。
- GET は未指定のときキーを省略し、`[]` はそのまま返す。
- 上限は 200 件 / 1 件 200 文字。trim / 空文字の除去 / 重複排除は保存時に行い、非配列と上限超過は 400。1 件の長さはワークスペースの 1 セグメント名の上限（`server/src/sandbox/protocol.ts` の `SANDBOX_MAX_ENTRY_NAME_LENGTH`）と揃える。
- 実在しない名前も保存できる（BFF はワークスペースを見られないため、組み込みも同梱の registry 以外の存在検証はしない）。実行時は無視され、一覧にも出ない（スキル欄は「見つかりません」として出す）。`SKILL.md` の frontmatter `name` を改名すると保存済みリストは古いままになり、同梱物が入れ替わったときも保存した名前は残る（ディレクトリ名では追えない）。
- セッションは作成時のスナップショットで動き、定義の編集は既存セッションへ遡及しない（[api-session-turns.md](api-session-turns.md#get-apisessionsidskills)）。

許可リストは一意化の前に当てるため、外した共通 / 組み込みスキルと同名の下位側（プロジェクト / 共通）が浮上して有効になる。明示リストにした後に増えた共通 / 組み込みスキルは自動では有効にならない（`builtinSkillNames: []` はアプリ更新で同梱物が増えても 0 件のままで、検証用のエージェントを作れる）。

```json
{
  "id": "agent-example",
  "name": "コードレビュー",
  "commonSkillNames": ["writer"],
  "builtinSkillNames": ["skill-creator"]
}
```

## 自然文での発火

エージェント定義には任意の `allowNaturalInvocation`（真偽値）を持たせられる。未指定 / `true` = 自然文でも発火する（既定）、`false` = そのセッションで解決する全スキル（プロジェクト / 共通 / 組み込み）を `/skill:` とスキルボタンからのみ起動する。

- `false` のときは、解決した全スキルを SDK の `disableModelInvocation` として扱い、system prompt の `available_skills` から外す。索引から外れるだけで、本文と `/skill:` の展開・スキルピッカーは残る（[ファイルスキル](#ファイルスキルagentsskills) の `disable-model-invocation` と同じ）。ファイル側の `disable-model-invocation` とは OR で、`false` で発火に戻すことはできない
- ビルトインの汎用アシスタントはサーバー定義で `false` 固定。閲覧ビューはスイッチを OFF・読み取り専用で出し、`builtinSkillNames` の有無に依らず自然文では発火しない（古いスナップショットに値が無くても id で倒す）
- セッションは作成時のスナップショット（`meta.agent.allowNaturalInvocation`）で動き、定義の編集は既存セッションへ遡及しない。`false` のときだけキーを載せる
- エージェント編集のスキルタブは起動モードの行を置き、`自然文でも発火` のスイッチで編集する（OFF は `手動のみ` のチップ）。ビルトインの閲覧ビューは同じ行を操作できない状態で出す（[ui-layout.md](ui-layout.md#設定の編集フォームエージェント--スキル)）

```json
{
  "id": "agent-example",
  "name": "検証用エージェント",
  "allowNaturalInvocation": false
}
```

## ツール許可リスト

エージェント定義には任意の `toolNames`（ツール名の配列）を持たせられる。対象は `GET /api/agents` の `tools` に載る全件で、サンドボックスで実行する作業ツール（`group: "sandbox"`）と、BFF ローカルのアプリのツール（`group: "app"`）に分かれる。どの名前があるかの正は応答の `tools` で、サンドボックスの提供リストと作業ツールの名前は揃えてある。

- 未指定（キーなし）と `null` はどちらも全部 ON、`[]` はすべて OFF。この 2 つは混同しない（保存の NULL と `"[]"` に対応する。[persistence.md](persistence.md#アプリデータsqlite)）
- 更新要求はキー省略で保持、`null` で解除（未指定へ戻す）。`[]` は「すべて OFF」への上書きで、解除ではない。
- GET は未指定のときキーを省略し、`[]` はそのまま返す。
- 上限は 200 件 / 1 件 200 文字で、trim / 空文字の除去 / 重複排除は保存時に行い、非配列と上限超過は 400。上限はスキル名とは別の定数（ツール名はワークスペースの名前に縛られないため、同じ根拠を使い回さない）。
- 実在しない名前も保存できる（一覧の入れ替えで保存値を書き換えない）。実行時は無視され、エージェント編集のツール欄は「見つかりません」として出す。
- **実効はアプリ側の可否との積**で、どちらかが OFF なら OFF。アプリ側には `PI_AGENT_TOOLS`（デプロイ側の上限）、コンテンツ生成のキーと有効 / 無効、Web 検索の実行時トグル、`serve` / `ask_user` / `investigate` の実体の有無が入る。`available: false` の行はチェックが入っていても使えず、理由（`deploy_allowlist` / `app_disabled` / `no_key`）を画面の行に出す。`generate_image` / `generate_speech` / `generate_bgm` は**キーの行が無いときだけ `no_key`** で、行があって設定で OFF なら `app_disabled` になる（キーの再登録を促さない）。
- `generate_bgm` も画像・TTSと同じ共有キーのゲートを使うBFFローカルツール。`toolNames` の積を登録名・定義・カタログに揃え、調査子やremoteツールには公開しない（[bgm-generation.md](bgm-generation.md)）。
- セッションは作成時の値をスナップショットとして持ち、復元はそれを使う（[api-session-turns.md](api-session-turns.md#get-apisessionsidskills) と同じ規則）。定義を編集しても既存の会話の振る舞いは変わらない。子セッション（`investigate`）へは親の許可リストを読み取り専用の集合との積で引き継ぐ（[subagent.md](subagent.md)）。

```json
{
  "id": "agent-example",
  "name": "読み取り専用レビュアー",
  "toolNames": ["read", "grep", "find"]
}
```

## 入力の正規化

- リクエストボディの形と型は `server/src/schema.ts` の body スキーマで検証する。必須判定と正規化（trim / 上限 / 未知キー）は `server/src/agents.ts` が正で、許容範囲は上記のとおり。
- エージェント名の必須チェックや `model` / `thinkingLevel` の正規化・日本語エラー文言は `agents.ts` 側が持つ。body スキーマを厳格化しないのは、空 body の PATCH を no-op として通し、必須判定をカタログの文言のまま残すため。
