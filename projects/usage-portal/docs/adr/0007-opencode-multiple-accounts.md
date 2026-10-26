# ADR 0007: OpenCode Go のアカウントを複数登録する

- Status: accepted
- Date: 2026-10-26

## 背景

OpenCode Go を複数のアカウントで使い分けているが、v1 は API キーを 1 つしか持てない
（[0006](0006-opencode-api-key-registration.md)）。切り替えのたびにキーを入れ直す必要があり、
複数アカウントの利用枠を同時に見られない。アカウントごとに名前とアイコンを付け、1 アカウント = 1 カードで並べたい。

`docs/design.md` の Constraints「1 アカウントずつを対象とする（Codex 1、OpenCode Go 1）」と、
非目的「複数アカウントの集約」はこの ADR が置き換える。`docs/design.md` は親 checkout の写しのため更新しない。

## 決定

### 保存

- `CREDENTIAL_DIR/opencode-accounts.json` をアカウントの正とする。ディレクトリは 0700、ファイルは 0600。
  一時ファイルへ書いてから rename し、書き込み途中の JSON を sampler が読まないようにする。

  ```json
  { "version": 1, "accounts": [{ "id": "<uuid>", "name": "メイン", "icon": "🦊", "apiKey": "<key>", "savedAt": 0 }] }
  ```

- 配列順が画面の表示順。`id` は `crypto.randomUUID()`。
- キー・名前・アイコンを 1 ファイルにまとめ、アカウントの正を 1 か所にする。キーは DB に置かない。
- 壊れた JSON・未知の version は 0 件として扱う。ログは固定文言だけで、内容は出さない。
- 旧 `opencode-key.json` は読まないし消さない。デプロイ後に画面から登録し直し、旧ファイルは手動で削除する
  （キーが残るため README に明記する）。
- 入力は名前（trim 後 1〜40 コードポイント、制御文字を拒否、重複可）、アイコン（絵文字 12 種のプリセット）、
  API キー（trim 後 1〜512 文字、空白・制御文字を拒否）。上限は 10 アカウント。
  規則は `src/shared/opencode-account.ts` に置き、server と client で同じ関数を使う。

### 保存先の識別子

- DB のテーブル定義と `user_version` は変えない。既存の `provider` 列に **source id** を入れる。
  - Codex: `codex`
  - OpenCode Go: `opencode-go:<account uuid>`
- DB の関数は provider id ではなく source id（`string`）を受ける。snapshot JSON の中の
  `ProviderSnapshot.provider` は provider id（`opencode-go`）のまま。列のキーだけが source id になる。
  この対応は `db.ts` のコメントに残す。
- 起動時に `provider = 'opencode-go'` の旧行を消す（単一キー時代の履歴）。Codex の行は残す。
  さらに `opencode-go:` で始まる行のうち、アカウント一覧に無い source id の行も消す。
  削除と DB 消去の間でプロセスが落ちた場合の回収で、失敗しても起動は止めない。
- アカウントの削除では snapshot・error に加えて sample も消す。同じ uuid で作り直したときに前の履歴が混ざらない
  ようにするため。Codex のサインアウトも同じ関数を通るので、Codex の sample も消える。

### 取得

- sampler の fetchers を「毎回評価する関数」にする。`UsageFetcher = { sourceId, provider, fetch }` とし、
  1 回の取得で 1 回だけ評価する。アカウントの追加・削除は再起動なしで次の取得から反映する。
- アカウントの失敗は他へ波及させない（既存の `Promise.allSettled` を維持）。ログは provider と source id を
  区別し、キーも名前も出さない。
- `/api/usage` の `providers[]` を `sources[]` に変える。`id`（`codex` または uuid）/ `provider` / `name` / `plan` /
  `account`（`{ id, name, icon }`、Codex は null）を持ち、並びは Codex → `accounts` の配列順。
  アカウントが 0 件でも Codex の行は返す。`name` は Codex が snapshot 由来、アカウントが登録名。`plan` は
  アカウントで常に null。

### API

すべて PIN セッション必須。GET 以外は同一 `Origin` 必須、`Cache-Control: no-store`、body は 1 KiB まで。

| Method | Path | 内容 |
| --- | --- | --- |
| GET | `/api/opencode/accounts` | `{ accounts: [{ id, name, icon, savedAt }] }` |
| POST | `/api/opencode/accounts` | `{ name, icon, apiKey }` → 201 `{ account }` |
| PUT | `/api/opencode/accounts/:id` | `{ name?, icon?, apiKey? }` → 200 `{ account }` |
| DELETE | `/api/opencode/accounts/:id` | 204 |

