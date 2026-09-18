# セッション別ファイル管理と会話の永続化（設計）

## 目的

- セッション（会話）ごとのファイルを、ワークスペース root 配下のセッションフォルダで管理する。
- 会話履歴をファイル（JSONL）に保存し、BFF を再起動してもセッション一覧・履歴・続きの送信を復元できるようにする。
- 現状は履歴がメモリのみで、作業ファイルは残っても会話が戻らない。会話とファイルを同じ id で対応させ、この不一致を解消する。

## 現状（事実）

- セッションの cwd は所属プロジェクトのディレクトリ、未所属ならワークスペース root。ファイル画面はその cwd のツリーを表示する（`client/src/App.tsx` の `filesCwd`）。
- セッション / プロジェクト / 会話履歴は BFF のメモリのみ。1 時間未使用の sweep と再起動で消える。作業ファイルだけが `/workspace` の永続マウントに残る。
- BFF はワークスペースに触らず、ファイル操作・シェル実行はサンドボックス API 経由（[sandbox.md](sandbox.md)）。BFF のファイルアクセスはこの原則の例外を作らない。
- pi SDK の `SessionManager` は会話を JSONL（1 行目 header、以降 message / compaction / model_change / thinking_level_change など）で扱う。現在は `SessionManager.inMemory` を使っている（`server/src/agent.ts`）。
- SDK のファイル永続化は assistant メッセージが現れるまで書かない（`_persist` が `hasAssistant` まで保留する）。そのまま使うと初回応答の完了前に再起動したとき最初の送信が消える。
- SDK は `model` を明示しないと、保存済みモデルを `PI_MODELS` で絞った候補ではなくランタイム全体から復元する（[model-effort.md](model-effort.md) の whitelist を迂回する）。
- SDK の `message_end` は **listener 通知が先で、entry の append は後**（`dist/core/agent-session.js` の `_handleAgentEvent`）。listener の中で `getEntries()` を読むと当該メッセージはまだ入っていない。
- ツール出力の秘密値は LLM・SSE へ渡す前に `redact` でマスクされる（[secrets.md](secrets.md)）。生のユーザー入力・モデル出力はマスク対象外。

## 設計の要点

1. **会話ログの置き場は BFF 専用の store**。ワークスペースには置かない。ワークスペースはサンドボックスの bash / write から変更できるため、ログを置くと symlink 差し替えで BFF コンテナのファイルを破壊・読み出しできてしまう（コンテナ境界を越える）。
2. **JSONL の読み書きは BFF が行う**（SDK は `SessionManager.inMemory` + entries で使う）。SDK の永続化の保留挙動を避け、保存点と書込みフラグを制御する。ファイル形式は SDK と同じ。
3. **セッション id が会話（store）とファイル（ワークスペース）を結ぶ**。再起動後は同じ id で両方を復元する。
4. **復元は世代（generation）付きで扱う**。seq は再起動で 0 に戻るため、数値カーソルだけでは再接続を判定できない。

## レイアウト

```
# 1) 会話ストア（BFF 専用。サンドボックスへマウントしない）
$PI_SESSION_STORE/<id>/
  meta.json      # 会話以外のアプリメタデータ
  session.jsonl  # pi SDK 形式の会話（header + entries）

# 2) セッションの作業フォルダ（サンドボックスが読み書き。ファイル画面の root）
<workspace root>/.pi-agent-gui/sessions/<id>/
```

- `<id>` は `crypto.randomBytes(5).toString("hex")` の 10 文字。外部ライブラリは増やさない。store 側のフォルダ存在で衝突を検出し、衝突したら再生成する。SDK の `assertValidSessionId` も満たす。
- `PI_SESSION_STORE` の既定は `<agentDir>/pi-agent-gui/sessions`。**`PI_APP_CWD` の中は起動時に拒否する**（ワークスペースをサンドボックスと共有する構成で store を共有してしまう事故を防ぐ）。
- 作業フォルダの作成は既存のサンドボックス `POST /v1/dirs`（`mkdir -p` 相当）で行い、復元時も冪等に呼んで存在を保証する。BFF は作業領域のファイルに触らない。
- store のフォルダ権限は 0700 にする。

## meta.json

