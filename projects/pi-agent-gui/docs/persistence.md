# データの永続化と再デプロイ時の挙動

## 現状

BFF とツール実行サンドボックスを別コンテナで動かす構成を対象とする。
サンドボックスの `/workspace` はホストの専用作業領域へ永続マウントし、
GUI の会話履歴は **BFF 専用の会話ストア**（`PI_SESSION_STORE`）へ JSONL で保存する。
会話と作業ディレクトリは同じセッション id で対応し、別の場所に置く。未所属チャットのスクラッチは `<workspace>/.pi-agent-gui/sessions/<id>`、プロジェクト所属セッションは登録ディレクトリそのもの、添付は共通の `<workspace>/.pi-agent-gui/uploads/<id>` を使う（[projects.md](projects.md#セッション-cwd)）。

| データ | 再作成・再デプロイ後 |
|---|---|
| `/workspace` 内のファイル・Gitリポジトリ・worktree | 残る |
| セッションの作業ディレクトリ（未所属チャットのスクラッチ `<workspace>/.pi-agent-gui/sessions/<id>`） | 残る |
| プロジェクト所属セッションの作業ディレクトリ（登録ディレクトリそのもの） | 残る（登録したディレクトリが永続マウント配下なら） |
| 添付ファイル（`<workspace>/.pi-agent-gui/uploads/<id>`） | 残る |
| 会話履歴・セッション一覧・タイトル（`PI_SESSION_STORE/<id>/{meta.json,session.jsonl}`） | 残る（ストアを永続ボリュームに置いた場合） |
| `/workspace` 以外に保存したデータ・後からインストールしたツール | 原則残らない |
| 実行中のプロセス | 中断される |
| プロジェクトの登録 | 消える（メモリ内管理。所属は `projectCwd` から読み取り時に解決する） |

この表は永続マウントを設定したデプロイ環境での挙動を示す。
イメージ単体で起動するだけでは `/workspace` と会話ストアの永続化は保証されない。
単なるコンテナ停止・再開では書き込み層が残る場合があるが、再作成後の保持は保証しない。

## 作業領域

現在の self-hosted-runner 環境では以下を対応させている。

| 場所 | パス |
|---|---|
| サンドボックス内 | `/workspace` |
| ホスト上 | `/home/u7chan/deploy/pi-agent-gui/workspace` |
| 会話ストア（BFF 専用） | BFF コンテナの `PI_SESSION_STORE`（例 `/session-store`）。サンドボックスへはマウントしない |

- BFF には作業領域をマウントしない。ファイル操作・シェル実行はサンドボックス側で行う。
- 会話ストアはサンドボックスと共有しない。共有すると、サンドボックスから symlink を差し替えて BFF のファイルを壊したり読み出したりできてしまう。`PI_SESSION_STORE` が `PI_APP_CWD` の中なら起動時に拒否する。
- Gitリポジトリ本体と worktree は両方 `/workspace` 配下に配置する。外部パスへの参照先は永続化対象にならない。
- 後からインストールするツールも、保存先が `/workspace` 内ならそのファイルは残る。ただし外部の依存ファイル・設定まで復元されるとは限らない。
- 常用するツールはイメージへ組み込み、再作成後も利用できるようにする。
- 永続マウントはバックアップではない。作業ファイルの削除やホスト障害からの復旧は別途備える。

配置・所有権・Compose の正本はデプロイ側で管理する。

- [Compose 定義](https://github.com/u7chan/self-hosted-runner/blob/main/deploy/pi-agent-gui.yml)
- [target 設定](https://github.com/u7chan/self-hosted-runner/blob/main/deploy/targets.json)
- [運用手順](https://github.com/u7chan/self-hosted-runner/blob/main/docs/pi-agent-gui.md)

## 会話履歴の扱い

会話は BFF 専用ストアの `PI_SESSION_STORE/<id>/{meta.json,session.jsonl}` に保存する。
`meta.json` は表示用メタデータ（タイトル / エージェントのスナップショット / 所属プロジェクトの cwd / 使用モデル）を持ち、
`session.jsonl` は pi SDK 形式（header + entries、compaction entry を含む）で、読み書きは BFF の `session-store` が行う。

- 起動時にストアを走査して一覧（descriptor）を復元し、セッションを開いたときに SDK セッションを遅延生成する。表示メッセージ数（`messageCount`）の定義を変えた場合は、古い値のままの meta を開いたときに書き戻すため、開いていないセッションの一覧は古い値を返し続ける（[session-files.md](session-files.md)）。
- アイドル 1 時間の sweep はメモリから外すだけで、ストアと作業ディレクトリ・添付は残る。SSE 購読中のセッションは対象外。
- `DELETE /api/sessions/:id` はストアの履歴だけを消し、作業ディレクトリ（ユーザーのファイル）と添付は残す。
- エージェント / スキルのプロンプトは作成時に `promptSnapshot` として meta に保存し、復元後の実行内容を定義の変更に依存させない（現行の「定義変更を遡及させない」と同じ）。
- モデルは JSONL 最後の `model_change` → meta の `model` → アプリ既定 の順に `PI_MODELS` の候補と照合する（[model-effort.md](model-effort.md)）。候補外ならアプリ既定へフォールバックし、その実効値を `model_change` へ追記して保存する。
- ストアのレイアウト・検証・書込み手順の設計は [session-files.md](session-files.md) を正とする。
- プロジェクト（ワークスペース内ディレクトリの登録。`server/src/projects.ts`）はメモリ内のみで、
  再デプロイ後は未所属チャットに戻る。セッションは `projectCwd` を meta に持ち、
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

## バックアップ（エクスポート / インポート）

再デプロイで消えるメモリ内のデータ（エージェント / スキル定義とプロジェクト）は、設定の「バックアップ」（`client/src/components/BackupPage.tsx`）からファイルへ書き出せる。
保存先がサーバーのディスクにある会話履歴も、バックアップの対象には含む（下表のとおり、現状は準備中）。
エクスポートは画面でチェックした対象を 1 ファイルにまとめ、インポートは**ファイルに入っている対象だけ**を置き換える
（取り込む範囲は画面のチェックではなくファイルの中身で決まる）。

対象は `client/src/lib/backupTargets.ts`、ファイルの封筒と解析は `client/src/lib/backupFile.ts` が持つ。

| 対象（`data` のキー） | 内容 | 保存先 | 現状 |
|---|---|---|---|
| `definitions` | エージェントとスキルの定義 | サーバーのメモリ | 実装済み |
| `projects` | 登録済みの作業ディレクトリ | サーバーのメモリ | 準備中 |
| `sessions` | セッションとメッセージ | サーバーのディスク | 準備中 |
| `appearance` | 選んでいるテーマ | このブラウザ | 準備中 |

```json
{
  "app": "pi-desk",
  "schema": 1,
  "exportedAt": "2026-02-01T12:34:56.789Z",
  "data": { "definitions": { "agents": [], "skills": [] } }
}
```

- 取り込み範囲の正は `data` のキーで、対象を列挙する配列は持たない（キーとの食い違いで対象を消す事故を防ぐ）。
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
