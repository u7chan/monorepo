# BGM生成（generate_bgm）

チャットから新しいインストゥルメンタルBGMを依頼し、MP3をセッションの作業フォルダへ保存する。逐語読み上げの [TTS](speech-generation.md) とは別のツールで、会話モデルは変えない。生成はBFFからOpenRouterへ要求し、正常に受信した音声の保存だけを既存のサンドボックスuploadへ委譲する。

## API確認の状態

**実APIの受入は完了（2026-11-03）。Lyria の実 API で 1 回の BGM 生成（MP3 / 実測 30.77 秒 / 生成 12.9 秒）が成功し、ブラウザーで再生・シークできることを確認した。要求は voice を送らず、`audio/mpeg` で返った。料金はユーザーが許容と判断した。n=1 のため、再現性・失敗分類・聴感の継続確認は残る。**

公開資料を2026-10-23に調査した根拠は次のとおり。

- [OpenRouterモデルページ](https://openrouter.ai/google/lyria-3-clip-preview) は音声出力と30秒クリップを説明し、参照価格を $0.04 / clip としている。料金保証ではなく、トークン単価から無料とも判断しない。
- [Googleモデル仕様](https://ai.google.dev/gemini-api/docs/models/lyria-3-clip-preview) はMP3の出力を説明する。ただしGoogle直結の契約をOpenRouterの要求へ読み替えない。
- [OpenRouter Audio](https://openrouter.ai/docs/guides/overview/multimodal/audio) は `modalities: ["text", "audio"]`、`audio.format`、`stream: true` と `choices[].delta.audio.data` を説明する。voiceはモデル依存で、**Lyriaでの省略可否とBase64の境界・paddingは、この説明だけでは確定しない**。
- [OpenRouter Streaming](https://openrouter.ai/docs/api/reference/streaming) はコメントのkeep-alive、`[DONE]`、usageフレームによる同じ `finish_reason` の再掲、HTTP 200内の `error` を説明する。

送信先は `POST https://openrouter.ai/api/v1/chat/completions`。固定モデル、userのテキストprompt、上記modalities、`audio: { format: "mp3" }`、streamを送り、BFFがinstrumental / no vocals指示を補う。**TTS voiceを推測指定せず、Google直結や別形式へのフォールバックもしない。**

暫定の受信範囲は、1 choice / 1 audio track、各 `delta.audio.data` が**独立してcanonical Base64へデコードできるイベント**、`finish_reason: "stop"` の後の `[DONE]`。track idがあれば全イベントで同じ値だけを許す。text / transcript / usageは音声に混ぜない。usageの同じstop再掲と空choicesのusageも受け付ける。継続Base64列、複数音声、未知の終端へ推測で対応しない。

`server/test/fixtures/bgm-sse.ts` は**手書きの合成stubで、実レスポンス由来ではない**。含む最小MP3ヘッダもブラウザー再生可能な音声を示すものではない。実 API 受入で確認した voice 省略・MP3 / Base64 の扱いは、キー・個人情報・生の音声 Base64 を含めずに fixture へ反映する（この受入では未反映）。

## キー・公開ゲート・設定

- `content_settings` の暗号化したキー（`ciphertext` / `nonce` / `keyVersion`）を画像・TTSと共有する。会話モデルの認証とは別管理。BGM専用キー、DB列、カタログ、新規保存APIは持たない。
- 公開条件はコンテンツ生成のゲート（キーの行と `enabled`）とエージェントの `toolNames` の積。登録名・定義・カタログは同じ判定にし、公開時だけBGM用promptを追加する。調査子セッションや `PI_AGENT_TOOLS` のremoteには追加しない。有効 / 無効は画像・TTSと共通の1つで、BGMだけを止めるトグルは持たない。
- 公開状態はセッション作成・復元時に固定する。キー後付けは新しい会話から。実行時は `ContentGenerationConfig.readBgm()` で現在キーを読み、回転へ追随し、削除後に始める生成は送信前に止める。設定でOFFにした場合も `readEnabled()` を実行のたびに見て、送信前に固定文言で止める。
- キーは `retainSecret()` とツール定義の既存マスカーで保護し、応答・履歴・ログ・health・サンドボックスへ渡さない。保存時の暗号化と master key の制約は [secrets.md](secrets.md#アプリ-db-に保存する-apiキーと-webhook-url) のまま。
- 設定 → コンテンツ生成の音楽（BGM）（`/settings/content/bgm`）は、画像・音声と同じ「設定の要約（固定モデルの読取専用 1 行と証拠）/ 設定に反映しない試行 / 直近の結果」で出す。履歴は専用の履歴タブ（`/settings/content/history`）が全種別をまとめて見る。モデル仕様の尺、課金、promptの外部送信、無保証の条件を説明し、モデル選択・尺・BPM・ループの入力は置かない（その理由と範囲は [試行（設定画面）](#試行設定画面) を正とする）。
- `GET /api/settings/content` と既存の設定変更応答の `bgm` は表示専用。キー未設定ならmodelはnull。DTOの正は `server/src/schema.ts`、値の解決は `server/src/bgm.ts`。取得では生成APIを呼ばない。

## 入力・保存・再生

引数は `prompt` と任意のcwd相対 `path` だけ。BPM・voice・duration・seedや生のproviderオプションは受け付けない。promptの空白のみ・長さ、パスの拡張子・字句境界・空白と制御文字・隠しbasename・長さは送信前に検証する。数値と拒否ケースの正は `server/src/bgm.ts` / `server/src/bgm-tools.ts` と `server/test/bgm-tools.test.ts`。試行サーバーも BGM は 1,000 字で止める（一般の 4,000 字より厳しく、チャットのツールと同じ）。

既定先は `generated/`、拡張子省略はMP3を補う。`parseToolPath()` / `rootRelativeDir()` / `cwdRelativePath()` と既存uploadの親作成・一時ファイル・非上書きを使い、同名はsuffix付きの新規ファイルにする。root外symlinkは拒否し、root内symlinkのcwdは既存どおり字句的に扱う（cwd専用の新しい隔離は追加しない）。保存結果の実パスとモデルを結果本文の先頭の改行終端した行へ置き、履歴の投影後も同じパスを参照する。

成功カードは既存の音声プレイヤー・URL解決・版・MP3配信・Rangeを使う。BGMラベル、モデル、実保存パス、captionを出し、TTSのvoiceは出さない。複数BGM / TTS混在、ライブ / 履歴を同じ結果本文で扱う。自動再生しない。再生・停止・シーク・復元では生成要求を送らず、失敗カードにプレイヤーを出さない。[既存プレイヤーの制限](speech-generation.md#既知の制限) は引き継ぐ。

## C2PA マニフェスト

実 API 受入で得た MP3 の ID3 には、GEOB フレーム（`application/c2pa`）に入った C2PA マニフェストが含まれていた（確認できた生成物は 1 件）。アプリはマニフェストを解釈しないが、**保存から配信までバイトをそのまま残す**。

- チャットの `generate_bgm` は生成器が返したバイトをそのまま upload する（`server/src/bgm-tools.ts`）。保存前の確認（`assertBgmMp3` のヘッダ走査）は読むだけで、タグもオーディオも書き換えない
- 試行も同じバイトを成果物として書く（`server/src/content-trial-artifacts.ts` の `prepareTrialBgmArtifact`）。宣言 MIME は固定の `audio/mpeg` で、実バイトは許可リストの判定にだけ使う
- 配信は保存済みファイルを中継するだけ。チャットの再生は `/api/files/raw`、ダウンロードは `/api/files/download`（`server/src/routes/files.ts`）で、BFF はサンドボックスの本文と `Content-Type` / `Content-Disposition` / `Content-Length` をそのまま返す。試行の raw（`/api/settings/content/trials/:id/raw`、`server/src/routes/content.ts`）も同じで、`?download=1` は `Content-Disposition` を足すだけ、`Range` は範囲を切り出すだけ
- 再エンコード・タグの書き換え・マニフェストの除去や再付与はしない。音声処理の依存を持たない（[非ゴール](#非ゴール)）うえ、いずれもマニフェストを壊す経路になる

## 試行（設定画面）

設定 → コンテンツ生成の BGM タブは、画像・音声と同じ試行 API（`POST /api/settings/content/trials` の `kind: "bgm"`）を使う（ジョブ・履歴・成果物・再照合の契約は [api-settings.md](api-settings.md#試行ジョブ)）。BGM 固有の差分だけをここに書く。

- 入力は prompt だけで、履歴に残るスナップショットも prompt と固定モデル。単価もボイスも尺も持たないため、音声の `voice` / `instructions` / `speed` は受け付けない（付ければ 400）。
- モデルは固定（`BGM_MODEL`）で、それ以外の値は 400。BGM のカタログは持たない。画面側も選択肢を出さず、保存される設定は読取専用の 1 行と証拠だけにする（モデル選択・尺 / BPM / ループ指定は Issue の非ゴール）。
- 期限内（`BGM_TIMEOUT_MS`）と中断は試行側が被せ、失敗は `provider-failure` の分類へ写す。生成器は HTTP 状態を構造（`BgmGenerationError.status`）で返し、分類は `classifyBgmFailure` が 1 箇所で行う。チャットのツールは同じ生成器の文言をそのまま使う（ツールのエラー文言は変えない）。
- **同時実行は `BGM_MAX_CONCURRENT` をチャットの `generate_bgm` と共有する**（試行用の別枠を足さない）。試行は開始時に枠を取り、provider の呼び出しが終わるまで返さない。枠が無いときは行を作らず 409 で止め、チャット側の生成も同じ枠を数える。プロセスの再起動で枠は失われるが、試行の `running` は起動時の再照合で `interrupted` に倒れる。
- 成果物は保存済みの MP3 だけで、許可リストは `bgm: ["mp3"]`。生成器が形式を宣言しないため、宣言 MIME は固定の `audio/mpeg` とし、実バイトが MP3 として読めることを**保存の前に**確かめる（wav は保存しない）。配信は trial id だけの raw ルートで、音声の再生・シークのため単一 `Range`（206 / 416）に従う。
- 同じ prompt とモデルの保存済み成功があり、現在のキー世代で成果物ファイルが残っているときは provider を呼ばず 200 で返す（課金しない。履歴の [もう一度生成] は `force: true` で保存済み結果を無視する）。
- 生成タブは「試行する / 中断」、直近の結果（プレイヤー・固定モデル・モデル仕様の目安尺と実測尺・所要時間・送った prompt とコピー・ダウンロード・削除）、証拠の 1 行で構成する。履歴タブは全種別の一覧と詳細で、BGM の行も同じ詳細（プレイヤー・prompt の全文・パラメータ・[この内容で生成] / [もう一度生成] / [削除]）を使う。BGM 固有の差は入力が prompt だけ・詳細にモデルを出さず実測の尺を出すことだけにする（[画像生成](image-generation.md#設定画面)）。失敗・中断・タイムアウトで課金されうることは、共通の注記で伝える。実測尺はブラウザーが `<audio>` のメタデータから読めた秒数だけで、読めるまでは `—` にする（目安尺と混ぜない）。
- 未設定 / 全体 OFF / runtime 不可でも、保存済みの履歴と再生は残して新規生成だけを止める（画像・音声と同じ文言）。タブの印（実行中 / 新着 / 同期未確認）も同じ規則で、BGM の生成タブは BGM の試行だけを出し、履歴タブは全種別をまとめて出す。
- **実 API 受入済み（2026-11-03）のため、BGM タブの試行の面の「試験的」は表示しない。** 受入では Lyria の実 API で 1 回の BGM 生成（MP3 / 実測 30.77 秒 / 生成 12.9 秒）が成功し、ブラウザーで再生・シークできた。音声は [speech-generation.md](speech-generation.md)、画像は既存試行で確認した。料金はユーザーが許容と判断した。残る未確認は [検証と実 API 受入](#検証と実api受入) に書く。

## 失敗とリソース境界

期限は生成開始からupload応答本文の読取までの絶対期限で、keep-aliveや保存開始では延長しない。試行は upload を持たないため、同じ `BGM_TIMEOUT_MS` を生成の呼び出しだけに掛ける。プロセス内の枠は生成・保存の成功 / 失敗 / 中断まで保持し（試行も同じ枠を同じだけの期間だけ握る）、超過は送信前エラー（キューなし）。各数値の正は `BGM_TIMEOUT_MS` / `BGM_MAX_CONCURRENT` / `BGM_LIMITS`（`server/src/bgm.ts`）。providerの保証値ではなくアプリ側の初期値で、実APIで通常クリップに不足したと分かった場合だけ理由を記録して調整する。

音声・SSEイベント（未完了も含む）・総受信・非2xx本文を上限付きでメモリに保持する。壊れたJSON / Base64、空音声、複数track、途中EOF、異常終端、refusal、200内errorではuploadしない。MP3の最小ヘッダ確認は完全デコードや修復ではない。正常終端後だけuploadし、直接ディスク書込・spool・途中公開はしない。全終了経路でreader、接続、タイマー、listener、枠を解放する。providerメッセージはマスク後に長さを制限する。

自動リトライ・形式フォールバックはしない。送信後の中断・期限・上限・保存失敗は課金の可能性を伝え、**明示的な再依頼なしに再生成しない**。保存確定と中断が競合しても確定済みファイルを削除しない。未課金と示せるのはAPI未送信の場合だけで、providerの処理停止・返金・内部再試行の回数は保証しない。

## 検証と実API受入

自動テストはダミーキー・stub fetch・fake workspaceと一時サンドボックスのみ。入口は `server/test/bgm.test.ts` / `server/test/bgm-tools.test.ts`（生成器の契約と分類・共有枠）、`server/test/content-trials.test.ts` / `server/test/content-trials-api.test.ts`（`kind: "bgm"` の開始 / 成功 / storage 失敗 / 中断 / 再照合、枠の共有、同一入力の再利用、raw の MIME と Range。**再利用の分岐（キー世代・成果物の欠損・`force`）は画像のケースで固定する**）、`server/test/content-trial-artifacts.test.ts`（mp3 の許可リストと保存前の拒否）、設定DTOは `server/test/content-settings.test.ts` / `server/test/content-settings-api.test.ts`、チャットは `client/test/bgm.test.ts`、設定面は `client/test/contentTrials.test.ts` / `client/test/contentSettingsTab.test.ts` / `client/test/contentSettingsPage.test.ts`。全体は [verification.md](verification.md) の `pnpm check`。GUIは [testing.md](testing.md#bgmの課金なし受入) の安全なfixtureで別に確認する。

BGM タブの GUI 受入（試行・再生・履歴・削除・容量・タブの印）は実 API 受入で確認済み（2026-11-03）。fixture の合成 MP3 での GUI 受入は別途（未実施）で、Lyria の実契約・実生成物の確認としては扱わない。

実 API 受入で確認したもの: voice を送らずに 200 / `audio/mpeg`、正常終端、ブラウザーでの再生・シーク、生成 12.9 秒、実測 30.77 秒、ピーク 0.0 dB、料金はユーザーが許容。残る未確認: 2 回目以降の再現性、失敗系（invalid_key / 402 / 429 / timeout）の実分類、チャットツール `generate_bgm` / `generate_speech` の実 API 経路、聴感品質の一般化、C2PA マニフェストの中身（[C2PA マニフェスト](#c2pa-マニフェスト) は保持する方針だけを固定した）。試行ライフサイクルと pcm 400 再試行はログに出る。

この受入で生成したのは BGM と音声 1 回ずつ（BGM は MP3 / 30.77 秒、音声は WAV / 12.28 秒）で、確認できたのは各形式 1 回の成功だけ。再現性・失敗系・聴感品質の一般化はせず、受入の成功を他の prompt / モデルへ広げない。料金 / usage の扱いはこの docs の範囲外で、別の変更で扱う。

BGM の生成物はピーク 0.0 dB だった。聴感で問題が無いと判断したため、正規化・リミッター・音量の補正は入れない（再エンコードは [非ゴール](#非ゴール) で、[C2PA マニフェスト](#c2pa-マニフェスト) を壊す経路でもある）。観測は n=1 なので、他の prompt やモデルでも同じピークになるとは扱わない。

## 非ゴール

他モデル・モデル選択（設定画面の試行でも選ばせない）、歌詞 / 歌声 / 効果音、長尺ジョブ、厳密なBPM / 尺 / 無声 / シームレスループ（試行の入力にも置かない）、再エンコード・連結、ffmpegの導入、C2PA マニフェストの解析・検証・表示（検証は外部ツールの仕事）、音量の正規化・リミッター、チャット向けの専用の再生 / ダウンロードAPI（試行の成果物は [試行ジョブ](api-settings.md#試行ジョブ) の raw ルートで配信する）、固定名上書き、自動削除・復旧UI、永続冪等性や厳密な重複課金防止は扱わない。生成物の商用利用可否・権利の独占性は保証せず、providerの利用条件に従う。
