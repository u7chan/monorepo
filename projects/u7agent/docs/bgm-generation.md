# BGM生成（generate_bgm）

チャットから新しいインストゥルメンタルBGMを依頼し、MP3をセッションの作業フォルダへ保存する。逐語読み上げの [TTS](speech-generation.md) とは別のツールで、会話モデルは変えない。生成はBFFからOpenRouterへ要求し、正常に受信した音声の保存だけを既存のサンドボックスuploadへ委譲する。

## API確認の状態

**実APIの受入は未実施。ユーザーの「PR収束してから実際にAPIキーで試す」という運用に従い、実キーの探索・読取・課金APIへの送信は行っていない。要求とLyria固有のSSE契約は暫定であり、通常生成が実証済みとは扱わない。**

公開資料を2026-10-23に調査した根拠は次のとおり。

- [OpenRouterモデルページ](https://openrouter.ai/google/lyria-3-clip-preview) は音声出力と30秒クリップを説明し、参照価格を $0.04 / clip としている。料金保証ではなく、トークン単価から無料とも判断しない。
- [Googleモデル仕様](https://ai.google.dev/gemini-api/docs/models/lyria-3-clip-preview) はMP3の出力を説明する。ただしGoogle直結の契約をOpenRouterの要求へ読み替えない。
- [OpenRouter Audio](https://openrouter.ai/docs/guides/overview/multimodal/audio) は `modalities: ["text", "audio"]`、`audio.format`、`stream: true` と `choices[].delta.audio.data` を説明する。voiceはモデル依存で、**Lyriaでの省略可否とBase64の境界・paddingは、この説明だけでは確定しない**。
- [OpenRouter Streaming](https://openrouter.ai/docs/api/reference/streaming) はコメントのkeep-alive、`[DONE]`、usageフレームによる同じ `finish_reason` の再掲、HTTP 200内の `error` を説明する。

送信先は `POST https://openrouter.ai/api/v1/chat/completions`。固定モデル、userのテキストprompt、上記modalities、`audio: { format: "mp3" }`、streamを送り、BFFがinstrumental / no vocals指示を補う。**TTS voiceを推測指定せず、Google直結や別形式へのフォールバックもしない。**

暫定の受信範囲は、1 choice / 1 audio track、各 `delta.audio.data` が**独立してcanonical Base64へデコードできるイベント**、`finish_reason: "stop"` の後の `[DONE]`。track idがあれば全イベントで同じ値だけを許す。text / transcript / usageは音声に混ぜない。usageの同じstop再掲と空choicesのusageも受け付ける。継続Base64列、複数音声、未知の終端へ推測で対応しない。

`server/test/fixtures/bgm-sse.ts` は**手書きの合成stubで、実レスポンス由来ではない**。含む最小MP3ヘッダもブラウザー再生可能な音声を示すものではない。実API確認後は、キー・個人情報・生の音声Base64を含めず、確認したフィールドと境界だけをfixtureへ反映する。

## キー・公開ゲート・設定

- `content_settings.apiKey` を画像・TTSと共有する。会話モデルの認証とは別管理。BGM専用キー、DB列、カタログ、新規保存APIは持たない。
- 公開条件はコンテンツ生成のゲート（キーの行と `enabled`）とエージェントの `toolNames` の積。登録名・定義・カタログは同じ判定にし、公開時だけBGM用promptを追加する。調査子セッションや `PI_AGENT_TOOLS` のremoteには追加しない。有効 / 無効は画像・TTSと共通の1つで、BGMだけを止めるトグルは持たない。
- 公開状態はセッション作成・復元時に固定する。キー後付けは新しい会話から。実行時は `ContentGenerationConfig.readBgm()` で現在キーを読み、回転へ追随し、削除後に始める生成は送信前に止める。設定でOFFにした場合も `readEnabled()` を実行のたびに見て、送信前に固定文言で止める。
- キーは `retainSecret()` とツール定義の既存マスカーで保護し、応答・履歴・ログ・health・サンドボックスへ渡さない。SQLite平文保存の制約は [secrets.md](secrets.md) のまま。
- 設定 → コンテンツ生成の音楽（BGM）（`/settings/content/bgm`）は固定モデルの読取専用面。モデル仕様の尺、課金、promptの外部送信、無保証の条件を説明し、お試し生成ボタンは作らない。
- `GET /api/settings/content` と既存の設定変更応答の `bgm` は表示専用。キー未設定ならmodelはnull。DTOの正は `server/src/schema.ts`、値の解決は `server/src/bgm.ts`。取得では生成APIを呼ばない。

## 入力・保存・再生

引数は `prompt` と任意のcwd相対 `path` だけ。BPM・voice・duration・seedや生のproviderオプションは受け付けない。promptの空白のみ・長さ、パスの拡張子・字句境界・空白と制御文字・隠しbasename・長さは送信前に検証する。数値と拒否ケースの正は `server/src/bgm.ts` / `server/src/bgm-tools.ts` と `server/test/bgm-tools.test.ts`。

既定先は `generated/`、拡張子省略はMP3を補う。`parseToolPath()` / `rootRelativeDir()` / `cwdRelativePath()` と既存uploadの親作成・一時ファイル・非上書きを使い、同名はsuffix付きの新規ファイルにする。root外symlinkは拒否し、root内symlinkのcwdは既存どおり字句的に扱う（cwd専用の新しい隔離は追加しない）。保存結果の実パスとモデルを結果本文の先頭の改行終端した行へ置き、履歴の投影後も同じパスを参照する。

成功カードは既存の音声プレイヤー・URL解決・版・MP3配信・Rangeを使う。BGMラベル、モデル、実保存パス、captionを出し、TTSのvoiceは出さない。複数BGM / TTS混在、ライブ / 履歴を同じ結果本文で扱う。自動再生しない。再生・停止・シーク・復元では生成要求を送らず、失敗カードにプレイヤーを出さない。[既存プレイヤーの制限](speech-generation.md#既知の制限) は引き継ぐ。

## 失敗とリソース境界

期限は生成開始からupload応答本文の読取までの絶対期限で、keep-aliveや保存開始では延長しない。プロセス内の枠は生成・保存の成功 / 失敗 / 中断まで保持し、超過は送信前エラー（キューなし）。各数値の正は `BGM_TIMEOUT_MS` / `BGM_MAX_CONCURRENT` / `BGM_LIMITS`（`server/src/bgm.ts`）。providerの保証値ではなくアプリ側の初期値で、実APIで通常クリップに不足したと分かった場合だけ理由を記録して調整する。

音声・SSEイベント（未完了も含む）・総受信・非2xx本文を上限付きでメモリに保持する。壊れたJSON / Base64、空音声、複数track、途中EOF、異常終端、refusal、200内errorではuploadしない。MP3の最小ヘッダ確認は完全デコードや修復ではない。正常終端後だけuploadし、直接ディスク書込・spool・途中公開はしない。全終了経路でreader、接続、タイマー、listener、枠を解放する。providerメッセージはマスク後に長さを制限する。

自動リトライ・形式フォールバックはしない。送信後の中断・期限・上限・保存失敗は課金の可能性を伝え、**明示的な再依頼なしに再生成しない**。保存確定と中断が競合しても確定済みファイルを削除しない。未課金と示せるのはAPI未送信の場合だけで、providerの処理停止・返金・内部再試行の回数は保証しない。

## 検証と実APIの保留項目

自動テストはダミーキー・stub fetch・fake workspaceと一時サンドボックスのみ。入口は `server/test/bgm.test.ts` / `server/test/bgm-tools.test.ts`、設定DTOは `server/test/content-settings.test.ts` / `server/test/content-settings-api.test.ts`、チャットは `client/test/bgm.test.ts`、設定面は `client/test/contentSettingsPage.test.ts`。全体は [verification.md](verification.md) の `pnpm check`。GUIは [testing.md](testing.md#bgmの課金なし受入) の安全なfixtureで別に確認する。

実API受入はユーザー待ち: Lyriaの要求（voice省略可否を含む）、音声フィールドとBase64境界・padding、正常終端・usage・200内error、生成MP3のブラウザー再生、生成時間・実測の尺・料金。PRの自動検証や合成音声のGUI確認を、これらの実証の代わりにはしない。

## 非ゴール

他モデル・モデル選択、歌詞 / 歌声 / 効果音、長尺ジョブ、厳密なBPM / 尺 / 無声 / シームレスループ、再エンコード・連結、ffmpegの導入、専用の再生 / ダウンロードAPI、固定名上書き、自動削除・復旧UI、永続冪等性や厳密な重複課金防止は扱わない。生成物の商用利用可否・権利の独占性は保証せず、providerの利用条件に従う。