```json
{
  "version": 1,
  "id": "a1b2c3d4e5",
  "title": "ファイル画面の改修",
  "createdAt": 1760000000000,
  "lastUsedAt": 1760000100000,
  "messageCount": 12,
  "agentId": "default",
  "agent": { "id": "default", "name": "…", "description": "…", "skillIds": [], "skills": [] },
  "promptSnapshot": { "agent": "<agent プロンプト>", "skills": ["<skill プロンプト>"] },
  "projectCwd": "projects/pi-agent-gui",
  "projectName": "pi-agent-gui",
  "model": "openai-codex/gpt-6-astra",
  "thinkingLevel": "medium"
}
```

- `promptSnapshot` は作成時の agent / skill プロンプト。定義を編集・削除しても復元後の実行内容を変えない（現行の「定義変更を遡及させない」と同じ）。アプリ共通の system prompt は現行を使う（アプリ側の変更は全セッションに効く）。
- `title` は最初のメッセージで、`lastUsedAt` / `messageCount` はラン終了時に更新する。`messageCount` は一覧 API と同じ表示メッセージ数（`user` と、テキストを持つ `assistant`）を数え、ツール呼び出しだけのターンは数えない。
- 書込みは一時ファイル + rename で原子的に行い、id ごとの書込みキューで直列化する。読めない `meta.json` は壊れたセッションとして一覧から除外し、ログに残す（フォルダは消さない）。

## 会話の保存

- SDK セッションは `SessionManager.inMemory(cwd, { id }, entries)` で作る。entries は BFF が読んだ JSONL（header + entries）。SDK 側はファイルを持たない。
- 保存は `getHeader()` / `getEntries()` を SDK 形式（1 行 1 entry の JSON）で直列化する。header の `id` はアプリのセッション id にし、`piSessionId` も同じ値になる（DTO は互換のため両方返す）。
- **保存点**:
  - 作成時: header + meta
  - `message_end`: SDK は listener 通知の後に append するため、listener では `queueMicrotask` で 1 拍置いてから `getEntries()` を読む（実 SDK で順序を検証するテストを置く）
  - `compaction_end`、設定変更（`setModel` / `setThinkingLevel` の後）
  - ラン終了時に最終 flush（最後の assistant entry を取りこぼさない）
  - `sweep` / `close` は dispose の前に flush を待つ
- **書込みプロトコル**:
  - 「確定バイト位置」= 最後に完全に書けた entry の直後の offset を record ごとに持つ。追記はこの位置へ `write` し、成功したら位置を進める。
  - 追記の前に `ftruncate(確定位置)` で途絶した末尾（前回の部分書込みを含む）を落としてから書く。部分書込み（ENOSPC など）の後は同じ書込みキューの中で復旧して再試行し、再試行回数を区切って失敗を記録したら次の保存に委ねる。復旧（ftruncate）にも失敗したらその id の追記を停止してエラーを出す（原本は壊さない）。
  - entry は常に `<json>\n` で書く。末尾が parse 可能だが改行が無い場合は、確定位置をその行の終わり（改行を除く）として保持し、次の書込みの先頭で改行を補ってから追記する。
  - 追記で表現できないとき（初回作成、entries が保存済み分の単純な延長でないとき）だけ temp + rename で全体を書き直す。rename は同期で完了を待ってから確定位置を更新し、宛先が symlink なら書かない。temp 名は毎回ランダムにする。追記と全体書直しの判定は 1 つの関数に閉じる。
- **直列化と失敗時**: id ごとの非同期書込みキューで meta / JSONL の書込みを直列化する。書込みは開始時に id の状態を確認し、`deleting` 以降は no-op。書込み失敗では確定位置を進めず再試行し、エラーはログと health に出して API の成功応答を保存成功とみなさない（in-memory のチャットは継続する）。
- **読み込み時の検証（非破壊）**:
  - 1 行目が header でただ 1 つ、`type: "session"`、`id` がフォルダ名と一致、`version` が現行（`CURRENT_SESSION_VERSION`）と一致することを検証する。
  - entry の `id` が一意で、`parentId` が `null` か「自分より前の entry」を指すこと（自己参照・循環・重複・前方参照をここで排除する）。SDK の親探索は循環を検出しないため、ロード前に必ず弾く。
  - entry の `type` は既知のものだけを許可し、型ごとの必須フィールド（`timestamp` / `message` など）を検証する。未知 type は破損扱いにする。
  - 末尾の途絶（末尾改行が無く parse できない行）だけは「書込み途絶」として読み飛ばし、原本は書換えず、次の書込み時に確定位置まで truncate してから追記する。それ以外の parse 失敗・中間破損・検証失敗は、原本を一切書換えずに開く要求を 409（store のパスを含む文言）で拒否する。一覧には meta から出し、DELETE は可能にする。
  - 現行 version 限定とし、古い version の migration は行わない（非破壊で拒否）。pi CLI など別実装が書いたファイルの取り込みも対象外。

