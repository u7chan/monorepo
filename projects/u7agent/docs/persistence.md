# データの永続化と再デプロイ時の挙動

## 現状

BFF とツール実行サンドボックスを別コンテナで動かす構成を対象とする。
サンドボックスの `/workspace` はホストの専用作業領域へ永続マウントし、
GUI の会話履歴は **BFF 専用の会話ストア**（`PI_SESSION_STORE`）へ JSONL で保存する。
会話と作業ディレクトリは同じセッション id で対応し、別の場所に置く。未所属チャットのスクラッチは `<workspace>/.u7agent/sessions/<id>`、プロジェクト所属セッションは登録ディレクトリそのもの、添付は共通の `<workspace>/.u7agent/uploads/<id>` を使う（[projects.md](projects.md#セッション-cwd)）。

| データ | 再作成・再デプロイ後 |
|---|---|
| `/workspace` 内のファイル・Gitリポジトリ・worktree | 残る |
| 共通スキル（`<workspace>/.agents/skills`） | 残る |
| セッションの作業ディレクトリ（未所属チャットのスクラッチ `<workspace>/.u7agent/sessions/<id>`） | 残る |
| プロジェクト所属セッションの作業ディレクトリ（登録ディレクトリそのもの） | 残る（登録したディレクトリが永続マウント配下なら） |
| プロジェクトスキル（`<project>/.agents/skills`） | 残る（登録したディレクトリが永続マウント配下なら） |
| 添付ファイル（`<workspace>/.u7agent/uploads/<id>`） | 残る |
| 会話履歴・セッション一覧・タイトル（`PI_SESSION_STORE/<id>/{meta.json,session.jsonl}`） | 残る（ストアを永続ボリュームに置いた場合） |
| エージェント / スキル定義（アプリデータの SQLite） | 残る（ストアを永続ボリュームに置いた場合） |
| アプリデータの DB（`PI_SESSION_STORE/u7agent.db`） | 残る（ストアを永続ボリュームに置いた場合） |
| `/workspace` 以外に保存したデータ・後からインストールしたツール | 原則残らない |
| 実行中のプロセス | 中断される |
| プロジェクトの登録 | 残る（アプリデータの SQLite。所属は `projectCwd` から読み取り時に解決する） |

この表は永続マウントを設定したデプロイ環境での挙動を示す。
イメージ単体で起動するだけでは `/workspace` と会話ストアの永続化は保証されない。
単なるコンテナ停止・再開では書き込み層が残る場合があるが、再作成後の保持は保証しない。

## 作業領域

現在の self-hosted-runner 環境では以下を対応させている。

| 場所 | パス |
|---|---|
| サンドボックス内 | `/workspace` |
| ホスト上 | `/home/u7chan/deploy/u7agent/workspace` |
| 会話ストア（BFF 専用） | BFF コンテナの `PI_SESSION_STORE`（例 `/session-store`）。サンドボックスへはマウントしない |

- BFF には作業領域をマウントしない。ファイル操作・シェル実行はサンドボックス側で行う。
- 会話ストアはサンドボックスと共有しない。共有すると、サンドボックスから symlink を差し替えて BFF のファイルを壊したり読み出したりできてしまう。`PI_SESSION_STORE` が `PI_APP_CWD` の中なら起動時に拒否する。
- Gitリポジトリ本体と worktree は両方 `/workspace` 配下に配置する。外部パスへの参照先は永続化対象にならない。
- 後からインストールするツールも、保存先が `/workspace` 内ならそのファイルは残る。ただし外部の依存ファイル・設定まで復元されるとは限らない。
- 常用するツールはイメージへ組み込み、再作成後も利用できるようにする。
- 永続マウントはバックアップではない。作業ファイルの削除やホスト障害からの復旧は別途備える。

配置・所有権・Compose の正本はデプロイ側で管理する。

- [Compose 定義](https://github.com/u7chan/self-hosted-runner/blob/main/deploy/u7agent.yml)
- [target 設定](https://github.com/u7chan/self-hosted-runner/blob/main/deploy/targets.json)
- [運用手順](https://github.com/u7chan/self-hosted-runner/blob/main/docs/u7agent.md)

## アプリデータ（SQLite）

プロジェクトの登録、エージェント定義、スキル定義は BFF の SQLite に保存する（`server/src/app-db.ts`）。
会話は従来どおり `session.jsonl` のままで、DB には入れない。

- 置き場所は会話ストアと同じディレクトリの `PI_SESSION_STORE/u7agent.db`。新しい環境変数は増やさない。
- メモリ DB（`:memory:`）になるのは `sessionStoreDir: null` を明示したとき（テスト）だけ。パス解決に失敗したときは DB を使えない状態にし、メモリへは逃がさない。
- テーブルは `projects` / `agents` / `skills` の 3 つ。`skillIds` / `suggestions` / `model` は JSON 列、並び順は作成順（rowid）。
- `PRAGMA user_version` をコード側の定数（`APP_DB_SCHEMA_VERSION`）と照合し、不一致ならアプリ所有のテーブルを DROP → CREATE する。マイグレーションは持たない（開発中は作り直しで進める）。会話は `session.jsonl` なので作り直しでも消えない。
- サンプル定義（ずんだもん 1 体）は DB ファイルを新規作成したときだけ入れる。`user_version` 不一致の作り直しでは入れないため、削除した定義は再起動でも戻らない。
- スキーマ作成 → `user_version` 設定 → seed は同一トランザクション。カタログの一括置換とスキル削除（参照除去を含む）もトランザクションで行い、途中で失敗したら部分適用を残さない。
- `journal_mode=WAL` / `synchronous=NORMAL`。書き込みは BFF の 1 プロセスを前提とし、複数インスタンスは対象外。

### 失敗時の扱い

会話ストアと同じ規約（メモリだけの黙ったフォールバックをしない）。

- 起動は継続し、`GET /api/health` の `appDb` に `{ path, ok, error }` を返す。
- アプリデータを読む API は 503 になる。カタログ（`/api/agents` / `/api/skills`）、プロジェクト（`/api/projects`）、セッションの作成・一覧・取得・設定変更・送信・SSE 接続（所属の解決と `create()` のカタログ参照を通るため）。
- 削除は会話ストアだけで完結するため通す。停止も live なセッションなら通る（未ロードのセッションは復元時に所属を解決するため、DB が使えないと 503 になる）。
- SSE は接続時に 503 で拒否し、配信中の payload 生成で失敗したらその接続を閉じる（未所属へ落として配信を続けない）。
- 起動時だけでなく稼働中の読み書き失敗も同じ扱いにする。失敗状態のときは入口ガードが `SELECT 1` で読み直し、成功すれば解除される（復旧に再起動は要らない）。

## 会話履歴の扱い

会話は BFF 専用ストアの `PI_SESSION_STORE/<id>/{meta.json,session.jsonl}` に保存する。
`meta.json` は表示用メタデータ（タイトル / エージェントのスナップショット / 所属プロジェクトの cwd / 使用モデル）を持ち、
`session.jsonl` は pi SDK 形式（header + entries、compaction entry を含む）で、読み書きは BFF の `session-store` が行う。

- 起動時にストアを走査して一覧（descriptor）を復元し、セッションを開いたときに SDK セッションを遅延生成する。表示メッセージ数（`messageCount`）の定義を変えた場合は、古い値のままの meta を開いたときに書き戻すため、開いていないセッションの一覧は古い値を返し続ける（[session-files.md](session-files.md)）。
- アイドル 1 時間の sweep はメモリから外すだけで、ストアと作業ディレクトリ・添付は残る。SSE 購読中のセッションは対象外。
- `DELETE /api/sessions/:id` はストアの履歴だけを消し、作業ディレクトリ（ユーザーのファイル）と添付は残す。
- エージェント定義のプロンプトとスキル本文は作成時に `promptSnapshot` として meta に保存し、復元後の実行内容を定義の変更に依存させない（現行の「定義変更を遡及させない」と同じ）。agent は system prompt へ入れるが、スキル本文は入れない — 索引（name / description / 仮想パス）だけを `skillsOverride` で渡し、本文は `read` と `/skill:` の展開がこのスナップショットから取り出す。ファイルスキル（`.agents/skills`）は `promptSnapshot` に含めず、復元のたびに再発見する（[スキルの扱い](#スキルの扱い)）。
- モデルは JSONL 最後の `model_change` → meta の `model` → アプリ既定 の順に `PI_MODELS` の候補と照合する（[model-effort.md](model-effort.md)）。候補外ならアプリ既定へフォールバックし、その実効値を `model_change` へ追記して保存する。
- スキル読み込み（`read` で basename が `SKILL.md`）の表示は専用の保存フィールド / カラムを持たず、**pi entry の raw content（`toolCall` part と `toolResult`）を正として毎回再導出**する（`classifySkillRead()`。導出の契約は [api-sessions.md](api-sessions.md#スキル読み込みskillloads--skill)）。この再導出が成立するのは raw content を保存し続ける場合だけで、projected な `ChatMessage` の列（role / text / usage / metrics）だけを保存する設計にすると再導出できず、別途カラムが要る。現行の `session.jsonl`（SDK 形式）は raw content を保つため、BFF 再起動後に復元したセッションでも同じ位置に出る
- ストアのレイアウト・検証・書込み手順の設計は [session-files.md](session-files.md) を正とする。
- プロジェクト（ワークスペース内ディレクトリの登録。`server/src/projects.ts`）はアプリデータの SQLite に保存し、
  再起動後も残る（DB を作り直したときは消える）。セッションは `projectCwd` を meta に持ち、
  復元時はそのディレクトリをそのまま cwd に使う（未登録でもスクラッチへは切り替えない）。
  同じ cwd を再登録すれば一覧の所属が再び解決される（プロジェクトの自動再登録はしない）。
  列は `{ id, name, cwd, createdAt }` の 4 つに保ち、cwd は root 相対で持つ（[projects.md](projects.md)）。

ブラウザのリロード・再接続は、BFF が保持している会話を再取得する動作であり、
DBへの永続化を意味しない。アイドルセッションの破棄条件などは
[run-lifecycle.md](run-lifecycle.md) を参照する。

### compaction entry の保存

`session.jsonl` は pi SDK 形式のまま保存するため、`messages` だけでなく **compaction entry も保存される**。
圧縮で context から外れた元メッセージも entry には残り、区切り位置（`firstKeptEntryId` 以降）も要約も復元できる。
DTO（[api-sessions.md](api-sessions.md) の `compactions`）はそのまま写した形で、
最新の compaction の `beforeMessageIndex` だけは `messages` から導出する。

- `reason` と `estimatedTokensAfter` は `CompactionEntry` には保存されず `compaction_end` にしか無いため、復元後は欠ける（表示は `tokensBefore` だけで成立する）
- `usage` / `fromHook` は entry に含まれるため復元できる

## スキルの扱い

スキルは「エージェント定義のスキル」「ファイルスキル」「組み込みスキル」の 3 種類がある。

| 種類 | 置き場 | 編集 | 再デプロイ後 |
|---|---|---|---|
| エージェント定義 | アプリデータの SQLite（設定 → スキル） | GUI | 残る |
| ファイルスキル（共通） | `<workspace>/.agents/skills` | ファイル（GUI は読み取り専用） | 残る |
| ファイルスキル（プロジェクト） | `<project>/.agents/skills` | ファイル | 残る（永続マウント配下なら） |
| 組み込み | アプリのバンドル `server/src/builtin-skills/`（仮想パス `<workspace>/.u7agent/builtin-skills/...`） | 不可 | イメージ更新で入れ替わる |

- エージェント定義のスキルは作成時に `promptSnapshot` へ `<agent_skill>` で本文を固定し、索引（name / description / 仮想パス `<workspace>/.u7agent/agent-skills/<name>/SKILL.md`）だけを `skillsOverride` で渡す。`read` は BFF が横取りしてこの本文を返す（[session-files.md](session-files.md)、[api-catalog.md](api-catalog.md#セッションへの渡し方)）。
- 初期状態はカタログスキル 0 件で、ユーザー定義エージェントはずんだもん `agent-zundamon` 1 体（`systemPrompt` に語尾の指示）。どちらも通常の定義と同じ扱いで削除・置換ができる。サンプルは DB を新規作成したときだけ入るため、削除した定義は再起動でも戻らない。
- ファイルスキルはエージェントに紐づかない **ambient** なスキルで、セッション作成・復元のたびにサンドボックス（`GET /v1/skills`）で発見し、SDK の `skillsOverride` へ渡す。`promptSnapshot` には保存しない。セッションが持つのは発見一覧・説明・優先順位だけで、復元時は `meta.projectCwd` を起点に取り直す（プロジェクト登録が外れていても同じ）。
- 発見できるのは `SKILL.md` だけ。**本文は保存も固定もしない**ため、モデルが `read` した時点のファイル内容になる（作成後に編集すればその内容、削除すれば読取り失敗）。設定画面とチャットの一覧も同じで、ファイルを変えれば再読み込み後の表示に反映される。どのターンで `read` されたかは JSONL の `toolCall` から導出し、チャットの assistant バブルに `[skill]` バッジとして出す（上記の再導出）。
- 優先順位は `プロジェクト > 共通 > 組み込み`。同名は注入時に一意化し、影になったファイルはログと設定一覧の警告で、上書きされた組み込みは一覧の「上書きされています」で確認する（ファイルの改名・削除・マージはしない）。
- 組み込みスキルはワークスペースに実体を作らず（`read` だけ BFF が同梱の本文を返す）、アプリの更新に追従して常に最新・改変不可。カタログの export / import と `skillIds`、バックアップの `definitions` の対象外（[api-catalog.md](api-catalog.md#組み込みスキル)）。
- チャット側の一覧（`GET /api/sessions/:id/skills`）と `/skill:` の展開は同じ解決（`プロジェクト > 共通 > 組み込み > カタログ`）を共有する。一覧が固定するのは発見一覧・説明・優先順位だけで、**本文は送信時にスコープ別に取り直す**（ファイル → サンドボックスの preview、組み込み → registry、カタログ → `promptSnapshot`）。カタログの本文は `promptSnapshot` から引くため、定義を編集・削除してもこのセッションの `read` / `/skill:` は作成時の内容で動く（[api-sessions.md](api-sessions.md#skill-の展開)）。
- BFF は作業領域をマウントしないため、ファイルスキルの発見にはサンドボックス（`PI_SANDBOX_URL` / `PI_SANDBOX_TOKEN`）が必要。未設定ではセッション作成が 503 になり、設定の一覧も取得できない（発見だけが失敗した場合はスキル無しで続行する。組み込みはこのときも注入される）。

## バックアップ（エクスポート / インポート）

設定の「バックアップ」（`client/src/components/BackupPage.tsx`）は、エージェント / スキル定義とプロジェクトをファイルへ書き出す機能。
定義とプロジェクトはアプリデータの SQLite に残るようになったため、再デプロイ対策としての用途は無くなった。
保存先がサーバーのディスクにある会話履歴も、バックアップの対象には含む（下表のとおり、現状は準備中）。
エクスポートは画面でチェックした対象を 1 ファイルにまとめ、インポートは**ファイルに入っている対象だけ**を置き換える
（取り込む範囲は画面のチェックではなくファイルの中身で決まる）。

対象は `client/src/lib/backupTargets.ts`、ファイルの封筒と解析は `client/src/lib/backupFile.ts` が持つ。

| 対象（`data` のキー） | 内容 | 保存先 | 現状 |
|---|---|---|---|
| `definitions` | エージェント（ユーザー定義）とスキルの定義 | サーバーのメモリ | 実装済み |
| `projects` | 登録済みの作業ディレクトリ | サーバーのメモリ | 準備中 |
| `sessions` | セッションとメッセージ | サーバーのディスク | 準備中 |
| `appearance` | 選んでいるテーマ | このブラウザ | 準備中 |

```json
{
  "app": "u7agent",
  "schema": 1,
  "exportedAt": "2026-02-01T12:34:56.789Z",
  "data": { "definitions": { "agents": [], "skills": [] } }
}
```

- 取り込み範囲の正は `data` のキーで、対象を列挙する配列は持たない（キーとの食い違いで対象を消す事故を防ぐ）。
- ビルトインの汎用エージェント（`agent-general`）はサーバー所有で `definitions` の対象外。書き出しに乗らず、取り込みでも置き換わらない（[api-catalog.md](api-catalog.md)）。
- 旧形式（`agents` / `skills` を直下に持つファイル）は受理しない。運用前で移行対象が無いため、後方互換は持たない。
- 準備中の対象を含むファイルは、1 つも適用せず中止する。一部だけ適用すると、どの対象が入ったかを説明できなくなる。
- 適用前に全対象の形を検証する（封筒の解析 → 対象ごとのペイロード検証 → 適用）。ロールバックはしないため、途中で失敗したときはどこまで適用したかを画面の注記に残す。
- 作業ディレクトリ（`/workspace`）のファイルは永続マウント側にあり、このバックアップの対象外。

## 検証状況（2026-09-12時点）

実環境でサンドボックスの非root実行、`/workspace` への書き込み、
GUI経由のファイル作成・編集・シェル実行を確認済み。
再デプロイ後の作業ファイルの保持も確認済み。2026-09-11 に `/workspace` 内へ作った
検証用ファイルが、通常の再デプロイでコンテナを再作成した後（2026-09-12）も
内容ごと残っていたことを実機で確認した。
Git worktree は同じ永続マウント配下に置くため同様に残るが、worktree の `.git` は
絶対パスを参照するため、マウント先のパスを変えた場合は作り直す。
設定上の期待値と実機検証済みの範囲を混同しないこと。

検証用ファイルは `/workspace/.deploy-verify/` に置き、workspace 直下を検証物で埋めない。
再デプロイ前にテスト用ファイルをここへ作り、再デプロイ後に新しい会話または
サンドボックス内のコマンドで内容を確認する。会話履歴が消えることは失敗条件に含めない。