- エラーは `invalid_name` / `invalid_icon` / `invalid_key` / `invalid_request`（400）、`not_found`（404）、
  `limit_reached`（409）、`unavailable`（503）。キーの値も末尾も応答・ログ・DB に出さない。
- PUT は部分更新。どれも無ければ `invalid_request`、`apiKey` が含まれて trim 後に空なら `invalid_key`。
  未変更のときクライアントは `apiKey` を送らない。
- 検証はすべて書き込みの前に行う。検証に落ちたら名前もアイコンも反映しない。
- API キーの検証（上流の usage endpoint を 1 回）だけは排他区間の外で行う。401 / 403 は `invalid_key`、
  通信失敗・schema 不一致は `unavailable` として保存しない。
- 作成・更新・削除は sampler の排他区間で行い、区間の内側で配列を読み直して上限判定と存在確認をやり直す。
  検証待ちの間に他が消したアカウントを、古い snapshot で復活させない。
- DB の更新に失敗したらファイルを操作前へ戻して 503。変更後は sampler が 1 回走る。
- 旧 `/api/opencode/auth` と `/api/opencode/key` は削除する。後方互換は持たない。

### 画面

- Codex カードは変えない。OpenCode Go は 1 アカウント = 1 カードで、ヘッダーにアイコン（`aria-hidden`）、名前、
  `OpenCode Go`、状態ラベルを出す。3 窓・trend・最終取得・接続状態は各カードに出す。
- カードは `/api/usage` の `sources` から描く。`/api/opencode/accounts` は初回と保存・削除の後だけ取り直す
  （60 秒の別ポーリングはしない）。
- 「アカウントを追加」は名前 / アイコン（ラジオ）/ API キー。カードの「編集」は名前 / アイコン / API キー
  （空欄なら変更しない）と、その場で確認する「削除」。
- 0 件なら「OpenCode Go のアカウントは未登録です」と追加ボタンを出す。
- アイコンの背景色は id のハッシュから固定パレット 8 色へ振る client の純関数。絵文字は白で、ライト / ダークの
  どちらでも読める濃さにする。
- 状態ラベルは account の uuid ではなく `provider`（`codex` / `opencode-go`）で分岐する。0 件のときに
  opencode の `not_connected` 行は生まれない。

採用しない案:

- 別テーブル（`opencode_account`）を作る: テーブル定義と `user_version` を変える必要があり、既存の
  snapshot / error / sample の読み書きを 2 系統に分けることになる。source id を既存の列に入れる方が小さい。
- キーを DB（`DATA_DIR`）に置く: `data/` は履歴のバックアップ対象で、秘密を混ぜたくない（[0006](0006-opencode-api-key-registration.md)）。
- アイコン画像のアップロード: 保存・配信・権限の面が増える。12 種のプリセットで識別には足りる。
- アカウント間の合算やグループ化: アカウントはそれぞれ別の契約で、合算した数字に行動の意味が無い。
- 旧 `opencode-key.json` の自動移行: 移行先の名前とアイコンが決まらず、1 アカウントだけ特別扱いすることになる。
- `/api/usage` に provider ごとの集約行を残す: アカウント単位の state と trend が混ざり、画面の分岐が二重になる。

## 理由

- アカウントを 1 ファイルにまとめると、一覧・上限・並び順が 1 か所で決まり、部分的な不整合が起きない。
- source id を既存の `provider` 列に入れると、snapshot / error / sample の schema を変えずに複数アカウントへ広げられる。
- fetchers を毎回評価すると、アカウントの追加・削除にプロセスの再起動が要らない。
- 検証を書き込みの前に済ませると、「503 を返したのに名前だけ変わった」状態を作らない。

## 影響

- `/app/credentials` に `opencode-accounts.json` が増える。**バックアップやログに出さない**。
  旧 `opencode-key.json` は自動で消えないため、登録後に手動で削除する。
- 上流アクセスは 5 分 × アカウント数（上限 10 で 120 回/時）。レート制限が厳しければ `POLL_INTERVAL_MS` を
  延ばすか上限を下げる。sample は 30 日 × アカウント数で、10 アカウントでも容量は小さい。
- 上流の usage endpoint は公開契約ではない。アカウント追加ごとに 1 回検証するため、障害中は追加できない。
- `/api/usage` の `providers[]` が `sources[]` に変わる。client は同じ PR で追従する（後方互換は持たない）。
- `self-hosted-runner` の docs（`opencode-key.json` 前提の記述）は別リポジトリのため、follow-up PR で更新する。