## 復元

- 起動時に store を走査して `meta.json` を読み、一覧用 descriptor（id / title / agent 表示情報 / projectCwd / createdAt / lastUsedAt / messageCount）を作る。SDK セッションは開くときに作る。
- 開く処理: JSONL を検証つきで読み、`SessionManager.inMemory(cwd, { id }, entries)` を作り、作業フォルダの存在を保証し、`promptSnapshot` から resource loader を組み、モデルを解決して `createAgentSession` に渡す。
- 破損・model 不在などで開けない場合も一覧からは消さない（descriptor を保持）。

## モデル / Effort の復元

- 候補の決め方は「JSONL の最後の `model_change` → meta の `model` → アプリ既定」の順。`availableModels`（`PI_MODELS` で絞った候補）と厳密照合し、候補があればそれを、無ければアプリ既定を使って復元する。**whitelist 外のモデルで再開する経路は作らない。**
- フォールバックしたときは `session.setModel(実効モデル)` で `model_change` entry を追記して保存する（元モデルが後で候補に戻っても、続きを別モデルで進めたセッションが元へ戻らないようにする）。meta の `model` も更新する。
- 利用可能なモデルが 1 つも無い場合、セッションを開く要求は 503（既存の `AUTH_REQUIRED_MESSAGE` / `MODEL_UNAVAILABLE_MESSAGE` 相当）で拒否する。履歴の閲覧だけをモデル無しで許すことはしない（現行どおりランタイム必須）。
- `thinkingLevel` は JSONL の最後の `thinking_level_change` を使い、現在のモデル能力で clamp した値を実行に使う（clamp はロードのたびに再現されるため、補正後の値を entry へ必ず追記する必要はない）。payload には SDK が持つ実効値を返し、モデル能力が変わった場合の挙動をテストする。

## ライフサイクルと排他

| 操作 | メモリ | 会話 store | 作業フォルダ |
| --- | --- | --- | --- |
| 作成（最初の送信） | record 追加 | header / meta 作成 | `mkdir`（sandbox） |
| アイドル 1 時間の sweep | dispose して破棄 | 残す | 残す |
| `DELETE /api/sessions/:id` | 停止 + dispose | 削除 | 残す |
| BFF 再起動 | 消える | 残る → 起動時に一覧へ復元 | 残る |

- id ごとに `idle`（未ロード）/ `loading` / `live` / `evicting` / `deleting` の状態と、ライフサイクル操作（load / evict / delete）を直列化する Promise チェーンを持つ。状態の予約は最初の await より前に同期的に行う。
- `deleting` は以後のロード・送信・購読・設定変更を拒否する。`evicting`（sweep）中のロード・送信・購読は eviction の完了を待ってから新しい record をロードして続行する（待ち時間は短く、送信も拒否しない）。
- `DELETE` の手順: 状態を `deleting` に予約 → 進行中ランを abort → 書込みキューを drain → SDK を dispose → store のフォルダを削除 → descriptor / record を外す。SDK のロードは不要（モデル未認証・JSONL 破損でも消せる）。live のときだけ停止する。
- `loading` は完了時に状態を再確認し、`deleting` なら作った SDK を dispose して公開しない。
- sweep は「購読者（SSE 接続）がいない・実行中でない・書込みが残っていない」ときだけ `evicting` を予約してメモリから外す。flush に失敗したときは破棄を見送って記録を残す（次の sweep で再試行）。開いているタブが握っているセッションを復元先へ付け替える競合は作らない。
- `close()` は最初に全体の受付を閉じ（新規リクエストは 503）、進行中のロードと書込みキューを回収してから全 record を dispose する。最終 flush の失敗はログに残して終了する。
- `DELETE` は履歴だけ消し、作業フォルダは残す（サンドボックスに削除 API が無く、アプリはユーザーのファイルを消さない方針）。confirm は「セッションの履歴を削除します。ファイルは残ります」に変える。
- プロジェクト解除（`DELETE /api/projects/:id`）: 先に解除対象の `projectCwd` を捕捉 → 登録解除 → 配下 live のランを abort して停止（削除はしない）→ 購読中のタブへ `resync` を送る（所属が外れた payload になり、`session_deleted` は送らない）→ store / 作業フォルダ / meta の `projectCwd` は触らない。`projectId` は保存せず読み取り時に `projectCwd` → `ProjectStore.findByCwd` で解決するため、解除後は未所属として一覧に出て、同じ cwd を再登録すれば所属が戻る（ロード中に完了したセッションも同じ規則で解決される）。プロジェクトの自動再登録はしない。
- プロジェクト解除の確認文は「登録を解除し、実行中のセッションを停止します。履歴とファイルは残ります」に変える。

