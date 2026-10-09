# 音声生成（generate_speech ツール）

チャットから音声（TTS）を生成し、セッションの作業フォルダへ保存する。目的は素材生成（ナレーション・セリフなど、あとで使うファイル）で、エージェントの返答の読み上げは作らない。生成は BFF が OpenRouter の音声専用 API（`POST https://openrouter.ai/api/v1/audio/speech`）へ要求し、保存だけをサンドボックスの upload API へ委譲する（BFF は作業領域に触らない）。設定は画像と同じ「コンテンツ生成」タブ（[`/settings/models/content`](model-settings.md#クライアント)）で、APIキーも `content_settings` の同じ行を共有する。

- 出力は **mp3 固定**。要求で `response_format: "mp3"` を常に明示する（API の既定は pcm で、そのまま保存すると拡張子だけ mp3 の再生できないファイルになる）
- 音声専用のモデル / ボイスは `content_settings` の `speechModel` / `speechVoice` に持つ。**NULL は「未設定」で、既定モデルと「そのモデルが宣言する先頭ボイス」へフォールバックして読む**（画面に「（未設定）」を出さない）
- ツールは **BFF ローカル**（`server/src/speech-tools.ts`）。サンドボックスのリモート定義ではなく、`PI_AGENT_TOOLS` の影響を受けない
- 保存は `workspace.uploadFile({ dir, name })`。`dir` は root 相対で渡す（画像と同じ 1 段の前置き。`server/src/workspace-path.ts`）
- 読み上げる文章は **逐語で読まれる**前提にする。演技指示（`instructions`）は非ゴールなので、ツール説明と system prompt で「演技指示を本文に書かない」ことを指示する
- 生成物の連結はしない。長文はエージェントが分けて複数回呼び、サンドボックスに連結の道具が無いこと（ffmpeg なし）を前提にする

## モデルカタログ

選択肢の正は keyless な live 一覧（`GET https://openrouter.ai/api/v1/models?output_modalities=speech`）。pi-ai に TTS の実装が無く SDK 同梱カタログへ落とせないため、取得できないときは**同梱の既定 1 件**を使う。実装は `server/src/speech-catalog.ts`。

| 出どころ (`catalogSource`) | いつ | `fetchedAt` |
| --- | --- | --- |
| `live` | このプロセスで取得に成功した（メモリ保持） | 取得時刻 |
| `stored` | 今回の起動では取れず、前回の成功を DB キャッシュから読んだ | 前回の取得時刻 |
| `default` | キャッシュも無く、同梱の既定 1 件を使っている | `null` |

- `default` は画像の `sdk` と同じ「live もキャッシュも無い」状態を表す。名前を分けるのは、同梱物が SDK カタログではなく**このリポジトリが持つ 1 件**だから（同じ語を使うと、SDK の更新で直るのか手で直すのかが読み分けられない）
- 取得は **API キーを使わない**（一覧 API は認証を見ないので、認証ヘッダも付けない）。**キーの死活チェックには使えない**
- 取得契機は 起動時（`content_settings` に行があるとき）/ 画面の [再取得]。`GET /api/settings/content` はネットワークに触れず、メモリ上の現在値を返すだけ
- 期限は 10 秒 + リトライなし。失敗は timeout / 混雑（429・5xx）/ 不明の固定文言へ分類し、上流の応答本文はログにも UI にも出さない
- 取得するのは `id` / `name` / `supported_voices` の 3 つ。形式（mp3 固定）はモデルごとに選べないため、カタログの宣言で絞り込みはしない
- 取得成功時だけ DB（`speech_catalog`）へ `{ id, name, voices? }` を残す。テーブルの形は `image_catalog` と同型で、item の JSON だけが違う（`voices` を持つ）。キャッシュは派生データとして扱い、読めない行は未取得として読んで health を落とさない
- キャッシュが `default` のとき（live に一度も成功していないとき）は**保存時の照合をしない**。同梱が 1 件しかない状態で照合すると、保存済みの選択を再保存できなくなる

### 同梱の既定カタログ

`google/gemini-3.8-flash-tts` と、そのモデルの `supported_voices`（取得時点で 30 件）を写したものを同梱する。出所は 2026-10-08 に取得した OpenRouter のモデルページ / モデル一覧 API（`https://openrouter.ai/google/gemini-3.8-flash-tts`、`GET /api/v1/models?output_modalities=speech`）。

上流の追加・改名でこの写しは腐る。live を一度でも取れた環境では丸ごと置き換わるため表示への影響は無いが、オフラインの初回起動では既定が使われる。**更新責任はこのリポジトリ**で、変えるときはモデルページの `supported_voices` を正として `server/src/speech-catalog.ts` の同梱カタログを直す（[モデルカタログ](#モデルカタログ) の 3 状態は変えない）。

### 画面表示

選択肢の出どころは live 以外を「取得に失敗している状態」として区別し、最後に live を取得できた時刻を添える（黙って古い一覧を見せない）。`default` は同梱の既定を見ていることを文言で伝える。文言と表示の正は `client/src/lib/contentSettings.ts` の純関数。[再取得] は `POST /api/settings/content/speech/catalog/refresh` で、**常に 200** の応答に `catalogError`（固定文言）だけを載せる。

### ボイスの宣言

- `supported_voices` があるモデルは、その一覧から選ぶ。モデルを切り替えるとボイスは新しいモデルの先頭へ寄せる（宣言が変わって保存値が宣言外になったときも同じ）
- `supported_voices` が無いモデル（Fish Audio / Seed Audio など）は自由記述を許す。空欄は「送らない」を表し、`voice` キーごと本文から落とす
- 宣言があるモデルで宣言外のボイスを保存しようとしたとき（`PUT`）と生成しようとしたとき（ツール）は 400 / 課金前の失敗にする。OpenRouter は provider が既定声を持つ場合を除いて `voice` の省略を 400 にするため、その 400 は `unknown` として provider メッセージを添え、声の指定を促す

## 有効化（ゲート）

`content_settings` の行の有無だけがゲートで、画像と同じ `ContentGenerationConfig` が写し先になる。音声だけを無効にするトグルは持たない。

- `bootstrap.ts` は画像カタログの後に音声カタログのキャッシュを読み、行があるときだけ live を試す（画像と同じ順序）
- ツール一覧はセッション作成時に固定する（新しい会話と復元から効く）。有効化しても既存の live セッションには遡及しない
- `execute` は作成時のキーを握らず、毎回 `content_settings` を読み直す。未設定・削除後はキー無効エラーを返し、キーの変更・回転にも追随する
- 話者の宣言も実行のたびに引く。保存時と実行時で扱いが違う: `PUT` は `default`（live に一度も成功していない）のときだけ照合を免除するが、ツールはカタログの出どころに関係なく宣言を引き、宣言があるモデルでは宣言外のボイスを課金前に拒否する

## 失敗の分類

分類と文言は画像と同じ規則を使う（`server/src/provider-failure.ts` の 1 つを共有し、文言だけを生成物の種類で差し替える）。要求は自前 `fetch` で、期限は `AbortController` + タイマー（既定 180 秒）だけに掛け、ユーザー中断は `signal.aborted` で timeout と区別する。

| 分類 | 条件 | 文言 |
| --- | --- | --- |
| `invalid_key` | 401 / 403 | 音声APIキーが無効です。設定を確認してください |
| `insufficient_credit` | 402 | 音声生成の残高が不足しています |
| `rate_limited` | 429 / 5xx | 音声生成が混雑しています（レート制限またはプロバイダー障害） |
| `timeout` | 自前タイマーの abort | 音声生成がタイムアウトしました |
| `aborted` | ユーザー中断 | 音声生成を中断しました |
| `unknown` | それ以外 | 音声生成に失敗しました（マスク済みの provider メッセージを 500 文字まで添える） |

応答は JSON ではなく生バイトで、**2xx でも本文が 0 バイト / `Content-Type` が `audio/*` でない応答は失敗**にする（画像の「画像 0 件は失敗」と同じ思想。空ファイルを保存して成功と報告しない）。理由は provider メッセージからは分からないため、この 2 つだけは `unknown` の固定文言で理由を補う。

モデルごとの per-request 上限（文字数 / 秒）はカタログから読めない。BFF は 4,000 文字を保守的な上限として課金前に止めるが、上限以内でも provider が 400 を返しうる。その場合は `unknown` + マスク済みメッセージで短縮を促す。

## 保存先とパスの空間

| 空間 | 例 | 使う場所 |
| --- | --- | --- |
| cwd 相対 | `generated/narration.mp3` | ツール引数 / 結果、`read`、ファイルプレビュー |
| root 相対 | `projects/u7agent/generated/narration.mp3` | サンドボックス API（`dir`）、`GET /api/files` |

- 既定の保存先はセッション cwd の `generated/<slug>.mp3`。`slug` は本文を `[a-z0-9-]` へ正規化した 40 文字まで（英数字が取れなければ `speech-<ISO 日時>`）
- `path` を明示したときは `.mp3` だけを許し、拡張子を省略したときは付ける。`.wav` や `.pcm` は保存形式そのものが非ゴールなので拒否する
- 同名のファイルがあっても上書きせず、サンドボックスが `-1` などの連番を付ける。ツール結果には**実際に保存された cwd 相対パス**を返す（root 相対は返さない）
- 拒否規則（`..` / 絶対パス / バックスラッシュ / 空の name）は `generate_image` と同じ実装を使う（同じ失敗に同じ文言を返す）
- 課金前に止める失敗（4,000 文字超 / パスの拒否 / `.mp3` 以外 / 宣言外のボイス / キー未設定）は provider を叩かずに throw する
- 結果本文の先頭に「モデル: …」「ボイス: …」を置く。投影（`toolResultSummary`）は先頭 900 文字で切るため、長いパスでも実行に使ったモデルとボイスが欠けない
- 生成した一意ファイルは上書き・移動しない。会話のプレビューはファイルへのライブ参照なので、`mv` で動かすと過去の発話から辿れなくなる（画像と同じ規則）
- 保存上限はサンドボックスの upload 既定（100 MiB）に従う。音声だけの上限は設けない

## キーの扱い

APIキーは画像と**同じ 1 つを共有**する（`content_settings.apiKey`）。登録・削除・上書きは画像と同じ `PUT /api/settings/content/key` で、音声専用のキーは持たない。

- 削除は行ごと消すため、音声のモデル / ボイスの選択も一緒に消える（未設定へ戻る）
- キーは GET 応答・ログ・health・エラー文言に出さない。DB へ書く前に `retainSecret()` でマスカーへ登録する
- 音声のモデル / ボイスとして保存された値が、同じ行の APIキーと一致・包含するときは未設定として扱う。実行時のマスカーの状態に依存させないためで、ランタイムなしで起動したとき（マスカーが値を見ない構成）も GET・成功応答・実行時解決のどこにもその値を出さない。`400` の文言へ入力を反射するときも（どの値が不正かという形は残して）伏せ字にする
- 音声の要求は BFF 内で完結し、キーはサンドボックスへ渡らない。詳細は [secrets.md](secrets.md#保護対象)

## 設定画面（コンテンツ生成タブ）

画像と同じタブの下に音声のセクションを置く（provider の見出しとキー欄は共有）。表示の正は `client/src/lib/contentSettings.ts` の純関数、取得と操作は `client/src/hooks/useContentSettings.ts`、描画は `client/src/components/model-settings/ContentSettingsTab.tsx` に閉じる。

- 未設定（行が無い）ではキー入力だけを出し、音声の欄もモデルと同じくキー保存後に現れる
- モデルとボイスの選択は、保存済みの値がカタログから落ちていても現在値を見失わせない。ボイス欄は選択中モデルの宣言に応じて選択 / 自由記述を切り替え、空欄は「送らない」を表す
- モデルを切り替えたらボイスは新しいモデルの既定（先頭、宣言が無ければ空）へ寄せ、旧モデルの値を持ち越さない
- [再取得] の後は server の現在値へ表示を合わせる（[モデルカタログ](#モデルカタログ)のフォールバックが一覧の並びで変わり得るため）。確認できたことの根拠は成功した GET だけで、未同期の間は古い表示を現在値として扱わず、「（未確認）」とエラー注記で知らせて音声の設定を保存させない（一覧が変わらない再取得の失敗で以前の値が実効値のままのときは同期済みを保つ）
- 画面下部の注記は、保存したキーが新しい会話から使えることと、生成物が `generated/` に保存されることを共通で伝える

## API

| メソッド | パス | 説明 |
| --- | --- | --- |
| PUT | `/api/settings/content/speech` | `{ model, voice }`。キーと画像モデルを保持したまま音声の選択を更新（行が無ければ 400） |
| POST | `/api/settings/content/speech/catalog/refresh` | live カタログの再取得。常に 200 で `models` / `catalogSource` / `fetchedAt` / `catalogError` を返す |

- `GET /api/settings/content` の `speech` は `model` / `voice` / `models`（`voices` を含む）/ `catalogSource` / `fetchedAt`。`models` は live が取得できれば live、できなければ前回の一覧、どちらも無ければ同梱の 1 件
- 400: 行が無い、`catalogSource` が `live` / `stored` でカタログ外のモデル、宣言があるモデルで宣言外のボイス（`default` のときは照合しない）
- 変更系の応答は GET と同じ形 + `state: "applied"`。DB 書込に失敗したときだけ 503 `{ error, state: "not_stored" }`。詳細と例は [api.md](api.md#コンテンツ生成設定--モデルのコンテンツ生成タブ)

## テスト

実 API は呼ばず、ダミーキー + stub provider / fake サンドボックスで検証する。

| テスト | 固定すること |
| --- | --- |
| `server/test/speech.test.ts` | 音声専用 API への送信先・ヘッダ・本文（`mp3` を常に送る）/ `voice` を指定時だけ送ること / 2xx の空応答と音声以外の Content-Type を失敗にすること / 失敗分類（401・403・402・429・5xx・timeout・ユーザー中断・原因不明）/ provider メッセージのマスクと上限 |
| `server/test/speech-catalog.test.ts` | 同梱カタログの形（既定モデルと全 30 ボイス）/ live の採用とキャッシュ保存（認証ヘッダなし・`voices` を含む）/ 重複の畳み方と宣言の読み方 / 失敗分類と一覧の保持 / キャッシュ読込と live 失敗時の維持 / キャッシュの読取・保存失敗 |
| `server/test/speech-tools.test.ts` | ツールの組み立て（有効時だけ・画像とは独立）/ 引数と説明（逐語・演技指示なし）/ `.mp3` の規則と slug / 既定保存名と root 相対の前置き / 結果の先頭にモデルとボイス / 課金前の拒否（文字数・パス・拡張子・宣言外ボイス・キー未設定）/ execute の再読込 / throw のマスク / signal の伝播 |
| `server/test/speech-settings.test.ts` | 音声列 NULL のフォールバック、`PUT` の 400（行なし・カタログ外・宣言外）、`default` では照合しない、空文字ボイスの保存、503 `not_stored`、再取得の失敗文言、起動時の適用と注入した `readSpeech` / `readVoices` |
| `server/test/speech-settings-api.test.ts` | HTTP 契約（GET / PUT / 再取得）、既定カタログの形、キーが応答に出ないこと、カタログ外 / 宣言外 / 本文形の 400、DB 不通 |
| `client/test/contentSettings.test.ts` / `client/test/contentSettingsTab.test.ts` | 音声モデルとボイスの選択肢・現在値・PUT の本文・自由記述の切替 / カタログ外の現在値 / 出どころのチップと再取得の注記 / タブの描画（音声欄はキー保存後・runtime 不可でも残る） |

## 非ゴール

- 話し方の指示（`instructions`）の引数 / 設定、マルチスピーカー（`input` の配列）、ボイスクローン（`input_references`）、STT
- pcm / wav の保存、サンプルレートやビットレートの変換（mp3 固定）
- 長文の自動分割・連結（分割はエージェントの仕事。サンドボックスに ffmpeg が無い）
- チャットのツール結果カードでの再生、設定タブでのボイス試聴、ボイスごとの説明文
- 音声だけを無効にするトグル（キーの有無がゲート）
