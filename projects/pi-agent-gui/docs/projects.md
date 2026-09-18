# プロジェクトとセッションの作業ディレクトリ

プロジェクトはワークスペース内のディレクトリの登録で、`server/src/projects.ts` の `ProjectStore` がメモリ内に持つ。`cwd` はワークスペース root 相対のパスだけを持つ（絶対パスで保存するとマウント先の変更で壊れる）。root 自身は登録できない（未所属セッションの作業場所と重複するため）。

## 作成と削除

- 作成は「新規ディレクトリ作成（サンドボックスの `POST /v1/dirs`）」と「既存ディレクトリの登録（`GET /v1/files` がディレクトリ以外で失敗する性質で確認）」の両方で、BFF は作業領域のファイルシステムへ直接触らない。同じ `cwd` の二重登録は 409。
- 削除は登録解除と、配下 `projectCwd` を持つ live セッションの停止（実行中は abort）だけを行う。セッション・会話ストア・作業フォルダは残し、購読中の SSE へは所属が外れた `resync` を送る（`session_deleted` は送らない）。ディレクトリも残す。
- `cwd` の正規化は `normalizeWorkspacePath` が担い、絶対パスと `..` は字句的に畳まず拒否する（[sandbox.md](sandbox.md) のパス解決と同じ方針）。

## セッション cwd

セッションの作業ディレクトリは、ワークスペース root 配下の `<root>/.pi-agent-gui/sessions/<id>` に固定される（会話の永続化が有効なとき。設計は [session-files.md](session-files.md)）。
所属プロジェクトは `projectCwd` / `projectName` として会話ストアの meta に保存し、`SessionPayload.cwd` / `SessionSummary.projectId` は root 相対の作業フォルダと、読み取り時に `ProjectStore.findByCwd(projectCwd)` で解決した所属から組み立てる。
所属を後から変える API は無い。SDK セッションへは `createAgentSession({ cwd })` / `SessionManager.inMemory(cwd, ...)` として作業フォルダを渡し、実行時のパス解決の起点にする。

- 未所属セッションも同じ作業フォルダを持ち、root を cwd にはしない。
- プロジェクトのファイルは作業フォルダから見ると親ディレクトリにあるため、エージェントにはシステムプロンプトでプロジェクトの絶対パスを使えることを伝える。
- 会話の永続化が無効（`PI_SESSION_STORE` 未設定・テスト）なときは従来どおりプロジェクトの `cwd`（未所属は root）を使い、ファイルを保存しない。

## 実行時の隔離ではない

プロジェクトは**実行時の隔離ではない**。cwd はツールのパス解決の起点を変えるだけで、サンドボックス内のファイル・ポート・プロセスは全セッションで共有される（bash がある以上、未所属セッションから他プロジェクトのディレクトリも操作できる）。隔離が必要になった時点でコンテナ・データ領域分離として別に設計する。

ツール実行はリクエストごとの `cwd`（root 相対）を受け取り、サンドボックスが root 配下の実在ディレクトリへ解決してから、その実パスごとに生成・キャッシュしたツール定義で実行する（`Map<実パス, definitions>`）。`..` や symlink で root の外へ出る指定は 400。この検証も cwd の起点を決めるだけで、サンドボックスが読める範囲を絞るものではない。

## 関連 API

- `GET /api/files?path=<root 相対>` — 一覧（[api.md](api.md)）
- `POST /api/projects` / `DELETE /api/projects/:id` — 登録と解除（[api.md](api.md)）
- `POST /api/sessions` の `projectId` — セッション作成時の所属（[api-sessions.md](api-sessions.md)）