## SSE の世代

- SSE の `id` は `<generation>:<seq>` にする。`generation` は record のロードごとに発行するランダムな 8 hex（再起動・sweep 復元で変わる）。
- カーソルの優先順位は「`Last-Event-ID` ヘッダ（`<generation>:<seq>`）が有効ならそれ → query の `?generation=&after=`（両方あるとき）→ どちらも無ければ `resync`」。差分リプレイは「generation が現在と一致し、seq がバッファ範囲内」のときだけ行い、generation が無い / 一致しない / 古い形式は `resync` を 1 件送る。
- これで「seq が再起動前より進んだ状態で旧タブが再接続する」「cursor と新 seq が同値」「cursor が新 seq より大きい」のいずれも全文再同期になる。
- クライアントは payload の `eventGeneration` と `lastSeq` を保持し、接続 URL に `?generation=<g>&after=<seq>` を載せる（新規ページ読込では差分だけ再送）。通常の自動再接続はブラウザが送る `Last-Event-ID` を使う。`client/src/hooks/useSessionEvents.ts` の接続 URL と、snapshot 適用時の generation / seq の同時更新を変更対象に含める。
- テストは「cursor < / = / > seq」「generation 不一致」「ヘッダあり・query のみ・どちらも無し」「世代変更後の再接続」を網羅する。

## API / UI

- `SessionPayload.cwd` は root 相対の `.pi-agent-gui/sessions/<id>`。復元後も同じ値を返す。ファイル画面は既に `payload.cwd` を root にしているため、クライアントの変更なしでセッション別フォルダ表示になる。
- `SessionPayload` に `eventGeneration` を足す。`SessionSummary` の形は変えない（復元したセッションは `status: "idle"`、`messageCount` は meta の値、`projectId` は `projectCwd` から解決した値）。
- `GET /api/sessions/:id` など、これまで同期だった `store.get()` は「未ロードなら読み込む」非同期処理になる（ルートハンドラを async にする）。
- `/api/health` に store の準備状態（パス / 可否 / 保存に失敗している live セッション数 `dirty`）を足す。store を準備できず起動時に拒否した場合も、セッション作成を 503（理由つき）で拒否する。
- 削除系の confirm 文言（セッション / プロジェクト）を変更する。

## セキュリティ

- store は BFF 専用にし、サンドボックスへマウントしない。`PI_SESSION_STORE` が `PI_APP_CWD` の中なら起動時に拒否する。
- store に残るのは生のユーザー入力・モデル出力。ツール出力は保存前（LLM へ渡す前）にマスクされる。ディスクに残る新しい露出であることを [secrets.md](secrets.md) に明記する。ホスト上で同一ユーザーの別プロセスからは読める（[sandbox.md](sandbox.md) の既存の残存リスクと同じ）。
- 作業フォルダは従来どおりサンドボックスから読み書きでき、セッション間の隔離は無い（bash がある以上、他セッションのフォルダも操作できる）。

## デプロイ

- BFF コンテナに `PI_SESSION_STORE` の永続ボリュームを追加する（例: `/session-store`）。**ワークスペースはマウントしない**（現行どおり）。
- 作業フォルダはワークスペースの永続マウント配下（`/workspace/.pi-agent-gui/sessions/<id>`）にでき、サンドボックスから見える。
- `pnpm dev` は store の既定が `~/.pi/agent/pi-agent-gui/sessions` なので追加設定なし。`.gitignore` に `.pi-agent-gui/` を追加する。
- Compose / target の変更は self-hosted-runner 側（[persistence.md](persistence.md) の正本）。

## 責務の分け方

- `server/src/session-store.ts`（新規）: store root の準備・走査、id 生成、meta / JSONL の読み書き（検証・migration・原子的書込み・書込みキュー）。
- `server/src/sessions.ts`: live な `SessionRecord` の管理（現状どおり）、descriptor のマージ、id ごとの状態（loading / deleting）、遅延復元、sweep、世代。
- `server/src/agent.ts`: `SessionManager.inMemory` + `promptSnapshot` の組み立て、モデル解決とフォールバック記録、保存点のフック。
- `server/src/projects.ts`: `projectId` の読み取り時解決（保存しない）。

