# プロジェクトとセッションの作業ディレクトリ

プロジェクトはワークスペース内のディレクトリの登録で、`server/src/projects.ts` の `ProjectStore` がメモリ内に持つ。`cwd` はワークスペース root 相対のパスだけを持つ（絶対パスで保存するとマウント先の変更で壊れる）。root 自身は登録できない（未所属セッションの作業場所と重複するため）。

## 作成と削除

- 作成は「新規ディレクトリ作成（サンドボックスの `POST /v1/dirs`）」と「既存ディレクトリの登録（`GET /v1/files` がディレクトリ以外で失敗する性質で確認）」の両方で、BFF は作業領域のファイルシステムへ直接触らない。同じ `cwd` の二重登録は 409。
- 削除は登録解除だけで、配下セッションを `SessionStore.destroyByProject()` で停止（実行中は abort）・破棄し、ディレクトリは残す。
- `cwd` の正規化は `normalizeWorkspacePath` が担い、絶対パスと `..` は字句的に畳まず拒否する（[sandbox.md](sandbox.md) のパス解決と同じ方針）。

## セッション cwd

セッションの作業ディレクトリは作成時に所属プロジェクトから決まり、SDK セッションへ固定される（`resourceLoader` / `createAgentSession({ cwd })` / `SessionManager.inMemory(cwd)` / `createRemoteToolDefinitions({ cwd })`）。未所属セッションは root（`PI_APP_CWD`）で動く。`SessionPayload.cwd` は root 相対（未所属は `""`）で配り、root の絶対パスは `health.cwd`（表示用）にだけ現れる。所属を後から変える API は無く、SDK セッション側にも作成後に cwd を変える API は無い。

## 実行時の隔離ではない

プロジェクトは**実行時の隔離ではない**。cwd はツールのパス解決の起点を変えるだけで、サンドボックス内のファイル・ポート・プロセスは全セッションで共有される（bash がある以上、未所属セッションから他プロジェクトのディレクトリも操作できる）。隔離が必要になった時点でコンテナ・データ領域分離として別に設計する。

ツール実行はリクエストごとの `cwd`（root 相対）を受け取り、サンドボックスが root 配下の実在ディレクトリへ解決してから、その実パスごとに生成・キャッシュしたツール定義で実行する（`Map<実パス, definitions>`）。`..` や symlink で root の外へ出る指定は 400。この検証も cwd の起点を決めるだけで、サンドボックスが読める範囲を絞るものではない。

## 関連 API

- `GET /api/files?path=<root 相対>` — 一覧（[api.md](api.md)）
- `POST /api/projects` / `DELETE /api/projects/:id` — 登録と解除（[api.md](api.md)）
- `POST /api/sessions` の `projectId` — セッション作成時の所属（[api-sessions.md](api-sessions.md)）
