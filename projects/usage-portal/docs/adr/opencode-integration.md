# OpenCode Go との連携（アカウント・契約エラー・再取得）

- Status: accepted
- Date: 2026-11-23

## 背景

OpenCode Go の利用枠を取るには API キーが要る。v1 は `OPENCODE_API_KEY` を `.env` からしか渡せず、
キーの変更や再発行のたびにコンテナを作り直す必要があった。複数アカウントを使い分ける利用者もおり、
切り替えのたびにキーを入れ直さず、アカウントごとの利用枠を同時に見たい。契約が無いアカウントでは
上流が 403 を返すが、これをキー無効と同じ扱いにすると、直らない操作へ案内してしまう。

Codex は Portal 専用の `CREDENTIAL_DIR` に `auth.json` を置き、Web UI のサインインで完結させている。
OpenCode Go だけ `.env` に残すと、秘密の出所が 2 つになる。

## 決定

### 保存

- `CREDENTIAL_DIR/opencode-accounts.json` をアカウントの正とする。ディレクトリは 0700、ファイルは 0600。
  一時ファイルへ書いてから rename し、書き込み途中の JSON を sampler が読まないようにする。

  ```json
  { "version": 1, "accounts": [{ "id": "<uuid>", "name": "メイン", "icon": "🦊", "apiKey": "<key>", "savedAt": 0 }] }
  ```

- 配列順が画面の表示順。`id` は `crypto.randomUUID()`。キー・名前・アイコンを 1 ファイルにまとめ、キーは DB に置かない。
- 壊れた JSON・未知の version は 0 件として扱う。ログは固定文言だけで、内容は出さない。
- 旧 `opencode-key.json` は読まないし消さない。デプロイ後に画面から登録し直し、旧ファイルは手動で削除する。
- 入力は名前（trim 後 1〜40 コードポイント、制御文字を拒否、重複可）、アイコン（絵文字 12 種のプリセット）、
  API キー（trim 後 1〜512 文字、空白・制御文字を拒否）。上限は 10 アカウント。規則は
  `src/shared/opencode-account.ts` に置き、server と client で同じ関数を使う。
- `OPENCODE_API_KEY` はコードから削除する。後方互換のフォールバックや自動移行は持たない。

### source id と API

- DB の `provider` 列には `opencode-go:<account uuid>` を入れる。テーブル定義と `user_version` は変えない。
- sampler の fetchers は「毎回評価する関数」にする。`UsageFetcher = { sourceId, provider, fetch }` とし、
  1 回の取得で 1 回だけ評価する。アカウントの追加・削除は再起動なしで次の取得から反映する。
- `/api/usage` の `sources[]` は `id`（`codex` または uuid）/ `provider` / `name` / `plan` / `account`
  （`{ id, name, icon }`、Codex は null）を持ち、並びは Codex → `accounts` の配列順。アカウントが 0 件でも
  Codex の行は返す。`plan` はアカウントで常に null。

| Method | Path                         | 内容                                            |
| ------ | ---------------------------- | ----------------------------------------------- |
| GET    | `/api/opencode/accounts`     | `{ accounts: [{ id, name, icon, savedAt }] }`   |
| POST   | `/api/opencode/accounts`     | `{ name, icon, apiKey }` → 201 `{ account }`    |
| PUT    | `/api/opencode/accounts/:id` | `{ name?, icon?, apiKey? }` → 200 `{ account }` |
| DELETE | `/api/opencode/accounts/:id` | 204                                             |
| POST   | `/api/opencode/accounts/:id/refresh` | 利用枠だけを取り直す                     |
| POST   | `/api/opencode/accounts/:id/check`   | 接続確認（最小プロンプトの送信）         |

- すべて PIN セッション必須。GET 以外は同一 `Origin` 必須、`Cache-Control: no-store`、body は 1 KiB まで。
- エラーは `invalid_name` / `invalid_icon` / `invalid_key` / `invalid_request`（400）、`not_found`（404）、
  `limit_reached`（409）、`unavailable`（503）。キーの値も末尾も応答・ログ・DB に出さない。
- PUT は部分更新。どれも無ければ `invalid_request`、`apiKey` が含まれて trim 後に空なら `invalid_key`。
  検証はすべて書き込みの前に行い、検証に落ちたら名前もアイコンも反映しない。