## 検討した代替案

- **会話とファイルを同じフォルダに置く**: サンドボックスが唯一の書込み者であるフォルダに BFF が追記する構成になり、symlink 差し替えでコンテナ境界を越えられる。却下。
- **SDK のファイル永続化をそのまま使う**: 初回 assistant まで保存されない・モデル復元が whitelist を迂回する・書込みフラグを制御できない。却下。
- **サンドボックスに削除 API を足して DELETE でフォルダも消す**: この Issue の必須要件ではない。非破壊の DELETE にして別 Issue に送る。
- **ID に UUID / 外部ライブラリ**: 長い / 依存が増える。10 hex 文字で足りる。

## リスク・非ゴール

- 会話ログと作業ファイルは別の場所になる（同じ `<id>` で対応）。バックアップ / 移設は `PI_SESSION_STORE` を単位にする。
- DELETE で作業フォルダは消えない（手動で消すか、将来の削除 API を待つ）。
- セッションの `promptSnapshot` は作成時の定義で固定される。定義の変更を反映したい場合は新しいセッションを作る。
- 非ゴール: サンドボックスの削除 API、容量管理、複数 BFF インスタンス、古い SDK セッション version の migration、pi CLI との双方向編集 / 汎用インポート、モデル無しでの履歴閲覧。
- compaction の `reason` / `estimatedTokensAfter` は `compaction_end` にしか無く復元後は欠ける（表示は `tokensBefore` で成立する。[persistence.md](persistence.md) の方針どおり）。

## 受け入れ条件

- [ ] 会話ごとに store（`<store>/<id>/{meta.json,session.jsonl}`）と作業フォルダ（`.pi-agent-gui/sessions/<id>`）が作られ、ファイル画面の root が作業フォルダになる
- [ ] BFF を再起動しても、セッション一覧・タイトル・履歴・ファイルが復元され、続きから送信できる
- [ ] 初回応答の完了前に再起動しても、保存済みのユーザーメッセージが復元される（保存点の順序テスト）
- [ ] compaction を含む履歴が JSONL に残り、復元後も区切り表示が再現される
- [ ] `PI_MODELS` から外したモデルのセッションは、そのモデルで再開されず、フォールバック後の実効モデルが JSONL / meta に残る
- [ ] アイドル sweep で store / 作業フォルダが消えず、SSE 購読中のセッションは sweep されない
- [ ] `DELETE /api/sessions/:id` は SDK ロードなしで動き（破損・モデル未認証でも可）、履歴だけを消してファイルを残す
- [ ] load × DELETE、write × DELETE、sweep × 送信 / 購読、close × loading が store を復活させたり進行中の SDK を壊したりしない（状態予約とライフサイクルチェーンのテスト）
- [ ] 部分書込み（ENOSPC）後に復旧して再試行でき、entry の重複・連結が起きない（復旧失敗時は追記を止める）
- [ ] 中間破損・header 不一致・重複 ID・循環 parentId・未知 version のセッションは原本を書き換えずに開く要求が失敗し、DELETE はできる
- [ ] 末尾が途絶えた JSONL（不完全行・改行欠け）は不完全分だけを捨てて復元できる
- [ ] SSE はカーソル優先順位（ヘッダ → query → resync）と generation 不一致 / cursor の大小で正しく resync し、旧タブが古い表示のまま残らない
- [ ] プロジェクト解除後もセッションのファイルと store が残り、一覧では未所属として解決され、購読中タブが resync で更新される
- [ ] store が `PI_APP_CWD` の中なら起動時に拒否される
- [ ] 未作成チャットのファイル画面・プロジェクト導線が壊れない
- [ ] `pnpm check` が通る
- [ ] `docs/persistence.md` / `projects.md` / `api.md` / `api-sessions.md` / `secrets.md` / `run-lifecycle.md` / `architecture.md` / `model-effort.md` / `README.md` を更新する

## 実装順（目安）

1. `session-store.ts`（レイアウト・meta・JSONL の検証 / migration / 書込みキュー・走査・id）とテスト
2. `agent.ts` の `SessionManager.inMemory` 化・`promptSnapshot`・モデル解決とフォールバック記録・保存点フック
3. `SessionStore` の descriptor マージ・遅延復元・状態機械・sweep・DELETE
4. SSE の generation、ルートの非同期化、health、プロジェクト ID の読み取り時解決
5. クライアント（`eventGeneration`、confirm 文言）、docs 更新、Docker / Compose
