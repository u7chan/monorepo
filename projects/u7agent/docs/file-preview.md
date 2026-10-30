# ファイルプレビューの表示（行番号 / シンタックスハイライト / HTML・Markdown 描画 / 画像・音声）

ファイル画面（`FileTreePage` / `SessionFilesPanel` / スキル設定のファイルタブ → `FileBrowser` → `FilePreview`）の本文は、`GET /api/files/preview` で取得したプレーンテキストを表示用に整えて出す。HTML は `GET /api/files/html/<root 相対>` を iframe で描画し、Markdown は同じ本文をチャットと共通の `MarkdownView` で描画し、画像 / 音声は `GET /api/files/raw` を `<img>` / `<audio>` で読む。整形は `client/src/lib/fileCode.ts` の純関数、Markdown の相対パスは `client/src/lib/markdownAsset.ts`、タブと表示モードは `client/src/lib/fileTabs.ts`、描画は `client/src/components/FilePreview.tsx` が担う。タブと本文のキャッシュは [api-files.md](api-files.md#テキストプレビュー) を参照する。

ツリーの表示は [file-tree.md](file-tree.md)、行の操作は [file-actions.md](file-actions.md) を参照する。

## 原則

1. **ソース表示の転送はプレーンテキストのまま**: 行番号も色も表示側の都合で、API / DTO / サンドボックスは変えない。Markdown も取得したテキストをクライアントだけで描画する（サーバーに整形を持たせない）。HTML は別ルートの応答を iframe で描画し、画像 / 音声は raw の応答を `<img>` / `<audio>` で読む（原則 5）。
2. **外部ライブラリを足さない**: 色付けはチャット本文と同じ `lib/markdown/highlight.ts` のトークナイザを使う（対応言語は [markdown.md](markdown.md)）。ファイル用の別実装を持たない。
3. **DOM 文字列を作らない**: `innerHTML` / `dangerouslySetInnerHTML` / インライン `style` を使わない（本番の CSP は `style-src 'self'`）。行番号もクラスと CSS だけで出す。`client/test/filePreviewSafety.test.ts` の限定的な安全性検査で補助する（[検査範囲](testing.md#残す限定的な検査)）。
4. **行番号と本文を 1 対 1 にする**: 番号の列は本文と同じ行送りで重ね、行数は本文から数える。ブラウザーの末尾改行の扱いに依存させない。
5. **HTML の描画は応答ヘッダと iframe 属性で隔離する**: iframe の src は `GET /api/files/html/<root 相対>` で、既定はストレージ有効モードの別オリジン（別リスナー）、パス行のスイッチでアプリと同一オリジンの隔離へ戻せる（後述）。同じルートが文書と相対アセット（画像 / テキスト）を配るが、拡張子ごとに CSP / Content-Type を分ける。クライアント内で HTML 文字列を iframe へ流す方法（`srcdoc` / Blob URL / `data:` URL）は、親の CSP を継承してインライン style / script が動かないため使わない。

## パイプライン

```
FilePreview                 取得した本文をタブごとに保持（表示中のタブだけ取得・変換する）
  ├─ ソース表示
  │    └─ buildPreviewCode  text + path → PreviewCode      lib/fileCode.ts
  │          ├─ previewLang 拡張子 / ファイル名 → 言語
  │          ├─ 正規化      CRLF・CR → LF、末尾の空行を落とす
  │          └─ highlightCode 言語別のトークン列            lib/markdown/highlight.ts
  │    └─ 描画              行番号の列 + 本文の <pre>       components/FilePreview.tsx
  └─ Markdown プレビュー
       └─ MarkdownView      text → MdBlock[]               components/markdown/MarkdownView.tsx
             └─ 画像 src    dir 相対 → root 相対 → raw URL lib/markdownAsset.ts
```

ソース表示の変換は表示中のタブの本文について `useMemo` で 1 回だけ行う。タブごとに変換結果を持つと 1 タブ 3 MB 級になるため、切り替えると変換し直す（上限内のファイルでは数十 ms）。Markdown のプレビュー中はソース用の変換（ハイライト）を走らせず、取得した本文をそのまま `MarkdownView` へ渡す。

## タブ

タブバーは開いた順に並べて横スクロールし（タブが増えても行の高さと本文の幅を変えない）、同時に開けるのは `FILE_TAB_LIMIT`（8 枚。9 枚目を開くと最も古いタブを落とす）。選択は並びを変えず、表示中のタブを閉じたときだけ右隣 → 左隣 → 全消去へ繰り上がる（`closeFileTab`。削除とリネームの張り替えも同じ規則を使う）。

- 閉じる導線はタブの右端の `×` と、**PC のホイール押し込みによる中クリック**の 2 つ。中クリックはタブの箱（ラベル / `×` のどちらの上でも）で受け、表示中でないタブを閉じても表示は動かさない（`closeFileTab`）
- 中クリックは `auxclick` の `button === 1` だけを閉じる操作にし、同じ `mousedown` の既定動作（Windows のオートスクロール / Linux のペースト）は `preventDefault` で止める。既定動作は `auxclick` では止められず、止めないと閉じると同時にスクロールモードへ入る
- 中クリックを持たないタッチ端末では `×` だけが導線になるので、`×` は残す

## 全画面

パス行の右端の ⤢ で、プレビューを全画面の読み面へ切り替えられる（ツリーと高さを分け合う面では本文が数十行しか残らないため）。

- **dialog は常に同じ位置に置き、`showModal()` / `close()` だけで切り替える。** 面を portal や条件分岐で移すと React が要素を作り直し、HTML プレビューの iframe が文書を取り直して中の状態（スクロール・フォーム・JS）が消える。iframe のノードを別の親へ `appendChild` で移すだけでも Chromium は文書を読み直す（実測）ので、移す近道も使わない。外枠（タブ / パス行 / 本文）は同じ dialog の中に置いたまま。閉じる操作は標準の `Escape` と ⤢ に任せ、閉じたら開いたボタンへ焦点を戻す
- 閉じている間は `role="presentation"` にして `aria-label` と `tabindex` を外す（焦点可能な要素が残っていると読み上げは `presentation` を無視し、閉じたまま dialog の区切りとして出る。本文の名前は内側の `<section>` だけが持つ）。閉状態のレイアウトは `display: contents`（`client/src/styles/index.css` の `.file-preview-dialog:not([open])`）で、内側の `<section>` が親の flex にそのまま参加し、色も親から継承する。`display: block` にすると dialog が flex item になり、ツリーと高さを分け合えなくなる
- **全画面（退場アニメの間を含む）では `@2xl:` の段を当てない。** dialog をその場に置くと祖先の `@container` が一致するようになり、portal で作っていたときには付かなかった境界線が全画面の左上に出る
- 開いたまま別のタブへ切り替えても全画面は保つ（`FilePreview` の state なので、dialog の開閉で本文を取り直さない）
- `Escape` は dialog が開いているときだけ止める（設定ページの「一覧へ戻る」やチャット復帰へ届かせない）。閉じている間は止めないので、インライン表示のままでも同じ `Escape` が背面へ通る
- **狭い幅のシート（`SessionFilesPanel` の `files-sheet` = 外側 modal）の中で開いたときも、閉じるのは内側の全画面だけ。** 内側の `close` / `cancel` は React の合成イベントで祖先の dialog まで伝わるため、自分の分を祖先へ渡さず（`stopPropagation`）、シート側も自分の dialog のイベントだけを閉じる要求として受ける。`Escape` は内側 → 外側の順になり、焦点は内側を閉じるとシートの ⤢、シートを閉じると開いたボタンへ戻る。逆に**子孫の dialog（本文の Markdown 画像の拡大 = portal の dialog）の `close` / `cancel` は通す**（`event.target !== event.currentTarget` は素通しする。受けると拡大の標準の close を打ち消し、`Escape` で拡大が閉じなくなる。[markdown.md](markdown.md#画像の拡大表示)）
- **背景（backdrop）は透明にする**（`background: transparent` / `backdrop-filter: none`）。面が viewport を覆うので開き切れば見えないが、既定の暗幕（`--c-backdrop` 0.78 + blur）だと入り / 退場の途中だけ暗幕がよぎって黒い閃きに見える
- **開いたときの焦点は dialog 自身**（`tabIndex={-1}` + `focus()`）。`showModal()` に任せると先頭の操作（タブや表示切替）へ当たり、実機で意図しないボタンに飛ぶ。閉じたら開いたボタンへ戻す
- 出入りは `.viewer-dialog`（入り `viewer-in` / 退場 `viewer-out` + `data-closing`）で動かす。退場は `useExitPhase` が `animationend` まで dialog を開いたままにし、閉じ切ってから `close()` する（瞬時に消さない。`close()` は退場アニメの終了と同じ描画で行い、閉状態の寸法が 1 フレームだけ出るのを避ける）。`prefers-reduced-motion` では長さを 0.01ms にするだけで、開閉の順序は変えない
- `viewer-in` / `viewer-out` の付与は CSS の `[open]` に依存して SSR では観測できないため、自動テストでは固定せず手動の受入で確認する（[testing.md](testing.md)）

## 言語判定

拡張子を `highlight.ts` の `normalizeLang` に渡して決める（`ts` / `tsx` / `js` / `json` / `py` / `sh` / `css` / `html` / `c` / `cpp` / `go` / `rs` / `java` / `md` / `diff` など、エイリアスはトークナイザと共通）。拡張子を持たないファイルは `Dockerfile` だけ `bash` の規則で色を付ける。それ以外（`README`、`.gitignore`、`a.yaml` など）は素のテキストとして出す。

## 本文の正規化と行数

- `CRLF` / `CR` は `LF` に揃える（行末の CR を本文に残さない）
- 末尾の空行は落とす（本文からも行番号からも）。末尾の改行に行ボックスを作るかどうかは CSS の解釈に幅があるため、本文と行数を同じ文字列から数えて 1 対 1 を保証する
- 行数は残った本文の改行数 + 1。空のファイルは 0 行として「（空のファイル）」を出す

## 描画

- 行番号は本文とは別の列にし、本文と同じ `line-height` と上余白で重ねる（`client/src/styles/index.css` の `.file-code*`）。番号の文字列と行数はチャット本文と共通の `client/src/lib/codeLines.ts` が返す
- 番号の列は 1 から行数までを改行で繋いだ**1 つのテキストノード**にする。行ごとの要素も CSS カウンタも使わないため、番号のために行数分の DOM を積まない（素のテキストなら 4,000 行でも本文と番号の列で要素は 2 つ）
- 番号の列は横スクロールでも左端に残す（`position: sticky`）。下を本文が通るため背景は不透明（`--c-base`）にする
- 本文は折り返さない（`white-space: pre` と横スクロール）。番号は読み上げの対象にしない（`aria-hidden`）し、コピーにも入らない（`user-select: none`）
- 色を付けられなかったときも行番号は出す。理由はヘッダの `text · N 行` で示す（言語判定の結果ではなく、実際に色を付けた言語を出す）

## 読み込み中の表示

本文（ソース / Markdown プレビュー）とツリーの一覧が未取得の間は、`LoadingMark`（`client/src/components/LoadingMark.tsx`）を出す。見た目は `RunSpinnerIcon` のスピナーだけで、文字は出さない。

- **意味は読み上げ用のテキストで持つ**。スピナーは `aria-hidden` なので、両方消すと読み上げが空になる。`role="status"` の中に `sr-only` で「読み込み中…」を置き、見た目から文字を消しても読み上げは変えない
- 色は置いた場所のトークンに従う既定（`--c-ink-soft`）。非テキストの 3:1（WCAG 1.4.11）は 6 テーマすべてで満たす（最小 5.0:1）。動きを止める設定では弧が点のまま止まる（`RunSpinnerIcon` の共有の扱い）
- 画像 / 音声と、HTML のプレビューはアプリから本文を取得しないため、この印は出ない（`<img>` / `<audio>` / iframe の読み込みはブラウザーに任せる）。HTML もソース表示は本文を取得するので、届くまで他のテキストと同じくこの印が出る
- ツリーの行は `MessageRow` の中に置く。取得が終われば消え、失敗すれば同じ位置のエラー行に置き換わる（印のまま残らない）。開いた枝の入れ物（`.tree-fold`）は変わらないので、開閉の遷移にも影響しない

## コピー

ソース表示のパス行（`lang · N 行` の隣）に `CopyButton`（アイコンのみ、`aria-label` / `title` は `本文をコピー`）を常時出す。`reveal` を渡さないので、hover できる端末でも隠さずタッチ端末と同じ見え方にする。

- コピーするのは表示中の本文（`buildPreviewCode` の `text` を `previewCopyText` で取る）。行番号の列もハイライトの markup も含めない
- 本文は正規化後（CRLF / CR → LF、末尾の空行を落とす）なので、**クリップボードの内容は行末の CRLF / CR を LF に変え、末尾の空行を落とした分だけファイルの生バイトと違いうる**
- 空のファイル（空文字）/ 言語判定なし / トークン上限で素のテキストになった場合も同じボタンでコピーできる
- 成功表示は既存のコピーと同じ `useMessageCopy`（チェックアイコン + `コピーしました` を 2 秒）。失敗時は成功表示にしない
- コピーの経路は `client/src/lib/copyToClipboard.ts` が持つ。secure context では `navigator.clipboard.writeText`、それ以外（http の LAN IP など）と writeText が失敗したときは `document.execCommand("copy")` を **editable な textarea → readonly な textarea → contenteditable** の順に試す（画面外の配置と `readonly` が WebKit で通らないため。経路の根拠は [sandbox.md](sandbox.md#serveサービスの公開と起動停止)）
- 失敗時は、ボタンの横に `role="alert"` の小さな通知（`コピーできませんでした` + 試した経路の内訳）を出す。**成功と同じく、無反応にしない**のが目的で、内訳は iOS 実機のように開発者ツールを開けない環境で原因を切り分けるために画面へ出す（専用のデバッグ表示は作らない）
- 失敗の通知には、コピーする本文が画面に出ているコピー（メッセージ / コードブロック / ツールコール / ファイル・スキルの本文）では `選択` を添え、本文を選択状態にして長押し / Ctrl+C の手動コピーへ渡す（畳まれたツール履歴は選択が空になるため、選択の前に開く）。画面に出ていないコピー（診断情報 / 図のソース）では選択の導線を出さず、通知だけにする。行の ⋯ からのパスコピーもこれに当たり、通知は行の中に出る（[パスをコピー](file-actions.md#パスをコピー)）
- 失敗の通知はボタンごとの状態で、成功表示より長く残す（理由を読む時間を取る）。コピーをやり直すと消える
- 成功表示は表示中のタブ（`FileCopyButton` の key）に紐づけ、タブを切り替えたら捨てる。見えている本文が変わるため、戻っても表示を復帰させない
- 画像のプレビューには出さない。HTML / Markdown のプレビュー中も出さず、ソース表示へ切り替えてからコピーする（Markdown は本文を持っているが、行数とコピーはソース表示の機能としてそろえる）
- 2 MiB 超で本文を取得できないファイルは対象外（本文自体が無い。上限の値と変更手順は [上限](#上限)）
- 行番号付きコピー / 範囲指定コピーは持たない（持ち出しはツリーの行のダウンロードを使う。[ダウンロード](file-actions.md#ダウンロード)）

## 上限

| 上限 | 値 | 場所 | 決め方 |
| --- | --- | --- | --- |
| 本文の取得 | 2 MiB | `SANDBOX_MAX_PREVIEW_BYTES`（サンドボックス）/ `FilePreviewSchema`（BFF） | プレビューは本文を 1 本の JSON（`{ text }`）で返すため、サンドボックス・BFF・ブラウザー（タブごとに保持し同時 8 タブ）のメモリーと転送量が本文長に比例する。その入口を抑える値（セキュリティ境界ではない） |
| ハイライトする本文 | 256 KiB | `FILE_PREVIEW_MAX_LENGTH` | ハイライトの DOM コストで決める（本文の取得上限とは別。超えたら素のテキスト + 行番号で最後まで出す） |
| トークン数 | 2 万 | `FILE_PREVIEW_MAX_TOKENS` | トークン 1 つが DOM ノード 1 つになる。実測（dev / Chromium）で 232 KiB の TS（4.6 万トークン）の描画に 0.66 秒かかるため、その半分程度に収める |

上限でハイライトを落としても本文と行番号は出す（無言で消さない）。実測値の目安は、41 行の TS が 66 ms（色付き）、7,058 行 / 226 KiB の TS が 162 ms（トークン上限を超えるため素のテキスト + 行番号）。

### 上限の経緯

本文の取得上限はテキストプレビュー追加（#1386）のときに 256 KiB で置いた控えめな既定で、実測から決めた値ではない。単体 HTML の成果物（Three.js を埋め込んだゲームなど、およそ 680 KiB）が 256 KiB を超えてプレビューできなくなったため 2 MiB へ引き上げた。ハイライトの上限（`FILE_PREVIEW_MAX_LENGTH`）は据え置きで、上限内の本文は最後まで表示され、ハイライトだけが落ちる。

同じ値はテキストプレビュー以外に、HTML プレビューの iframe 文書と相対アセット（`.js` / `.css` / `.json` / `.txt`）、`/skill:` 展開でプロンプトへ入れる SKILL.md 本文にも掛かる（プロンプト長の上限ではない）。本文の取得上限を変えるときは、`SANDBOX_MAX_PREVIEW_BYTES`・`server/src/sandbox/service.ts` のエラー文言・`FilePreviewSchema` の `max`（UTF-16 単位。UTF-8 ではバイト数 ≥ 単位数なので同じ値でよい）・テストとドキュメントの表記を揃える。

## HTML プレビュー

この節の CSP / iframe 制約は BFF がファイルを配るプレビューに適用される。サンドボックスで serve してチャットの「サービス」から別タブで直接開くページには適用されない（[サービスの公開と起動・停止](sandbox.md#serveサービスの公開と起動停止)）。

`.html` / `.htm` のタブ（`isHtmlPath`）は、行番号付きのソース表示と iframe で描画したプレビューを切り替えられる（`client/src/components/FilePreview.tsx`）。

### 方式

描画は iframe の src に `GET /api/files/html/<root 相対>` を指定し、応答ヘッダと iframe 属性の両方で隔離する。同じルートが要求パスの拡張子で分岐し、文書と同じディレクトリを基準にした相対参照（`./cat.png` / `../app.css`）を解決できるようにする（`<base>` の注入はしない）。

同じルートは BFF の **2 つのリスナー**に載る。アプリと同じリスナー（待受は env `PORT`、既定 4317）は現行どおり隔離し、プレビュー専用リスナー（待受は env `PI_FILE_PREVIEW_LISTEN_PORT`、ブラウザから見たポートは env `PI_FILE_PREVIEW_PORT` で、既定はいずれも 4318。公開する配備は `<公開ポート>:<待受ポート>` の対応で公開し、公開ポート側を `PI_FILE_PREVIEW_PORT` へ渡す）は storage を有効にする。プレビュー オリジンに載せるのはこのルート 1 本だけで、書き込み系（削除 / rename / アップロード / セッション API）は載せない（有効モードの文書からアプリの面を叩けないようにする）。どちらのオリジンで開くかはクライアントのタブごとのスイッチで選び（**既定はプレビュー オリジン**）、リクエストにフラグは付けない。

| 要求 | 応答 |
| --- | --- |
| `.html` / `.htm` | 従来どおりの HTML 文書（CSP + sandbox 付き。本文は `workspace.previewFile()`） |
| 画像（`raw` の allowlist） | `workspace.rawFile()` を流用した生配信（`Content-Type` / `Content-Length` / `no-store` / `nosniff`） |
| 音声（`mp3` / `m4a` / `ogg` / `oga` / `wav` / `flac`） | 画像と同じく `workspace.rawFile()` の生配信（100 MiB 以下） |
| `.js` / `.mjs` / `.css` / `.json` / `.txt` | `workspace.previewFile()` を流用し、拡張子から Content-Type を付けて返す |
| それ以外（`.svg` を含む） | 400 `Not a servable asset: <path>` |

- 文書以外は CSP を付けず、Content-Type と `nosniff` で守る。`.svg` と HTML はアセットとして配らない（同一オリジンでスクリプトを動かさない）。動画 / フォントは対象外
- アセットの上限はテキストが 2 MiB（UTF-8）、画像 / 音声の raw が 100 MiB。超える `.js` / `.css` は 400、100 MiB 超の画像 / 音声は 413 になり、プレビューから読めない
- 音声は raw のストリームをそのまま返す（単一の `Range` / 206 / 416 を中継するので、シークで未バッファ位置へ飛んでも全体を取り直さない。契約は [api-files.md](api-files.md#画像配信raw)）
- `.json` は CSP に `connect-src` が無いため、現状のプレビュー内から読む手段が無い（`fetch` も classic script も不可）
- path はクライアントがセグメント単位で percent encoding する（`client/src/lib/fileUrl.ts`）。Hono 側（`:path{.+}`）は 1 回だけ decode する。文書 / アセット / エラー文書の分岐と応答ヘッダ（`Cache-Control: no-store` / `X-Content-Type-Options: nosniff`）は 2 つのオリジンで同じで、CORS ヘッダは付けない
- プレビュー オリジンは認証を持たない（アプリと同じ）。待受は env `PI_FILE_PREVIEW_LISTEN_PORT`（既定 4318）で、ポート使用中は BFF の起動が止まる（`scripts/dev.mjs` も同じ値の空きを先に確認する）。**待受とブラウザから見た値は独立で、ずれると iframe は繋がらない**ため、`pnpm dev` は `PI_FILE_PREVIEW_PORT` を正として両方を揃える（待受 env しか無いときはその値へ寄せる）

クライアント内で HTML 文字列を iframe へ流す方法（`srcdoc` / Blob URL / `data:` URL）は使わない。アプリの本番 CSP（`default-src 'self'; img-src 'self' data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'self' http://*:<プレビュー ポート>`）は `srcdoc` / `blob:` の iframe に継承され、インラインの style / script がブロックされるため描画できない（`frame-src` を明示した後は `blob:` / `data:` がこの一覧に含まれないため、フレーム自体も拒否される。`media-src` の `blob:` は設定 → コンテンツ生成のお試し再生用で、フレームの許可は広げない）。Chromium に本番相当の CSP を当てて確認済み。`frame-src` に `'self'` を残すのは、落とすとスイッチで別オリジンを OFF にした（隔離へ戻した）ときの同一オリジン フレームが拒否されるため。

### 隔離（CSP と sandbox）

CSP は `server/src/routes/files.ts` の `HTML_PREVIEW_POLICY` 1 箇所から導出する。既定は Lv2（`cdn`）で、`assets` / `inline` へ切り替えると読み込めるリソースだけが狭くなる（クライアントへポリシーは配らない）。`sandbox` 段はリスナーごとに固定し、**iframe 属性にも同じフラグを書く**（sandbox は禁止フラグの和集合なので、有効になる能力は積になる。片方だけ緩めてもオペークのままで storage は使えない）。

| オリジン | リスナー | CSP と iframe 属性の sandbox フラグ | 用途 |
| --- | --- | --- | --- |
| アプリ | 4317（env `PORT`） | `allow-scripts` | 隔離モード（スイッチで別オリジンを OFF にしたときだけ） |
| プレビュー | `PI_FILE_PREVIEW_LISTEN_PORT`（既定 4318。公開ポートは `PI_FILE_PREVIEW_PORT`） | `allow-scripts allow-same-origin allow-pointer-lock` | 既定のストレージ有効モード（`localStorage` など + ゲームの pointer lock） |

| 段階 | 追加で読み込めるもの |
| --- | --- |
| Lv0 `inline` | インラインの style / script、`data:` / `blob:` の画像・フォント・メディア |
| Lv1 `assets` | Lv0 + 同一オリジンの相対アセット（`'self'`） |
| Lv2 `cdn` | Lv1 + `https:` の外部 URL |

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline' 'self' https:;
  script-src 'unsafe-inline' 'self' https:; img-src data: blob: 'self' https:; font-src data: 'self' https:;
  media-src data: blob: 'self' https:; form-action 'none'
```

プレビュー オリジンはこの `sandbox` 段だけが `sandbox allow-scripts allow-same-origin allow-pointer-lock;` に変わる（読み込めるリソースの段階は同じ）。

- `connect-src` はどの段階にも無い。`fetch` / XHR は `default-src 'none'` にフォールバックして止まる
- アプリ オリジンの `sandbox allow-scripts` によりオペークオリジンになり、親 DOM へ触れない（`localStorage` / cookie は SecurityError）
- 有効モードの文書のオリジンはプレビュー オリジンになり、`localStorage` / `sessionStorage` / IndexedDB はそのオリジン（scheme + host + port）の保存領域へ入る。**アプリの storage とは分離される**が、同じオリジンを使う他のプレビューとは共有される（サーバーには保存しない）。**ポートを変えると保存領域も別になる**ので、`PI_FILE_PREVIEW_PORT=4319 pnpm dev` でプレビューだけ 4319 にした dev は既定の 4318 とは別の `localStorage` を見る（`pnpm dev` の並行起動にはサンドボックス / BFF / Vite のポートも別に要る。[frontend.md](frontend.md#開発フローと配信)）。cookie はオリジンではなくホスト単位で決まるため分離されない（後述の[できないこと](#できないこと残リスク)）
- iframe 属性は CSP と同じフラグを書く。スクリプトの有効 / 無効は切り替えない（クライアントの切替は ソース / プレビュー の 2 択 + 別オリジンの ON / OFF）
- 本文は 2 MiB のテキストとして取得する（`FilePreviewSchema` を通す）。サンドボックス側の API は増やさず、新規依存も足さない
- 200 の応答は文書 / アセットとも `Cache-Control: no-store` と `X-Content-Type-Options: nosniff` を付ける（文書は CSP も）
- 文書のエラーは iframe の中で読めるよう HTML 文書で返し（サンドボックス由来の文言はエスケープ）、この 2 つのヘッダも付ける。アセットのエラーはサブリソースに `text/html` を返さないよう JSON で返し、この 2 つのヘッダは付けない

### クライアントの振る舞い

- 既定はプレビュー。他の拡張子は従来どおりソース表示で、ソース / プレビュー の切替は HTML と Markdown のタブに出し、別オリジンのスイッチは HTML のタブにだけ出す
- iframe の src は `client/src/api.ts` の `fileHtmlPreviewUrl(path)` が組み立てるパス形式の URL で、path はセグメント単位で encode する（`client/src/lib/fileUrl.ts`）。ストレージ有効側の URL は `fileStoragePreviewUrl(path, port)` で組み立てる（`http://<location.hostname>:<port>` の別オリジン。`location.host` は使わない = dev はアプリが Vite の 3000 に居るため）。ポリシー（CSP の段階）はクライアントへ配らない
- パス行の別オリジンのスイッチ（`ToggleSwitch` の `size="sm"`。パス行の ソース / プレビュー と同じ高さに揃える）がタブごとの配信元を切り替える（`role="switch"` + `aria-checked`）。**既定は ON（別オリジン）**で、OFF にすると現行どおりの同一オリジン URL + `allow-scripts` へ戻る。切替は iframe の src が変わる = プレビューが再読み込みされる。`title` には押した結果を状態別に書き、OFF のときは「別オリジンで開き直し、localStorage などを使えるようにします」、ON のときは「アプリと同じオリジンで開き直し、localStorage などを使えなくします」にする
- ポートは health の `filePreviewPort`（ブラウザから見たポート）で受ける。未取得の間はスイッチを無効にし、client にポートを焼き込まない。既定が ON でもポートが無ければ隔離のまま開く（`aria-checked` も実体に合わせる）。`App` が health から受けて、ファイルを開ける面（設定 → ファイル / チャットの作業フォルダ面（右パネル / sheet）/ チャットのスキル面 / 設定 → スキルのファイルタブ）の `FileBrowser` へ prop で渡す（面ごとに health を取り直さない）
- 配信元の選択はタブごとに保持し、タブを閉じると既定（ストレージ有効）へ戻る（`previewOriginFor` / `withPreviewOrigin` / `dropClosedPreviewOrigins` / `renamePreviewOrigins`）。表示モードと違い**保存はしない**ので、F5 と タブを閉じて開き直すと既定（ON）から始まる
- **配信元の切替は iframe の `key` を変えて要素ごと作り直す**。Chromium はナビゲーション開始時の sandbox フラグで文書を作るため、同じ更新で `src` と `sandbox` を書き換えると古いフラグ（`allow-scripts`）のまま読み込まれ、後から属性を直しても再ナビゲーションされない（CSP の `sandbox allow-scripts allow-same-origin allow-pointer-lock` は要素側の制限を打ち消せない = 和集合）。sandbox 属性が変わらないタブ間の切替は作り直さない（`src` だけが変わり、フラグはそのまま正しい）
- 表示モードの選択もタブごとに保持し、タブを閉じると捨てる（`previewModeFor` / `withPreviewMode` / `dropClosedPreviewModes`）。state は `FileBrowser` が持つ。選択は「タブを閉じるまで」が条件で、「再読み込み」は `FilePreview` を remount して本文だけを捨てる（本文はタブごとに保持するが、選択は再取得では戻さない）
- プレビュー中はソース本文を取得しない（`lang · N 行` も本文のコピーもソース表示のときだけ出す）。Markdown は描画に本文を使うため、プレビューでも取得する（同じ本文をソース表示と共有し、切替で取り直さない）
- 「再読み込み」は `FilePreview` の remount（`FileBrowser` の `key` 差し替え）で iframe も取り直す（プレビュー用の追加実装は無い）

### 新しいタブで開く

HTML プレビューのパス行のアイコンボタンで、描画中の文書をブラウザの新しいタブで開く（`client/src/components/FilePreview.tsx` の `ExternalLinkIcon`。アイコンだけなので `aria-label` / `title` に `新しいタブで開く` を持つ）。

- `<a href target="_blank" rel="noreferrer noopener">` にする。`window.open` は使わない（ポップアップブロッカー / 中クリック / URL のコピーをブラウザの標準に任せる）
- 開く先は**常に別オリジンの `fileStoragePreviewUrl(fetchPath, filePreviewPort)`**（iframe と同じ `GET /api/files/html/<root 相対>`）。別タブを出す目的が `localStorage` を使えることなので、パス行の別オリジンのスイッチとは連動させない（OFF にしていても別タブはストレージ有効側で開く）。path を組み立て直さないのは、セグメント単位の encode と「相対参照を文書と同じディレクトリで解決する」前提を iframe と共有するため
- ポート未取得の間だけ同一オリジンの `fileHtmlPreviewUrl(fetchPath)` へ倒す（client にポートを焼き込まない）
- 出すのはプレビュー中だけ（`showHtml`）。ソース表示から開くと、見えている本文と違うもの（描画された文書）が出る
- 別タブの文書にもプレビュー オリジンの CSP（`sandbox allow-scripts allow-same-origin allow-pointer-lock`）がトップレベル文書として効く。オリジンが文書自身のものなので `localStorage` / `IndexedDB` / pointer lock が使え、iframe のストレージ有効モードと同じ保存領域を共有する（ゲームのセーブを別タブで続けられる）。`allow-modals` / `allow-downloads` / `allow-popups` は足していないため `alert` / `confirm` とダウンロードは動かない（`form-action 'none'` と `connect-src` 無しも iframe と同じ）。`rel="noreferrer noopener"` と合わせて、アプリ側の面へは触れない
- プレビュー オリジンへ到達できない環境では、新しいタブは接続できない（iframe は別オリジンを OFF にすれば隔離で表示できる。[できないこと](#できないこと残リスク)）

### できないこと（残リスク）

- 相対参照で読めるのは同じルートの allowlist に入ったアセット（画像 / 音声 / `.js` / `.mjs` / `.css` / `.json` / `.txt`）だけ。`.svg`、動画、フォント、他の拡張子は 400 になる
- テキスト（`.js` / `.css` など）は 2 MiB、画像 / 音声は 100 MiB が上限で、超えるとプレビューから読めない
- `<script type="module">` と動的 `import()` は隔離モード（別オリジン OFF）では読み込めない。オペークオリジンからの module 取得は CORS になり、BFF は CORS ヘッダを付けないため（classic script だけが動く）。既定のストレージ有効モードでは別オリジンの同じルートが `'self'` になるため読める（Lv0 `inline` は `script-src` に `'self'` が無いので、有効モードでも読めない）
- `localStorage` / `sessionStorage` / IndexedDB を読む HTML は既定（ストレージ有効モード）では使える。保存先はプレビュー オリジン = scheme + host + port の保存領域で、アプリの `u7agent-*` とは分離される（同じオリジンの他のプレビューとは共有される）。別オリジンを OFF にした**隔離モードでは動かない**（オペークオリジン）。`localStorage` の読み取りでは `SecurityError: Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.` が投げられる
- **ストレージ有効モードのままプレビュー オリジンへ到達できないと iframe は白くなる**（接続できないのでエラー文書も届かない）。アプリは到達性を確認せず、UI にも通知を出さない。dev で LAN / 別端末から使うときは `HOST=0.0.0.0` とブラウザから見たポートの到達（既定 4318。WSL2 なら portproxy の追加）が要る。別オリジンを OFF にすると隔離モードで表示できる（[frontend.md](frontend.md#開発フローと配信) / [README](../README.md#セキュリティ)）
- **cookie はポートでは分離されない**（RFC 6265 §8.5。cookie はオリジンではなくホスト単位で、`Path` が一致する非 HttpOnly cookie は有効モードの文書からも読み書きできる）。アプリと hostname を共用するため、有効モードのプレビューをアプリの cookie から隔離しない（アプリは現状 cookie を使わない。将来 cookie を足すときは同じホストで共有される前提で扱う）
- 別オリジンを OFF にした隔離モードでは、storage を使うインライン script の途中で例外が出るとその script の残りは実行されない（「JS が動かない」ように見える）。既定は ON なので、OFF にしたときだけ起きる
- `fetch` / `eval` / `new Worker` は使えない（CSP 違反。`connect-src` は足さない）
- プレビュー自身は外部 URL へ自己遷移できる（持ち出せるのは自分自身の内容だけ）
- 別オリジンの面が 1 つ増える（CORS ヘッダを付けず、`no-store` と CSP + sandbox で無害化する）。**無認証でワークスペースの allowlist ファイルを読める面が 1 つ増える**が、載るのは GET の HTML プレビュー ルート 1 本だけ（書き込み系は載せない）
- ストレージ有効モードはプレビュー オリジン 1 つを全プレビューで共有するため、同じオリジンの別ファイルの storage も読める（キー衝突は自己責任）。ファイルごとの名前空間を UI で誘導するのは将来の話
- ストレージ有効モードで読めるアセットは隔離モードと同じ allowlist のまま（`.wasm` / `.svg` / フォント / 動画は 400）

## Markdown プレビュー

`.md` / `.markdown` のタブ（`isMarkdownPath`）は、行番号付きのソース表示と描画したプレビューを切り替えられる。**既定はプレビュー**で、切替はパス行の ソース / プレビュー（HTML と共通の `SegmentedControl`。別オリジンのスイッチは出さない）。

- 描画はチャット本文と同じ `components/markdown/MarkdownView.tsx` に取得した本文を渡すだけにする。`MARKDOWN_MAX_LENGTH`（200 KB）超でプレーンテキストへ落ちるのもチャットと同じで、ファイル用の別実装を持たない。対応記法・解析の上限・テーマは [markdown.md](markdown.md) を正とする
- 本文は HTML と違い親が `GET /api/files/preview` で取得する（iframe が自分で取りに行く HTML / 画像とここが違う）。ソース表示へ切り替えても同じ本文を使い、取得し直さない
- 画像は**表示中のファイルのディレクトリ基準**で `GET /api/files/raw` の URL へ解決する（`client/src/lib/markdownAsset.ts` の `resolveMarkdownAssetPath` と `components/markdown/MarkdownImageRefs.tsx` の `MarkdownFileImageProvider`。チャット本文の cwd 基準の provider をこの部分木だけ差し替える）
  - 先頭の `/` はワークスペース root からの絶対パス、`..` はワークスペース root で止める（root の外へ出る src は解決しない）。ファイル名に無い `?` / `#` 以降は落とし、前後の空白は無視する
  - 解決できない src は入力をそのまま使う。Markdown 記法側の `safeUrl` が scheme 付き・`//`・空白付きを既に落とすため、描画される画像は同一オリジンの相対パスだけになる
  - 配信できる実体は raw の allowlist に従う（`.svg`・動画・フォントは 400 で表示できない）。URL に raw の版（`previewVersion`）を付けるので、「再読み込み」で画像も取り直す
- 読み幅はチャットと同じ `max-w-220` に収め、広い面では中央へ寄せる（横に長いコード・表・図はそれぞれの枠で横スクロールする）
- 本文の行数（`md · N 行`）とコピーはソース表示のときだけ出す（HTML と同じ扱い。コピーの正規化は [コピー](#コピー)）
- 相対リンク（`[t](./other.md)`）でワークスペースのファイルをタブとして開く導線は持たない（アプリの URL へ解決され、リンク切れになる）。外部 URL のリンクは従来どおり新しいタブで開く
- この面に `FileRefProvider` は無いため、プレビュー内のコードスパンは操作要素にならない（`<code>` のまま）
- ソース / プレビューの選択は HTML と同じくタブごとに保持し、タブを閉じると既定（プレビュー）へ戻る

## 画像プレビュー

画像（`png` / `jpg` / `jpeg` / `gif` / `webp` / `avif` / `bmp` / `ico`）の既定モードはプレビューで、`GET /api/files/raw` の URL を `<img>` の src にする（[api-files.md](api-files.md#画像配信raw)）。`GET /api/files/preview` はバイナリを 400 で拒否するため呼ばない（本文を取得しないので、待ちの印（`LoadingMark`）も行数も出さない）。

`FileBrowser` は `useImageVersion(reloadToken)` が返す `previewVersion` を、remount 用の `key` と `FilePreview` の prop の両方に渡す。画像 URL は `fileRawUrl(fetchPath, previewVersion)` で `v` query を付ける。同じ URL のまま remount しても、`no-store` にかかわらずブラウザの in-document 画像キャッシュが使われるため、URL 自体を変えて同一パスの差し替えを取り直す。

`previewVersion` は mount ごとに 0 へ戻すローカルカウンタではなく、[document 内の共有採番](api-files.md#画像配信raw)で得る版。手動再読み込みと run 終了では新しい版へ進み、パネルの開き直しや設定画面との往復でも過去の URL に戻らない。

- 配信は画像だけに制限し、SVG / HTML は allowlist 外として 400 になる（同一オリジンでスクリプトを実行させない）
- 表示は `object-contain` で親の幅・高さに合わせる。枠（`.image-canvas`）の中央（両軸）に置き、枠より大きい画像は `max-h-full` / `max-w-full` で枠に収める（スクロールで切れない）。ピクセル等倍の切替や拡大縮小の UI は持たない
- **画像の枠には高さの下限を置く。** 枠が 0 まで縮むと、枠の高さに追随する画像も見えなくなる（全画面を開けば見えるが、閉状態でも到達できる側を選ぶ）。下限の値はコードが持つ
- **プレビューの面は、与えられた高さで中身をクリップしない。** 外装が面に高さを与えない面（設定 → スキルのファイルタブなど）では、はみ出したまま祖先のスクロールで本文へ届く。**面の中でスクロールさせると、高さ 0 を与える外装でタブ・パス行・全画面の導線ごと閉じ込めて退避できなくなる**ため、クリップは面の側に持たせない
- **スクロールの所有者は、ブラウザへ高さを与える外装が持つ**（設定 → ファイル（/settings/files）のページ本文、作業環境の右パネル / singleColumn のシート）。ブラウザはその高さを保ち、本文が下限に収まらないぶんだけを外装がスクロールさせる（ツリーの内側スクロールは動かない）。面ごとに所有者を揃えるのは、クリップを面に戻すと上の退避導線を失うため
- **透過は本文の枠の市松で示す**（`styles/index.css` の `.image-canvas`）。色は `--c-soft` と `--c-ink` の `color-mix` で作り、6 テーマぶんの定義を足さずに追随する（1 タイル 16px = 8px 角）。市松は本文の枠いっぱいに敷き、画像の外側（`p-2` の余白）にも出る（VS Code などと同じ扱い。画像の箱の下だけに敷く案は、小さい透過画像で周囲が平らなままになるため採らない）。透明度の有無による出し分けはしない（判定に canvas の縮小が必要で、誤判定とモバイルのデコード負荷に見合わない）
- **パス行の右端に 寸法 · サイズ を出す**（例: `1536 × 1536 · 24.4 KB`）。寸法は `<img>` の `onLoad` の `naturalWidth` / `naturalHeight`（内在ピクセル。表示倍率は持たない）、サイズは `FileBrowser` がツリーの取得済みの行（`FileEntry.size`）から引いて `activeSize` で渡す。表記の組み立ては `client/src/lib/imageMeta.ts` の純関数で、**分かる項目だけを並べ、どちらも分からなければ行ごと出さない**
- サイズの取得に一覧を取り直さない（1 タブごとに余分な往復を作らない）。このため親ディレクトリが未取得の面（F5 で親を閉じていた場合、一覧の上限 500 件で載っていない場合）ではサイズが出ず、寸法だけになる。ツリーのサイズは「再読み込み」で画像本体と一緒に新しくなる（`invalidateFileTree` が取得済みの子を捨て、プレビューは `key` と raw URL の版を変えて取り直す）ため、表示中の画像とメタの鮮度は揃う
- 寸法は表示中のタブのものだけを出す（読み込み結果をパスと一緒に持ち、タブを切り替えたら前のタブの値を使わない）。メタは `shrink-0` で、幅が足りないぶんはパンくずの横スクロールが吸収する（singleColumn も同じ 1 行）
- 表示モードの切替は画像には出さない（ソース表示はバイナリなので意味が無い）。本文を取得しないので、コピーボタンも出さない
- 失敗したとき（404 / 400 / 画像以外の配信拒否）はブラウザーの読み込み失敗表示になる（`alt` は `<パス> のプレビュー`）。テキスト / HTML のようなアプリ側のエラー文言は出さない（タブは勝手に閉じない。`<img>` に `onError` を持たせるのは別 Issue）

## 音声プレビュー

音声（`mp3` / `m4a` / `ogg` / `oga` / `wav` / `flac`）の既定モードもプレビューで、画像と同じく `GET /api/files/raw` の URL を `<audio controls>` の src にする（[api-files.md](api-files.md#画像配信raw)）。`GET /api/files/preview` はバイナリを 400 で拒否するため呼ばない。音声の判定は画像の allowlist とは別に持ち、添付アップロードの制限と混ぜない。

- 音声はテキスト本文を取得しない（画像と同じ扱い）。本文を取りに行かないので、待ちの印（`LoadingMark`）も行数も本文取得のエラー帯もコピーボタンも出ない
- 再生 / シークの要求はブラウザーが `Range` を付けて送り、サーバーが単一レンジを 206 で返す。再生位置・音量・再生速度は保存しない（タブを閉じても再開位置を持たない）
- ソース / プレビューの切替は出さない（バイナリのソース表示に意味が無い）。パス行のメタも出さず、再生時間 / ビットレートは取得しない
- 再生できる形式はブラウザーのコーデックに依る（`flac` / `ogg` は環境により差が出る）。配信は allowlist にある限り 200 / 206 を返すため、再生できない形式は操作の失敗としてブラウザー側に出る（形式ごとに配信を絞る判断は未実施）

## テスト

方針と実ブラウザでの確認は [testing.md](testing.md)。具体的な CSS・component の配線名は固定しない。

| テスト | 固定すること |
| --- | --- |
| `client/test/fileCode.test.ts` | 拡張子の言語判定 / 正規化・行数・コピー本文 / 上限での fallback / HTML・Markdown の判定 / 例外を投げない |
| `client/test/filePreviewSafety.test.ts` | ソース本文の HTML 挿入・HTML パース・インライン style の禁止（限定的なソース走査） |
| `client/test/fileTabs.test.ts` | 表示モードの既定（HTML と Markdown と画像と音声だけプレビュー）/ 表示モードと配信元の選択の保持と破棄（配信元の既定は別オリジン = ストレージ有効）/ タブの開閉と上限 / ディレクトリ配下のタブの一括削除（接頭辞境界と繰り上がり）/ リネームの経路の張り替え（並び・表示中の保持、配下、重複の排除、表示モードと配信元）/ 保存値からの復元（表示中の繰り上がりと上限） |
| `client/test/toggleSwitch.test.ts` | 名前付きの role=switch / aria-checked / disabled / 実 handler の状態反転 |
| `client/test/filePreviewStorageMode.test.ts` | HTML の sandbox・配信元・切替の公開状態とポート未取得時の隔離 / srcdoc・blob・data 文書の禁止 / 別タブの noopener と操作名 / 画像の raw URL・メタ・HTML 用操作の非表示 / 音声の `<audio controls>`・raw URL・本文を取得しないこと（SSR） |
| `client/test/filePreviewMarkdown.test.ts` | Markdown のタブの既定（プレビュー）とソース / プレビューの公開状態 / 他拡張子に切替を出さないこと / HTML 用の操作を出さないこと / 描画した本文と dir 基準の画像 URL / 解決できない src の扱い（SSR） |
| `client/test/markdownAsset.test.ts` | 相対 src の解決（dir 基準 / `.` と空セグメントの畳み方 / `..` の往復と root 外の拒否 / 先頭 `/` / `?`・`#` の除去 / 前後の空白）と、外部 URL・fragment だけの不採用 |
| `client/test/imageRefresh.test.ts` | 実フックの同一 mount での再描画安定性・run 終了・手動更新 / 実 Markdown と FileBrowser → FilePreview の描画を通した面間・再 mount の URL 非衝突（SSR） |
| `client/test/imageMeta.test.ts` | 画像メタの表記（寸法とサイズの両方 / 片方だけ / どちらも無ければ null / 不正値の落とし方と 0 B） |
| `client/test/filePreviewTabClose.test.ts` | 中クリックの button 判定。タブの ×・中クリックの実操作はブラウザで確認 |
| `client/test/loadingMark.test.ts` | 待ちの印の公開状態（`role="status"` / スピナーは `aria-hidden` / 文字は `sr-only` の 1 箇所）と、本文待ち（ソース / Markdown プレビュー）とツリーの一覧待ちで出ること、本文を取得しない面（画像 / 音声 / HTML のプレビュー）では出ず、HTML のソース表示では出ること（SSR） |
| `client/test/fileTree.test.ts` | 開閉・子のマージ・エラー保持 / 親を閉じたときの全子孫の開閉（接頭辞境界、取得結果・loading・error の保持、後着した一覧で開きが復活しないこと）/ 削除した行だけを落として他を保つこと / 削除の confirm 文言（ファイル / 配下ごとのディレクトリ、画面の root 相対パス）/ ディレクトリ削除後の枝の prune（接頭辞境界と own プロパティ契約）/ リネームの prompt 文言と、親の行の名前差し替え・配下キーの張り替え・開閉と取得済みの子の保持（接頭辞境界・未取得の親・`__proto__`）/ 取得中のリネームで loading を落として新しいキーで取り直すこと（旧キーの応答で新キーを汚さない）/ 保存する展開の抽出と復元（root の初期化、閉じた子孫の除外、祖先がそろわない保存パスの正規化・順序非依存・`__proto__`、truncated）/ reveal の祖先（root から近い順・root 直下は空・同 object を返す条件・loading と子の保持・親を閉じた後の再展開・`__proto__`）/ パンくずの項目（root 相対の祖先とファイル）/ 取得済みの行の引き（未取得の親・一覧の上限外・前方一致・`__proto__`・再読み込み後） |
| `client/test/fileTreeReveal.test.ts` | パンくずの操作名 / root 相対の祖先とファイル / 全体パスの title / aria-current（SSR） |
| `client/test/fileRowMenu.test.ts` | 操作の採否・順序 / menu と menuitem の公開属性 / パスコピー失敗の通知の出し分け（行の中の `role="alert"`・内訳・選択の導線なし） / 位置・可視判定・キーボード移動の純関数 |
| `client/test/fileDownloadRow.test.ts` | 種類・symlink・除外名・readOnly ごとの操作の採否 / 確認文言とサイズ表記 |
| `client/test/archiveSettings.test.ts` | 除外名の下書きの純関数（実効値からの初期化と配列を共有しないこと / dirty の比較（未設定のまま既定を保存させない）/ 追加の trim・空・重複・上限 / 削除 / 検証（サーバーと同じ 1 セグメント名の規則と件数上限）） |
| `client/test/archiveExcludeSettings.test.ts` | 「ダウンロードの除外」タブの中身: 未設定・上書き・明示空・読み込み中・失敗（SSR）。HTTP は apiContracts で検査 |
| `client/test/filesSettingsPage.test.ts` | 設定 → ファイル のタブ / ヘッダ: 既定はファイルツリー、除外タブの説明・操作（保存可否）・note（SSR） |
| `client/test/sharedContentExclusions.test.ts` | 共有の除外名の検証（`index.html` の拒否 / 1 セグメント名の規則と件数上限はダウンロードの除外と同じ） |
| `client/test/sharedContentExclusionsTab.test.ts` | 設定 → 共有の「公開の除外」タブの中身: 公開だけの規則（対象ディレクトリ自身の名前 / `index.html`）・ダウンロードの除外への導線・未設定 / 上書き / 明示空 / 読み込み中 / 失敗（SSR） |
| `client/test/fileSkillPanel.test.ts` | ファイルタブの採否 / 組み込み本文の表示（SSR）。取得・タブ間の操作はブラウザで確認 |
| `client/test/fileRef.test.ts` | matcher の採否表（正規化と別表記の同ービキー / 制御文字 U+0000 / Unicode 空白 U+00A0・U+3000 / dotfile / scheme / `..` / 末尾ドット）と、cwd 相対の解決表（rootCwd 前置き / cwd 外 / rootCwd 未取得 / 明示的な相対 / cwd 未確定）、面つき解決（裸名の除外と、区切りを持つ字面の採用 / 共通スキルの絶対パス → `kind = "skill"` の root / path、補助ファイル、名前の境界、`.agents/skills` 直下・プロジェクトスキル・root 外の不採用、workspace 相対の現行維持、cwd 配下の作業フォルダ面優先 / 画像が使う matcher は裸名を採ること / 共通スキル配下のパス判定） |
| `client/test/fileMention.test.ts` | ドラッグの種類の判定 / 参照の引用とエスケープ / 挿入・カーソルの位置 / trim を通したパスの保持 |
| `client/test/fileRefRequest.test.ts` | 最新要求だけを保持 / 要求の種別と root / seq が一致する ack だけを消費 / 選択変更と sessionId の採否 / 面ごとの消費可否（作業フォルダ面がスキル要求を消費しない） / 種別からのモード決定 / セッション切替・画面の移動・layout 切替での既定への復帰 / 購読・解除 / 選択の切替世代（未消費が無くても clear で進み、request・ack では進まない）/ クリックの順序（実在を確認してから面を開く / A→B・A→B→A の逆転で最後のクリックだけが開く / セッション切替で失効（A→B→A で戻っても復活しない）/ 不存在では要求もモードも変えない / 拒否・確認不能の理由） |
| `client/test/fileRefOpen.test.ts` | 確認 API の status 分類（404 = 不存在 / 400 = 拒否 / 502・503・通信失敗 = 確認不能）/ 失敗理由の文言 / 確認先のパス写像（作業フォルダ面とスキル面）/ 確認の例外とセッション未確定で開かないこと / 切替世代をまたいだ結果の失効（A→B→A） |
| `client/test/markdownFileRef.test.ts` | 参照になる code だけ操作にする / 裸名・provider 外・cwd 外・リンク内の除外 / 引用・リスト・表での描画 / 共通スキルの絶対パスがスキル面の操作要素になり、操作名が種別で変わること（SSR） |
| `client/test/sessionSkillFiles.test.ts` | チャットのスキル面の外装（見出し / root / 戻る導線 / 閉じる導線）と、モードによる作業フォルダ面との出し分け（SSR）。行の操作は `fileRowMenu.test.ts` とブラウザ受入で確認する |
| `client/test/filePreviewState.test.ts` | 保存 schema の encode / decode / 検証と上限 / 壊れた入力の捨て方 / 他 cwd を消さない merge / read・write の例外とメモリ snapshot / 配信元（ストレージ有効モード）を保存しないこと |
| `client/test/sessionFiles.test.ts` | 右パネルの出し分け（desktop × チャット画面 × 作業フォルダあり） |
| `client/test/copyResult.test.ts` | コピー結果の controller: 所有者 (会話) の切替と unmount の invalidate をまたいで、deferred な成功 / 失敗を適用しないこと（A→B・A→B→A）/ 成功 2 秒・失敗 8 秒の表示と、切替でのタイマー破棄 |
| `client/test/sessionFilesPath.test.ts` | 帯のパスの分割（未所属の 2 段 / プロジェクトの 1 段 / 末尾の `/` / root `.` / 1 段だけ）/ 絶対パスの組み立て（root `.` は `rootCwd` そのまま・未取得は undefined）/ ⋯ の項目と disabled の理由（片方だけ・両方）/ 全 disabled で ⋯ を出さず理由を常設すること（SSR） |
| `client/test/chatReducer.test.ts` | `runEndSeq` が `run_end` と `running` を抜けた `resync` でだけ進むこと（同じバッチで届いた `run_start` / `run_end` でも 1 回、新規チャットでも戻らない） |
| `client/test/route.test.ts` | pathname と画面の対応（大文字・末尾スラッシュ・percent encoding・不正な入力の畳み方）と往復 |
| `client/test/fileUrl.test.ts` | パスのセグメント単位 encode（`#` / `?` / `%` / `+` / 日本語 / 1 回の decode で戻ること）/ `fileRawUrl` が version 指定時だけ `v` を付け、未指定時の URL を保つこと / `fileHtmlPreviewUrl` がクエリでなくパス形式で組み立てること / `fileStoragePreviewUrl` が hostname + ポートで別オリジンの URL を組み立てること |
| `client/test/filePreviewError.test.ts` | 共通スキル配下の `Path not found` にだけ補助文を出すこと（作業フォルダ側・接頭辞の別名・他のエラーでは出さない） |
| `server/test/file-stat.test.ts` | サンドボックスの `GET /v1/files/stat`（通常ファイル 200 と symlink の実パス / 本文を読まないためバイナリ・UTF-8 不正・上限超過も 200 / 不存在と壊れた symlink の 404 / ディレクトリ・root 自身・root 外・不正要求の 400 / 認証） |
| `server/test/files.test.ts` | HTML プレビューのポリシー定数（段階ごとの CSP / `connect-src` なし / リスナーごとの sandbox 段）/ `GET /api/files/html/<path>` の文書・画像・音声・テキストアセット・400 の分岐と percent decoding（音声は raw・テキストは preview の使い分けと動画 / フォントの 400 を含む）/ ヘッダ（CSP / `no-store` / `nosniff`）/ `previewApp` の storage 有効 CSP（文書は HTML・アセットは CSP 無しの JSON）とマウント範囲（HTML プレビュー ルートだけ）/ `GET /api/files/raw` が画像と音声を配り、`.svg` / `.html` / 動画 / テキストを 400 で拒むこと / `Range` の status・`Content-Range`・`Accept-Ranges` の中継（206 と 416）/ 文書は HTML・アセットは JSON のエラー写像 / `DELETE /api/files` の委譲（`recursive=true` は `deleteDirectory`）と 204・`recursive` の検証・エラー写像 / `POST /api/files/rename` の委譲と body 検証・エラー写像（409 の透過を含む）・契約外の応答の 502 / `GET /api/files/stat` の本文を取らない委譲と no-store・200 / 404 / 400 の透過・確認不能の 502 / 未設定の 503 |
| `server/test/file-preview-port.test.ts` | プレビュー オリジンのポート解決（待受とブラウザから見た値の既定はどちらも 4318 / 未設定は既定 / 1〜65535 の整数 / 不正値は throw して指定した env を名指しする / `pnpm dev` 用の統一（`PI_FILE_PREVIEW_PORT` が正・待受 env しか無いときはその値へ寄せる・空白だけは未設定）） |
| `server/test/dev-file-preview-port.test.ts` | `pnpm dev` が解決した 1 つの値を待受の空き確認と BFF の両 env（`PI_FILE_PREVIEW_PORT` / `PI_FILE_PREVIEW_LISTEN_PORT`）へ渡し、既定ポートを直書きしないこと（ソース走査） |
| `server/test/archive-rules.test.ts` | 既定の除外名（再生成物 / ビルド成果物 / `vendor` などを入れない）/ 上書きの解決（空配列は全解除・trim と重複の除去・呼び出し側の変更から既定を守る）/ 正規化（trim / 空落とし / 先勝ちの重複 / 順序と大文字小文字の保持）/ 検証（`.`・`..`・区切り・制御文字・200 文字超・100 件超）/ `GET /api/health` が実効値を返すこと |
| `server/test/archive-settings.test.ts` | 設定ストア（未設定 = 既定 / 保存の正規化と明示空 / リセットで行を消す / 検証エラーの 400 と非破壊 / DB 不可のフォールバックと 503）とルート（GET / PUT / DELETE の同じ形 / zod の 400 / 再起動後の保持 / DB 不可の 503）/ 整合（PUT の直後に health と download / check が同じ実効値を見る） |
| `server/test/zip-writer.test.ts` | ZIP ライタ（既知ベクタの CRC32 と分割入力 / store と deflate の選択 / UTF-8 名と bit 3・bit 11 / 空ファイル・空ディレクトリ / 複数チャンク / 途中失敗でストリームを失敗させる） |
| `server/test/sandbox-archive.test.ts` | `GET /v1/files/download` と `/check`（zip の中身と除外 / skipped の内容 / `exclude` の省略 = 既定と空値のみ = 除外なし / 繰り返しの一覧 / 不正名と 100 件超の 400 / 除外名のディレクトリの 400 / symlink の 400 と配下 symlink の除外 / 単体ファイルの生配信とヘッダ / root の zip / 空ディレクトリ / 末尾スラッシュ / 404・root 外 400・`..` の 400 / 上限 413 / 認証） |
| `server/test/file-download.test.ts` | BFF の `GET /api/files/download` と `/check`（ストリーム中継とヘッダ / `Content-Disposition` の透過 / `Content-Length` の有無 / 設定ストアの実効値を `exclude` の繰り返しで渡すこと（未設定 = 既定 / 明示空 = 空のまま）/ 400・404・413・502・503 の写像 / 契約外の check 応答の 502） |
| `server/test/sandbox-delete-dir.test.ts` | `DELETE /v1/dirs`（`recursive` の解釈 / 空ディレクトリ / 非空の 400 と部分削除なし / 配下ごとの削除と接頭辞境界 / パス形式と root 外・不存在・非ディレクトリ・symlink の 400・404 / 配下 symlink のリンクだけの削除 / 一覧上限外の子 / `__proto__` / 認証） |
| `server/test/sandbox-client.test.ts` | NDJSON / JSON 経路の写像と、`deleteDirectory` が `DELETE /v1/dirs?recursive=true` を呼び 204 の本文を読まないこと / `renameEntry` が `POST /v1/files/rename` を呼び、409 を文言ごと透過すること / `rawFile` が `Range` を付けて送り status・`Content-Range`・`Accept-Ranges` を中継すること（416 は例外にしない） |
| `server/test/sandbox-rename.test.ts` | `POST /v1/files/rename`（ファイル / ディレクトリの改名と応答パス / 大文字小文字だけの変更 / 同名 409 と変更なし / 不正な名前・パス形式の 400 / 不存在 404 / root 外 400 / symlink の 400 とリンク先の維持・symlink への上書きの 409 / symlink ディレクトリ経由 / 認証） |
| `server/test/static.test.ts` | SPA フォールバック（拡張子なしの画面 URL / `/api`・`/assets` の境界 / `Accept` / 未ビルド 503）と、アプリ CSP の `frame-src`（`'self'` + プレビュー オリジンのポート）と `media-src 'self' blob:`（お試し再生の blob URL） |

## 参照

- [ui-layout.md](ui-layout.md) — 本文の中でツリーとプレビューをどう並べるか
- [markdown.md](markdown.md) — 共有するトークナイザの対応言語・上限と、インラインコードをファイル参照の操作要素にする描画契約
- [api-files.md](api-files.md#テキストプレビュー) — プレビューの転送契約
- [api-files.md](api-files.md#html-プレビュー) — HTML プレビューのヘッダとエラー応答
- [api-files.md](api-files.md#ダウンロード) — ダウンロードの転送契約
- [sandbox-api-files.md](sandbox-api-files.md#get-v1filesdownload) — ZIP の除外規則・上限・ZIP ライタの実装
- [api-files.md](api-files.md#アーカイブの除外名) — 除外名の設定 API（未設定と明示空の区別・検証）