- API キーの検証（上流の usage endpoint を 1 回）だけは排他区間の外で行う。401 は `invalid_key`、
  403 は `subscription_required`、通信失敗・schema 不一致は `unavailable` として保存しない。
  検証で得た snapshot は、キーの保存と同じ排他区間で書く。
- 作成・更新・削除は sampler の排他区間で行い、区間の内側で配列を読み直して上限判定と存在確認をやり直す。
  DB の更新に失敗したらファイルを操作前へ戻して 503。変更後は sampler が 1 回走る。
- 変更本体の保存に成功した後の再取得が失敗しても、登録・解除の失敗（5xx）にはしない。後続の取得はタイマーで再試行する。
- 1 つの provider の保存に失敗しても、他の provider の取得が終わるまで待ってから失敗を返す。

### 契約エラーと再開

- 401 は `config`（キー無効）、403 は `subscription_required` として分ける。DB schema は変えない。
  分類は HTTP status だけで行い、上流の本文は読まない。
- 最後の取得エラーが `subscription_required` の source は「停止中」とみなし、通常の取得間隔では起こさない。
  失敗時刻から 6 時間後に 1 回だけ自動で再確認する。再確認が契約エラー以外で失敗したら、通常の間隔へ戻す。
- 停止中でも、明示的な再取得は予定を無視して走らせる。入口は「利用枠を取得し直す」（refresh）と
  接続確認（check、送信が上流に届いたら利用枠も取り直す）。取得に失敗したら `{ ok: false }` を返し、
  画面は成功として扱わない。
- 再取得に成功したら error が消え、次の取得から通常の間隔へ戻る。取得間隔の変更（`reschedule`）や
  アカウント変更後の再取得は、停止中の source を前倒ししない。
- 停止の判定は保存済みの error（`provider_error`）だけで決める。別のフラグを保存しない。成功で error が消えれば
  自動的に再開する。

## 採用しない案

- `.env` を残して画面の登録を上書きにする: 秘密の出所が 2 つになり、「画面で消したのに取得できている」状態が起きる。
- キーを SQLite（`DATA_DIR`）に置く: `data/` は履歴のバックアップ対象で、秘密を混ぜたくない。
- 保存時に検証しない: 誤ったキーが「取得エラー」として残り、原因が画面から分からない。
- 末尾 4 桁のマスク表示: どのキーかを確かめるには足りず、画面に秘密の一部を出す理由にもならない。
- 別テーブル（`opencode_account`）を作る: テーブル定義と `user_version` を変える必要があり、既存の読み書きが 2 系統になる。
- アイコン画像のアップロード: 保存・配信・権限の面が増える。12 種のプリセットで識別には足りる。
- アカウント間の合算やグループ化: アカウントはそれぞれ別の契約で、合算した数字に行動の意味が無い。
- 旧 `opencode-key.json` の自動移行: 移行先の名前とアイコンが決まらず、1 アカウントだけ特別扱いすることになる。
- 403 も `invalid_key` のまま: 契約切れでキーの再登録を促し、直らない操作へ誘導する。
- 403 の本文 `error.type` を見て分類: エラー応答の本文を読まない方針で、status で分けられる。
- 停止中の source を永久にスキップする: 上流の一時的な誤判定で二度と戻らない。
- 停止フラグを別テーブルに保存する: error とフラグの 2 つが食い違う状態を作らない。
- 復活を接続確認だけにする: probe の設定が無いアカウントは再開できない。

## 影響

- `/app/credentials` に `opencode-accounts.json` が増える。バックアップやログに出さない。旧 `opencode-key.json` は
  登録後に手動で削除する。
- 上流アクセスは「間隔 × アカウント数」（上限 10）。レート制限が厳しければ間隔を延ばすか上限を下げる。
- アカウントの削除は snapshot・error に加えて sample も消す。同じ uuid で作り直したときに履歴が混ざらないようにする。
- アカウントの失敗は他へ波及させない。ログは provider と source id を区別し、キーも名前も出さない。
- 上流の usage endpoint は公開契約ではない。アカウント追加ごとに 1 回検証するため、障害中は追加できない。
- 停止中は sample が増えないため、再開後の推移には穴が空く。
