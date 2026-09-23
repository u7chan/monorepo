# ファイルプレビューの表示（行番号 / シンタックスハイライト / HTML 描画 / 画像）

ファイル画面（`FileTreePage` / `SessionFilesPanel` / スキル設定のファイルタブ → `FileBrowser` → `FilePreview`）の本文は、`GET /api/files/preview` で取得したプレーンテキストを表示用に整えて出す。HTML は `GET /api/files/html/<root 相対>` を iframe で描画し、画像は `GET /api/files/raw` を `<img>` で読む。整形は `client/src/lib/fileCode.ts` の純関数、タブと表示モードは `client/src/lib/fileTabs.ts`、描画は `client/src/components/FilePreview.tsx` が担う。タブと本文のキャッシュは [api.md](api.md#テキストプレビュー) を参照する。

## 原則

1. **ソース表示の転送はプレーンテキストのまま**: 行番号も色も表示側の都合で、API / DTO / サンドボックスは変えない。Markdown を描画しない方針も変わらない（色を付けるだけ）。HTML は別ルートの応答を iframe で描画し、画像は raw の応答を `<img>` で読む（原則 5）。
2. **外部ライブラリを足さない**: 色付けはチャット本文と同じ `lib/markdown/highlight.ts` のトークナイザを使う（対応言語は [markdown.md](markdown.md)）。ファイル用の別実装を持たない。
3. **DOM 文字列を作らない**: `innerHTML` / `dangerouslySetInnerHTML` / インライン `style` を使わない（本番の CSP は `style-src 'self'`）。行番号もクラスと CSS だけで出す。`client/test/fileCode.test.ts` がソース走査で固定する。
4. **行番号と本文を 1 対 1 にする**: 番号の列は本文と同じ行送りで重ね、行数は本文から数える。ブラウザーの末尾改行の扱いに依存させない。
5. **HTML の描画は応答ヘッダで隔離する**: iframe の src は同一オリジンの `GET /api/files/html/<root 相対>` で、その応答だけ CSP と `sandbox` を当ててオペークオリジンにする。同じルートが文書と相対アセット（画像 / テキスト）を配るが、拡張子ごとに CSP / Content-Type を分ける（後述）。クライアント内で HTML 文字列を iframe へ流す方法（`srcdoc` / Blob URL / `data:` URL）は、親の CSP を継承してインライン style / script が動かないため使わない。

## パイプライン

```
FilePreview                 取得した本文をタブごとに保持（表示中のタブだけ取得・変換する）
  └─ buildPreviewCode       text + path → PreviewCode       lib/fileCode.ts
        ├─ previewLang      拡張子 / ファイル名 → 言語
        ├─ 正規化           CRLF・CR → LF、末尾の空行を落とす
        └─ highlightCode    言語別のトークン列                lib/markdown/highlight.ts
  └─ 描画                   行番号の列 + 本文の <pre>         components/FilePreview.tsx
```

変換は表示中のタブの本文について `useMemo` で 1 回だけ行う。タブごとに変換結果を持つと 1 タブ 3 MB 級になるため、切り替えると変換し直す（上限内のファイルでは数十 ms）。

## 言語判定

拡張子を `highlight.ts` の `normalizeLang` に渡して決める（`ts` / `tsx` / `js` / `json` / `py` / `sh` / `css` / `html` / `md` / `diff` など、エイリアスはトークナイザと共通）。拡張子を持たないファイルは `Dockerfile` だけ `bash` の規則で色を付ける。それ以外（`README`、`.gitignore`、`a.yaml` など）は素のテキストとして出す。

## 本文の正規化と行数

- `CRLF` / `CR` は `LF` に揃える（行末の CR を本文に残さない）
- 末尾の空行は落とす（本文からも行番号からも）。末尾の改行に行ボックスを作るかどうかは CSS の解釈に幅があるため、本文と行数を同じ文字列から数えて 1 対 1 を保証する
- 行数は残った本文の改行数 + 1。空のファイルは 0 行として「（空のファイル）」を出す

## 描画

- 行番号は本文とは別の列にし、本文と同じ `line-height` と上余白で重ねる（`client/src/styles/index.css` の `.file-code*`）
- 番号の列は 1 から行数までを改行で繋いだ**1 つのテキストノード**にする。行ごとの要素も CSS カウンタも使わないため、番号のために行数分の DOM を積まない（素のテキストなら 4,000 行でも本文と番号の列で要素は 2 つ）
- 番号の列は横スクロールでも左端に残す（`position: sticky`）。下を本文が通るため背景は不透明（`--c-base`）にする
- 本文は折り返さない（`white-space: pre` と横スクロール）。番号は読み上げの対象にしない（`aria-hidden`）し、コピーにも入らない（`user-select: none`）
- 色を付けられなかったときも行番号は出す。理由はヘッダの `text · N 行` で示す（言語判定の結果ではなく、実際に色を付けた言語を出す）

## コピー

ソース表示のパス行（`lang · N 行` の隣）に `CopyButton`（アイコンのみ、`aria-label` / `title` は `本文をコピー`）を常時出す。`reveal` を渡さないので、hover できる端末でも隠さずタッチ端末と同じ見え方にする。

- コピーするのは表示中の本文（`buildPreviewCode` の `text` を `previewCopyText` で取る）。行番号の列もハイライトの markup も含めない
- 本文は正規化後（CRLF / CR → LF、末尾の空行を落とす）なので、**クリップボードの内容は行末の CRLF / CR を LF に変え、末尾の空行を落とした分だけファイルの生バイトと違いうる**
- 空のファイル（空文字）/ 言語判定なし / トークン上限で素のテキストになった場合も同じボタンでコピーできる
- 成功表示は既存のコピーと同じ `useMessageCopy`（チェックアイコン + `コピーしました` を 2 秒）。失敗時は成功表示にしない
- 成功表示は表示中のタブ（`FileCopyButton` の key）に紐づけ、タブを切り替えたら捨てる。見えている本文が変わるため、戻っても表示を復帰させない
- 画像のプレビューには出さない。HTML はプレビュー中にソースを取得しないので出さず、ソース表示へ切り替えてからコピーする
- 256 KiB 超で本文を取得できないファイルは対象外（本文自体が無い。上限の緩和は別）
- 行番号付きコピー / 範囲指定コピー / ダウンロードは持たない

## 上限

| 上限 | 値 | 場所 | 決め方 |
| --- | --- | --- | --- |
| ハイライトする本文 | 256 KiB | `FILE_PREVIEW_MAX_LENGTH` | サンドボックスが返す本文の上限に合わせる（超えたら素のテキスト + 行番号） |
| トークン数 | 2 万 | `FILE_PREVIEW_MAX_TOKENS` | トークン 1 つが DOM ノード 1 つになる。実測（dev / Chromium）で 232 KiB の TS（4.6 万トークン）の描画に 0.66 秒かかるため、その半分程度に収める |

上限でハイライトを落としても本文と行番号は出す（無言で消さない）。実測値の目安は、41 行の TS が 66 ms（色付き）、7,058 行 / 226 KiB の TS が 162 ms（トークン上限を超えるため素のテキスト + 行番号）。

## HTML プレビュー

`.html` / `.htm` のタブ（`isHtmlPath`）は、行番号付きのソース表示と iframe で描画したプレビューを切り替えられる（`client/src/components/FilePreview.tsx`）。

### 方式

描画は iframe の src に同一オリジンの `GET /api/files/html/<root 相対>` を指定し、応答ヘッダだけで隔離する。同じルートが要求パスの拡張子で分岐し、文書と同じディレクトリを基準にした相対参照（`./cat.png` / `../app.css`）を解決できるようにする（`<base>` の注入はしない）。

| 要求 | 応答 |
| --- | --- |
| `.html` / `.htm` | 従来どおりの HTML 文書（CSP + sandbox 付き。本文は `workspace.previewFile()`） |
| 画像（`raw` の allowlist） | `workspace.rawFile()` を流用した生配信（`Content-Type` / `Content-Length` / `no-store` / `nosniff`） |
| `.js` / `.mjs` / `.css` / `.json` / `.txt` | `workspace.previewFile()` を流用し、拡張子から Content-Type を付けて返す |
| それ以外（`.svg` を含む） | 400 `Not a servable asset: <path>` |

- 文書以外は CSP を付けず、Content-Type と `nosniff` で守る。`.svg` と HTML はアセットとして配らない（同一オリジンでスクリプトを動かさない）。フォント / メディアは対象外
- アセットの本文も 256 KiB 以下の UTF-8 テキストに限る。超える `.js` / `.css` は 400 になり、プレビューから読めない
- `.json` は CSP に `connect-src` が無いため、現状のプレビュー内から読む手段が無い（`fetch` も classic script も不可）
- path はクライアントがセグメント単位で percent encoding する（`client/src/lib/fileUrl.ts`）。Hono 側（`:path{.+}`）は 1 回だけ decode する

クライアント内で HTML 文字列を iframe へ流す方法（`srcdoc` / Blob URL / `data:` URL）は使わない。アプリの本番 CSP（`default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'`）は `srcdoc` / `blob:` の iframe に継承され、インラインの style / script がブロックされるため描画できない（`frame-src` が `default-src` にフォールバックして `blob:` のフレーム自体も拒否される）。Chromium に本番相当の CSP を当てて確認済み。

### 隔離（CSP と sandbox）

CSP は `server/src/routes/files.ts` の `HTML_PREVIEW_POLICY` 1 箇所から導出する。既定は Lv2（`cdn`）で、`assets` / `inline` へ切り替えると読み込めるリソースだけが狭くなる（iframe 属性はどの段階でも `sandbox="allow-scripts"` 固定。クライアントへポリシーは配らない）。

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

- `connect-src` はどの段階にも無い。`fetch` / XHR は `default-src 'none'` にフォールバックして止まる
- `sandbox` によりオペークオリジンになり、親 DOM へ触れない（`localStorage` / cookie は SecurityError）
- iframe 側の `sandbox="allow-scripts"` 属性と両方で隔離する。スクリプトの有効 / 無効は切り替えない（クライアントのトグルは ソース / プレビューの 2 択だけ）
- 本文は 256 KiB のテキストとして取得する（`FilePreviewSchema` を通す）。サンドボックス側の API は増やさず、新規依存も足さない
- 200 の応答は文書 / アセットとも `Cache-Control: no-store` と `X-Content-Type-Options: nosniff` を付ける（文書は CSP も）
- 文書のエラーは iframe の中で読めるよう HTML 文書で返し（サンドボックス由来の文言はエスケープ）、この 2 つのヘッダも付ける。アセットのエラーはサブリソースに `text/html` を返さないよう JSON で返し、この 2 つのヘッダは付けない

### クライアントの振る舞い

- 既定はプレビュー。他の拡張子は従来どおりソース表示で、トグルは HTML のタブにだけ出す
- iframe の src は `client/src/api.ts` の `fileHtmlPreviewUrl(path)` が組み立てるパス形式の URL で、path はセグメント単位で encode する（`client/src/lib/fileUrl.ts`）。ポリシー（CSP の段階）はクライアントへ配らない
- トグルの選択はタブごとに保持し、タブを閉じると捨てる（`previewModeFor` / `withPreviewMode` / `dropClosedPreviewModes`）。state は `FileBrowser` が持つ。表示モードの選択は「タブを閉じるまで」が条件で、「再読み込み」は `FilePreview` を remount して本文だけを捨てる（本文はタブごとに保持するが、選択は再取得では戻さない）
- プレビュー中はソース本文を取得しない（`lang · N 行` も本文のコピーもソース表示のときだけ出す）
- 「再読み込み」は `FilePreview` の remount（`FileBrowser` の `key` 差し替え）で iframe も取り直す（プレビュー用の追加実装は無い）

### 全画面

パス行のボタン（HTML のプレビュー中だけ出す）で、プレビューをアプリの viewport いっぱいに出す。ブラウザの Fullscreen API（`requestFullscreen`）は使わない（iPhone Safari で使えない。ブラウザの全画面は F11 で代替できる）。

- 方式はアプリ内のモーダル dialog（`showModal()` = top layer）。`position: fixed` のオーバーレイは使わない。`@container`（`container-type: inline-size`）配下では 2024-10 より前のブラウザが layout containment を当てて fixed を祖先基準にするため viewport を覆えず、背面を inert にもできない
- 全画面に残すのは戻るボタンだけにする。タブバーは `hidden` で消し（タブの選択は全画面の解除でもあるため、出しておくと押した結果と見た目が食い違う。unmount せず display だけ切るので、横スクロールの位置は保たれ、戻ったときに `scrollIntoView` を当て直す）、パス行は パス / 表示の切替 / 行数を落として `全画面をやめる` だけの行（右寄せ + `border-b`、高さ 44px）にする。ボタンをプレビューの上へ重ねる（絶対配置）と下の HTML の右上を隠して押せなくするため、行として残す
- **dialog は全画面でなくても常に置く**。通常時は UA の dialog スタイル（`display: none` / `position` / `width`・`height: fit-content` / `margin: auto` / `border` / `padding` / `background: Canvas`）を打ち消して普通の箱として使い、全画面のときだけ `showModal()` する。全画面専用の 2 つ目の箱を作ると、出入りのたびに iframe が再読み込みされてプレビューを取り直すため
- 全画面は「全画面を出したタブをそのまま HTML のプレビューで表示している間」だけ続く。条件は `lib/fileTabs.ts` の `keepsFullscreenPreview`（出すときのタブ + HTML + プレビュー）で、他タブへ切り替えたとき（HTML 同士でも）/ 全画面のタブを閉じて次が繰り上がったとき / ソース表示へ切り替えたときに解除する。状態は保存しない（切替で解除した後、元のタブへ戻っても復帰しない。F5 と チャット ⇄ 設定 の往復でも復帰しない）
- `Escape` は全画面のときだけ dialog が受け取り（`stopPropagation`）、1 回で全画面だけを解除する。通常時も止めると設定ページの「Escape でチャットへ戻る」を食う。**プレビューの中（iframe）にフォーカスがあると Escape は親 document へ届かない**ので、そのときは `全画面をやめる` ボタンで戻る
- 全画面中は背面が inert になる（モーダルの標準挙動）。背面の SSE と実行中のランは止まらない（表示だけ）
- 見た目は `h-dvh w-screen max-h-none max-w-none m-0 border-0 bg-base` + `aria-modal` で、ツリーやタブの幅に依存しない（compact でも同じ）

### できないこと（残リスク）

- 相対参照で読めるのは同じルートの allowlist に入ったアセット（画像 / `.js` / `.mjs` / `.css` / `.json` / `.txt`）だけ。`.svg`、フォント、メディア、他の拡張子は 400 になる
- 256 KiB を超える `.js` / `.css` は配信できず、プレビューから読めない（文書と同じ上限）
- `<script type="module">` と動的 `import()` は読み込めない。オペークオリジンからの module 取得は CORS になり、BFF は CORS ヘッダを付けないため（classic script だけが動く。Vite 等が出力する `type="module"` の HTML は兄弟ファイルを置いても動かない）
- `localStorage` / `sessionStorage` / cookie を使う HTML は動かない（オペークオリジン）。`localStorage` の読み取りでは `SecurityError: Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.` が投げられる
- インライン script の途中で例外が出ると、その script の残りは実行されない（storage を使う単一ファイル HTML は「JS が動かない」ように見える）
- `fetch` / `eval` / `new Worker` は使えない（CSP 違反。`connect-src` は足さない）
- プレビュー自身は外部 URL へ自己遷移できる（持ち出せるのは自分自身の内容だけ）
- 同一オリジンの `/api` 面が 1 つ増える（CORS ヘッダを付けず、`no-store` と CSP + sandbox で無害化する）

## 画像プレビュー

画像（`png` / `jpg` / `jpeg` / `gif` / `webp` / `avif` / `bmp` / `ico`）の既定モードはプレビューで、`GET /api/files/raw` の URL を `<img>` の src にする（[api.md](api.md#画像配信raw)）。`GET /api/files/preview` はバイナリを 400 で拒否するため呼ばない（本文を取得しないので、"読み込み中…" も行数も出さない）。

- 配信は画像だけに制限し、SVG / HTML は allowlist 外として 400 になる（同一オリジンでスクリプトを実行させない）
- 表示は `object-contain` で親の幅・高さに合わせる。ピクセル等倍の切替や拡大縮小の UI は持たない
- 表示モードの切替は画像には出さない（ソース表示はバイナリなので意味が無い）。本文を取得しないので、コピーボタンも出さない。`keepsFullscreenPreview` も HTML だけを対象にする（全画面も HTML 専用）
- 失敗したとき（404 / 400 / 画像以外の配信拒否）はブラウザーの読み込み失敗表示になる（`alt` は `<パス> のプレビュー`）。テキスト / HTML のようなアプリ側のエラー文言は出さない（タブは勝手に閉じない。`<img>` に `onError` を持たせるのは別 Issue）

## 画面と root

ツリーとプレビューの本体は `client/src/components/FileBrowser.tsx` で、root を props で受け取る。同じ実装を 2 画面が別の root で使う。

| 画面 | 外装 | root | 出す条件 |
| --- | --- | --- | --- |
| 設定 → ファイル | `FileTreePage`（`SettingsPageLayout` + ヘッダ） | ワークスペース root 固定（`cwd=""` → `"."`） | 常時 |
| チャットの右パネル | `SessionFilesPanel`（ヘッダ + 閉じる） | 選択中セッションの作業フォルダ（`payload.cwd`） | desktop のチャット画面で、作業フォルダがあるときだけ（`client/src/lib/sessionFiles.ts`） |
| 設定 → スキルのファイルタブ | `ReadOnlySkillPanel`（`SkillDetailPanel` の中の 1 タブ） | SKILL.md の親ディレクトリ（root 相対。`client/src/lib/fileSkills.ts` の `fileSkillDir`） | `scope !== "builtin"` かつ root 相対の `.../SKILL.md` の親が取れるときだけ（組み込みの仮想パスと root 外の絶対パスは出さない）。**削除とリネームは `readOnly` で出さない** |

- `FileBrowser` は root が変わると復元・取得・保存をやり直す必要があるので、呼び出し側が `key` を張り替える。パネルはセッションの切替で `SessionFilesPanel` ごと入れ替える（`FileBrowser` の `root` は mount の間一定）。スキルのファイルタブは選択したスキルごとに `ReadOnlySkillPanel` ごと入れ替え、初回にタブを開いたときだけ `FileBrowser` を mount する（以降は `display` で隠して保持する）
- 取り直しの入口は外装の「再読み込み」と run_end で共通の `reloadToken` に集める（`SessionFilesPanel` は ヘッダの「再読み込み」の回数 + `ChatState.runEndSeq` の合計を渡す）。mount 時の token では撃たない（root の切替は `key` が扱うため）。run_end は描画された `runStatus` の差ではなく、reducer が `run_end` で進める `runEndSeq` を起点にする（`run_start` と `run_end` が同じバッチで届くと React は 1 回の描画にまとめるため、画面側では `running` を観測できず取りこぼす。SSE が切れて `resync` で復帰したときも、`running` を抜けていれば reducer が進める）。実行中の `tool_end` ごとの更新はしない
- `GET /api/files` の path は root を前置する（`fileTreeFetchPath`）ので、パネルは `payload.cwd`（プロジェクト所属なら登録ディレクトリ、未所属なら `.u7agent/sessions/<id>`）を root として扱う。サンドボックス / API は変えない（同じファイルを設定 → ファイル からも開ける）

## メッセージからの導線（ファイル参照）

assistant 本文のインラインコードが指すファイルを、右パネル / sheet のタブとして開く。字面の判定と cwd 相対への解決は `client/src/lib/fileRef.ts` の純関数、要求の保持は `client/src/lib/fileRefRequest.ts`、インラインコードの描画は `client/src/components/markdown/FileRefLink.tsx` が持つ。Markdown リンクの横取り・prompt 規約・ツール履歴（`write` / `edit` 行）からの導線は非ゴール（対応サブセットは変えない。描画側の契約は [markdown.md](markdown.md#インラインコードのファイル参照)）。

### 字面の判定（matcher）

インラインコードの字面だけを見て、次の順で評価する（前段で落ちたら後段は見ない）。存在確認はしない。

1. 全体で拒否: 空白（ASCII 空白と `\p{White_Space}`）・制御文字（`U+0000`–`U+0020` / `U+007F`）・バックスラッシュ・`//` で始まる authority 形式・scheme 付き（`^[A-Za-z][A-Za-z0-9+.-]*:`）
2. 末尾形状（正規化の前）: 末尾スラッシュと末尾ドットのセグメントはファイル扱いしない（先に `a.png/.` を `a.png` へ畳むと拒否理由が消えるためこの順）
3. 正規化: 重複スラッシュの圧縮と `./` セグメントの除去（`a//b.png` / `a/./b.png` → `a/b.png`）
4. `..` セグメントは畳まず拒否（親参照で cwd の外を開かせない）
5. 拡張子: 最終セグメントの最後のドット以降が ASCII 英数字だけで、数字だけではないこと。最終セグメントが dotfile（先頭ドット）なら拡張子として扱わない（親ディレクトリの `.u7agent` は見ない）

| 入力 | 判定 | 理由 |
| --- | --- | --- |
| `index.html` / `./a/b.png` | 採用 | 最終セグメントにドット付き拡張子がある |
| `a//b.png` / `a/./b.png` | 採用（`a/b.png`） | 同じファイルの別表記でタブを重複させない |
| `assets/` | 不採用 | 末尾スラッシュ（ディレクトリ） |
| `localStorage` | 不採用 | ドット付き拡張子が無い |
| `node --check script.js` | 不採用 | 空白・記号を含む（コマンド行） |
| `v1.2.3` | 不採用 | 拡張子が数字だけ |
| `https://example.com/a.html` / `file:///tmp/a.html` | 不採用 | scheme 付きは URL として扱う |
| `//host/a.png` | 不採用 | authority 形式（スラッシュ圧縮より前に拒否） |
| `foo.bar()` | 不採用 | 拡張子に `(` `)` などの記号が入る |
| `a` + `U+0000` + `.png` | 不採用 | 制御文字を含む |
| `foo(bar).png` | 採用 | 記号は拡張子の中だけ拒否する（パス本体の記号は許容） |
| `release..notes.md` | 採用 | `..` はセグメント全体が `..` のときだけ親参照 |
| `a/../b.html` | 不採用 | 親参照セグメントを含むものは一律拒否（安全側） |
| `.gitignore` / `.env.local` | 不採用 | 最終セグメントが dotfile |
| `x.` / `a.png/.` | 不採用 | 末尾ドットのセグメント（正規化前の末尾形状検査） |
| `a\b.png` | 不採用 | バックスラッシュは区切りとして扱わない |

`config.prod` のような見た目の文字列はリンクになり得る（見た目ではなく拡張子の形だけを見るため）。これは matcher の限界として受け入れる。

### 解決（cwd 相対）

`rootCwd` は `health.cwd`（ワークスペース root の絶対パス）、`cwd` は選択中セッションの `payload.cwd`。解決できたパスだけがタブのキー（cwd 相対）になる。

| 入力の形 | 扱い |
| --- | --- |
| `/workspace/...`（`rootCwd` 前置きの絶対パス） | `rootCwd` を剥がす。剥がせなければ不採用。剥がした結果が cwd 配下（`cwd + "/"` 境界）なら cwd 前置きも剥がして cwd 相対にする。cwd 配下でなければ不採用 |
| その他の絶対パス（`/etc/...` など） | 不採用。`rootCwd` 未取得（health 未取得）のときも絶対パスは不採用 |
| `./x` / `x`（明示的な相対） | cwd 相対として扱う。**cwd 前置きの剥がしはしない**（`projects/u7agent/a.html` は `<cwd>/projects/u7agent/a.html` を意味するため） |
| `..` セグメントを含む | 不採用（matcher で除外） |

- 裸の `.u7agent/uploads/<id>/a.png` はこの規則どおり `<cwd>/.u7agent/uploads/<id>/a.png` を指す（予約 prefix の例外は持たない）。絶対パスの `/workspace/.u7agent/uploads/<id>/a.png` は cwd 外なので不採用
- セッションの cwd が未確定（未作成チャット）の間は何も解決しない。設定 → ファイル はワークスペース root 固定なので対象外
- 保証は**字句的な包含だけ**。symlink の実体が cwd の外を指す場合までは保証しない（サンドボックスの検証は既存契約のまま workspace root 内）

### クリックと要求

- 操作要素にするのは assistant 本文のインラインコードだけ。`type="button"` で、Tab 移動 / Enter / Space / 可視 focus / 読み上げ名を持つ。**Markdown リンクの children の code は対象外**（`[`index.html`](https://example.com)` は従来どおり `<a>` の中の code で、操作要素を入れない）。user 本文と、`MARKDOWN_MAX_LENGTH` 超のプレーン表示フォールバックも対象外
- 要求は `{ seq, sessionId, path }` として `useSessions` の store が 1 件だけ持つ。`seq` は App の存続期間で単調増加し再利用しない。消費前に複数クリックが届いたら最後の要求だけが残る（最新優先。中間クリックのタブ作成は保証しない）
- 要求の寿命は選択中セッションの滞在期間に限る。`selectSession` / `newChat` の開始時と、`applySelectedSession` で ID が変わるときに破棄する（A→B→A と戻っても復活しない。`cwd` はセッション識別子にならず、同一プロジェクトの別セッションでも選択が変われば破棄する）
- パネル / sheet は条件付き mount なので、`FileBrowser` が mount 後の Effect で未消費の要求を適用し、`onHandled(seq)` で App へ返す（`reloadToken` の「mount 時の値は無視する」方式は初回クリックを取り落とすため使わない）。App の ack は現在の pending の `seq` と照合し、古い ack で新しい要求を消さない
- 適用の印は `FileBrowser` の ref が持ち、適用の直前に記録する。Effect の再実行（StrictMode）では二重に適用しない。`openFileTab` は同一パスでも新しい state を返すため、「タブが増えない」ことは 1 回適用の根拠にならない
- 復元は `useState` の初期化、要求は Effect で適用するため、要求が最後に効く（表示中のタブが要求のパスになる）。ツリーの親は自動展開せず、プレビューも自動で全画面にしない
- 表示モードは既存の選択規則のまま（未選択の HTML だけ既定でプレビュー。ユーザーがソースを選んだタブはソースのまま）
- compact の sheet は閉じたときに、クリックした button を `App` が保持して focus を戻す（`document.activeElement` はクリックした button を指すとは限らない）。起点がセッション切替などで消えていたら focus を移さない。トグルから開いたときは戻さない。Escape は dialog の標準動作で閉じる（プレビューの中にフォーカスがあると親へ届かない既知制約は HTML プレビューと同じ）
- provider は `App` が `rootCwd` / `cwd` / callback だけの memo 値で配る。要求 `seq` やパネル開閉を value に混ぜず、SSE の更新で過去の本文を再解析・再描画させない。インラインコード側だけが context を購読するため、独自 comparator を持つ `MdBlockView` / `MdList` / `MdListItemView` / `MdTable` に callback を通す必要がない

## 削除

誤ってアップロードしたファイルやエージェントの成果物を取り消す導線。通常ファイルとディレクトリの行の右端のゴミ箱（`TrashIcon`）から、`window.confirm`（セッション / プロジェクト / エージェント削除と同じ）で確認してから `DELETE /api/files` を呼ぶ。

- **出す画面は設定 → ファイル（ワークスペース root）とチャット右パネル（セッションの作業フォルダ）の 2 つ**。`FileBrowser` に画面を分ける `canDelete` は持たせず（`onDelete` も必須にする）、通常ファイルとディレクトリの行には常にゴミ箱を出す。プロジェクトのソースを GUI から消せる点は「ワークスペース全体を見ながら片付けたい」という要望を優先して受け入れ、事故防止は confirm のパス表記が担う。**dev の root は `PI_APP_CWD`（既定は `projects/u7agent` 自身）なので、自分のソースも消せる**
- **スキル設定のファイルタブ（読み取り専用の面）は `readOnly` を渡し、削除とリネームの導線を行ごと出さない**（スキルの補助ファイルは「ファイル」画面から片付ける）。既定は false なので、上の 2 画面の挙動は変わらない
- **confirm にはその画面の root 相対（ツリーに見えているパス）を出す**。ファイルは `client/src/lib/fileTree.ts` の `fileTreeDeleteConfirm(path)`（`「<path>」を削除しますか？この操作は取り消せません。`）で、設定 → ファイル は `.u7agent/uploads/3a7bfba36f/shot.png`、チャット右パネルは作業ディレクトリ相対（`node/main.ts` など）になる。ディレクトリは `fileTreeDeleteDirectoryConfirm(path)` で、配下ごと消えることを示す `「<path>」と配下のファイルをすべて削除しますか？この操作は取り消せません。` を出す。パネルでワークスペース root 相対（見えていない長いパス）を出すと行との対応が取れないため、見えているパスに合わせる（ワークスペース root を見る設定 → ファイル では両者が一致する）
- **通常ファイルは 1 件、ディレクトリは配下ごと消える**（`recursive=true`。空ディレクトリも同じ導線）。削除範囲は一覧の上限（500 件 / ディレクトリ）に縛られず、未表示の子も消える。**symlink は行に導線を出さない**（サンドボックスが 400 で拒否する。ファイル / ディレクトリとも。symlink の行には既存の「リンク」バッジが付く）。`.u7agent/uploads/<id>/` はフラットだが、セッション作業フォルダの `uploads/` などの片付けにディレクトリ削除を使える
- **削除したディレクトリ配下の symlink はリンクだけが消え、リンク先は残る**（`rm -rf` と同じ）。削除対象そのものが symlink なら 400 で、リンクもリンク先も残る
- 行は選択（本文を開く）と削除の 2 つの `button` に分ける（`button` の入れ子は作れない）。削除は常時見せ、hover で隠さない（タッチ端末で押せなくなるため）
- 成功したらその行を一覧から落とし（`removeFileTreeEntry`）、開いていたタブを閉じる。ディレクトリは配下の state も `pruneFileTreeSubtree` で落とし、配下のタブを `closeFileTabsUnder` で閉じる（表示中のタブが消えたときの繰り上がりは `closeFileTab` と同じで、右の生存タブ → 右なしで左 → 全消去）。**自分で消したものだけ**閉じる（外部で消えたファイルのタブは本文の取得エラーを出して残す現行挙動のまま）
- 失敗したら親ディレクトリのエラーとして出し、行は残す（`applyFileTreeError`。他のディレクトリの表示は維持し、「再読み込み」で消える）
- 未送信の添付チップが指すファイルを消しても、送信自体は通る（注記は保存先のパスを載せるだけ）がサムネイルは 404 になる。今回は許容する（チップ側からも消せるようにするなら別途）
- 同じ行の二重送信は実行中のパスを持つ ref で弾く。エージェント実行中・プレビュー取得中との直列化は持たない（既存の同時操作と同じ）

### 既知の制限（削除）

- **pending 一覧の復活**: 削除直前に飛んでいた親一覧の応答が後から適用されると、削除済みの行が復活し得る（`FileBrowser.tsx` の適用は無条件）。クリックすると 404 になり、次の取得（「再読み込み」/ run 終了）で消える。取得世代での無効化は別 Issue。復活した行を利用者が再操作した場合も、保存値からの除去は保証しない（削除成功時の反映は自画面の state が対象）
- **競合（TOCTOU）**: サンドボックスの入力検証（root 外 / symlink / 形式）は「競合がない場合」の契約で、親 realpath の後に祖先が rename + symlink へ差し替えられると root 外を消し得る（[sandbox-api.md](sandbox-api.md#delete-v1dirs)）。fd 相対の削除が Node に無いため完全な防御は入れない
- 大きいツリーは応答まで時間がかかる（行は応答まで残る）。`fs.rm` が途中で失敗すると部分削除が残り、親にエラー表示が出る（「再読み込み」で実際の状態に戻る）
- 並行削除: `lstat` 前の不存在は 404、検証後の `ENOENT` は成功。同一パスの二重送信は `deletingRef` が弾くが、親子の同時削除は直列化しない（後から来た要求は 404 か成功になる）

## リネーム

名前を直したいフォルダを削除して作り直さずに済むよう、設定 → ファイル のフォルダ行にリネームの導線を出す。行の右端の鉛筆（`PencilIcon`）から、削除と同じ流れの `window.prompt` で新しい名前を入力し、`POST /api/files/rename` を呼ぶ。

- **出すのは設定 → ファイル（ワークスペース root）だけ**。`FileBrowser` の `canRename` prop（既定 false）で切り、`FileTreePage` だけが true を渡す。チャット右パネル（`SessionFilesPanel`）は対話中のパスと食い違うため出さない。スキル設定のファイルタブは `readOnly` で削除と一緒に消す（`canRename` も渡さない）
- **鉛筆を出すのはフォルダ行だけ**。UI からファイルは改名できない（API はファイル / ディレクトリの両方を受ける。移動（親ディレクトリの変更）は非ゴール）。symlink の行にも出さない（サンドボックスが 400 で拒否する）
- **prompt の初期値は現在の名前**（`fileTreeRenamePrompt(path)` が見出し、現在の名前を第 2 引数に渡す）。取り消し（`null`）・空・未変更なら何もしない。削除の `window.confirm` と同じく、同じ行の二重送信は実行中のパスを持つ ref で弾く。run 中でも操作できる（削除と同じでガードなし）
- **成功後はツリーとタブ・表示モードの経路を新しい名前へ張り替える**。親一覧の行の名前を差し替え（`renameFileTreeEntry`）、配下の state のキー（`renameFileTabs` / `renamePreviewModes`）を移す。開いている階層と取得済みの子はそのままなので親の再取得は起きず、タブの本文だけを新しい経路で取り直す（プレビューの `results` は経路ごとなので、新キーで再取得する）。**取得中だった一覧は `loading` を落として新しい経路で取り直す**（飛んでいた応答は旧キーへ着地するため、持ち越すと改名したフォルダが「読み込み中…」のまま固定される）。画面の root 相対は親 + 新しい名前で組み立てる（応答の実パスは symlink 経由の要求でツリーのキーとずれるため）
- **失敗は親ディレクトリの行に理由を出す**（`applyFileTreeError`。削除と同じ。同名 409 の文言をそのまま出す）。行はそのまま残る
- 改名先が既存の名前なら 409 で何も変えない（上書きも自動採番もしない）。大文字小文字だけの変更は許す（[sandbox-api.md](sandbox-api.md#post-v1filesrename)）
- リネームで登録プロジェクトの root や `.u7agent/sessions/<id>` を改名すると、プロジェクト / セッションの `payload.cwd` は追随しない（削除でも同じ。保護パスは設けない）

### 既知の制限（リネーム）

- **pending 一覧の復活**: 削除と同じ。改名直前に飛んでいた旧名の親一覧の応答が後から適用されると、旧名の行が復活し得る（クリックすると 404 になり、次の取得で消える）
- **同名の競合（TOCTOU）**: サンドボックスの同名判定は `lstat` → `rename(2)` の順なので、その間に同じ名前が作られると上書きされうる（Node に no-replace の rename が無い。単一ユーザーでエージェントと同時に触った場合のみ。[sandbox-api.md](sandbox-api.md#post-v1filesrename)）
- リネーム先が既存タブと同じ経路になったとき（外部で消えたファイルのタブが残っている等）は、重複したタブを作らず先のタブへ寄せる

## 時刻

ディレクトリ行 / ファイル行の右端に更新時刻（`FileEntry.mtime`、epoch ms）を出す。`mtime` を持つ行だけに出すので、stat できない壊れた symlink の行には出ない。

- 表示はメッセージと同じ規則（`client/src/lib/messageTime.ts`）で、テキストは `messageTimeLabel`（今日 → `08:53` / 今年 → `9/21` / それ以前 → `2026/9/21`）、`title` に `messageFullTimeLabel`（`2026/9/21(日) 08:53`）を出す。`<time dateTime={new Date(mtime).toISOString()} title={…}>` の形の前例はチャットの吹き出し（`MessageView.tsx`）。数字の幅で行ごとにガタつかないよう `tabular-nums` を付ける
- **ディレクトリ行もファイル行と同じ「div + 操作 button」の形にする**（以前は行全体が 1 つの `button`）。時刻を `button` の中に入れると accessible name に時刻が混ざり、時刻のクリックでも開閉してしまうため。`button` は `flex-1` のままなので、行のクリック領域は実質変わらない
- 時刻の右端をそろえるため、両行の右 padding を `pr-1` にそろえ、行の末尾に `size-6` のスロットを並べる（行の右端は共通の `EntryRowActions`）。スロットは リネーム → 削除 の順で、**設定 → ファイル（`canRename`）は全行がリネームのスロットを持ち、フォルダ行だけ鉛筆が入る**（ファイル行と symlink 行は `aria-hidden` の空スペーサー `EmptySlot`）。チャット右パネルはリネームのスロットごと出さず、削除のスロット（ファイル / ディレクトリ行 = ゴミ箱、symlink 行 = 空スペーサー）だけになる。px の一致は client に DOM テスト基盤が無いため自動では固定せず、**手動確認**とする（`client/test/fileBrowserRowTime.test.ts` は両行が同じ形であることまでを、`client/test/fileBrowserRename.test.ts` は鉛筆の出し分けだけを固定する）
- 意味は「更新」。サンドボックスが返せるのは mtime で、`birthtime` は overlayfs 等で 0 になり得るため使わない（アップロード / エージェントの書き出しでは実質の作成時刻と一致する）
- **サンドボックスの一覧はディレクトリにも `mtime` を付ける**（`size` はファイルだけ。ディレクトリの `size` はファイルの内容量を表さない）。規則は symlink は辿った先（`stat`）、それ以外は `lstat` を全エントリに適用し、`classifyEntry` が種別判定に使った `stat` は捨てずに再利用する（増える syscall は素のディレクトリの `lstat` 1 回）。ディレクトリ symlink にはリンク先の mtime が付く（一覧が実体で表す既存契約と一致）
- 一覧は追加の更新を持たないので、**行の時刻は「再読み込み」と run 終了でしか更新されない**。削除しても親ディレクトリ行の `mtime` は次の取得まで古いまま

## 復帰（F5・画面の往復）

ファイル画面は、F5 や チャット ⇄ 設定 の往復、パネルの閉じ開き、セッションの切替でも直前の状態に戻る（`client/src/lib/filePreviewState.ts`）。復帰は `FileBrowser` の mount ごとに 1 回で、root が変わるたび（設定を離れて戻る / パネルを開き直す / セッションを切り替える / スキルのファイルタブを開き直す）に再適用し、通常の render やツリーの再取得・「再読み込み」では適用しない。保存は cwd ごとに分かれ、設定 → ファイル は常に `"."`（ワークスペース root 固定）、パネルは `payload.cwd`、スキルのファイルタブは SKILL.md の親ディレクトリを使うので、同じファイルを別の面で開いてもタブは混ざらない。保存値に残った他 cwd はそのまま残す（掃除はしない）。

- 復帰するのは タブの並び / 表示中のタブ / タブごとの表示モード / 開いているディレクトリ。本文・children・loading・error は保存しない（他キーや複数 cwd と合算した容量と、鮮度の問題）。復帰後に本文を取得し直すため、表示中のタブ以外は選択したときに取得する（HTML は `/api/files/html/<path>`、ソースは `/api/files/preview`）
- 親を閉じた子の open は保持し、保存された子のために親を勝手に開かない。root は常に開く。取得は既存の「可視の親から子へ」の経路のままで、親を開いた時点で子の open が効く
- 消えていたファイルのタブは残し、本文の取得エラーをそのまま出す（勝手に閉じない）。削除済みディレクトリの枝は一覧の取得で落ちる。listing が `truncated` のとき未掲載の枝も落ちるため、完全な復元は保証しない
- 「再読み込み」はタブ・表示モード・展開を保ったまま本文だけを取り直す。最後のタブを閉じた状態（保存する内容が無い）は cwd ごと消すので、F5 後も空のままになる
- 保存値が壊れている / 形が合わない cwd は捨てる（他の cwd は残す）。9 枚のタブを持つ保存値も捨てる。これは通常操作の 9 枚目で最古を落とす `FILE_TAB_LIMIT` とは別の契約
- 保存領域が使えない環境（SecurityError / quota 超過）では、write が失敗した cwd をメモリ snapshot として持ち、同一セッション内の往復は復元できる。F5 を跨ぐ復元は保証しない（古い保存値が戻り得る）。保存キーと上限の全体は [frontend.md](frontend.md#保存キーと保存範囲)

## テスト

| テスト | 固定すること |
| --- | --- |
| `client/test/fileCode.test.ts` | 拡張子の言語判定 / 正規化と行数 / コピーする本文（正規化後・行番号なし・空文字）/ 上限でのフォールバック / 行番号の列 / 例外を投げない / 描画側が DOM 文字列とインライン style を使わない / HTML の判定 / iframe が sandbox 付きで同一オリジンの URL を使う |
| `client/test/fileTabs.test.ts` | 表示モードの既定（HTML と画像だけプレビュー）/ 選択の保持と破棄 / 全画面を続ける条件 / タブの開閉と上限 / ディレクトリ配下のタブの一括削除（接頭辞境界と繰り上がり）/ リネームの経路の張り替え（並び・表示中の保持、配下、重複の排除、表示モード）/ 保存値からの復元（表示中の繰り上がりと上限） |
| `client/test/filePreviewFullscreen.test.ts` | HTML プレビューの全画面（`showModal()` で開く / Escape を全画面のときだけ止める / iframe は 1 つだけ / 出すときのタブに紐づける / 残すのは戻るボタンだけ） |
| `client/test/filePreviewCopy.test.ts` | 本文のコピー（パス行に置く / `reveal` を渡さない / 表示中の本文を渡す / 画像と HTML のプレビューでは出さない / タブを切り替えたら成功表示を捨てる） |
| `client/test/fileTree.test.ts` | 開閉・子のマージ・エラー保持 / 削除した行だけを落として他を保つこと / 削除の confirm 文言（ファイル / 配下ごとのディレクトリ、画面の root 相対パス）/ ディレクトリ削除後の枝の prune（接頭辞境界と own プロパティ契約）/ リネームの prompt 文言と、親の行の名前差し替え・配下キーの張り替え・開閉と取得済みの子の保持（接頭辞境界・未取得の親・`__proto__`）/ 取得中のリネームで loading を落として新しいキーで取り直すこと（旧キーの応答で新キーを汚さない）/ 保存する展開の抽出と復元（root の初期化、親を閉じた子の open、truncated） |
| `client/test/fileBrowserRowTime.test.ts` | ディレクトリ行とファイル行が同じ形の時刻と末尾スロットを持つこと（`<EntryTime at={entry.mtime}>` / `pr-1` / 共通の `EntryRowActions`）/ 右端のスロットがリネーム (フォルダのみ) と削除 (symlink 以外) を同じ条件で出し、残りは空スペーサーに落ちること / `readOnly` では両行とも行の操作ごと消えること / 時刻が開閉の `button` の外にあること / 空スペーサーが `aria-hidden` の `size-6` であること / 削除が種類ごとに confirm と API を分けること（ディレクトリは `deleteDirectory` と配下の state / タブの除去）/ 時刻が `messageTimeLabel` と `title` の完全な表記を使い、`mtime` 無しの行には出ないこと |
| `client/test/fileBrowserRename.test.ts` | リネームの鉛筆の出し分け（`canRename` のフォルダ行だけ / 削除の左 / ファイル行と symlink 行は空スペーサー / 既定は出さない）/ `readOnly` は削除とリネームの導線ごと消えること / prompt の初期値と空・未変更の no-op / API への委譲とツリー・タブ・表示モードの張り替え・失敗の表示 / 渡すのは `FileTreePage` だけ、`readOnly` はスキルのファイルタブだけ（`react-dom/server` の描画 + ソース走査） |
| `client/test/readOnlySkillPanel.test.ts` | 読み取り専用スキルの本文の取得元（選択のたびに `GET /api/files/preview` / 組み込みは一覧の `body`）/ 本文 / ファイル タブの出し分け（`fileSkillDir` / 読み取り専用の `FileBrowser` / 初回 mount と `display` の保持）/ 本文のコピーが表示と同じ生テキストであること（`react-dom/server` の描画 + ソース走査） |
| `client/test/fileRef.test.ts` | matcher の採否表（正規化と別表記の同ービキー / 制御文字 U+0000 / Unicode 空白 U+00A0・U+3000 / dotfile / scheme / `..` / 末尾ドット）と、解決の表（rootCwd 前置き / cwd 外 / rootCwd 未取得 / 明示的な相対 / cwd 未確定） |
| `client/test/fileRefRequest.test.ts` | 未消費は 1 件で最新優先 / ack は seq が一致するときだけ消す（request1 → request2 → ack1）/ 選択変更の破棄後に復活しない / 旧 ack で新しい要求を消さない / sessionId の一致判定 / 購読の通知 / 配線のソース走査（選択変更の 3 経路、App の受け渡し、`FileBrowser` の seq ガード、sheet の focus 復帰） |
| `client/test/markdownFileRef.test.ts` | 参照になるインラインコードだけ button にする / provider の外と参照でない字面は code のまま / rootCwd 前置きと cwd 外の解決 / リンク内 code の除外 / 引用・リスト・表の中の code / 長文フォールバックの例外（描画 + ソース走査） |
| `client/test/filePreviewState.test.ts` | 保存 schema の encode / decode / 検証と上限 / 壊れた入力の捨て方 / 他 cwd を消さない merge / read・write の例外とメモリ snapshot |
| `client/test/sessionFiles.test.ts` | 右パネルの出し分け（desktop × チャット画面 × 作業フォルダあり） |
| `client/test/chatReducer.test.ts` | `runEndSeq` が `run_end` と `running` を抜けた `resync` でだけ進むこと（同じバッチで届いた `run_start` / `run_end` でも 1 回、新規チャットでも戻らない） |
| `client/test/route.test.ts` | pathname と画面の対応（大文字・末尾スラッシュ・percent encoding・不正な入力の畳み方）と往復 |
| `client/test/fileUrl.test.ts` | パスのセグメント単位 encode（`#` / `?` / `%` / `+` / 日本語 / 1 回の decode で戻ること）/ `fileHtmlPreviewUrl` がクエリでなくパス形式で組み立てること |
| `server/test/files.test.ts` | HTML プレビューのポリシー定数（段階ごとの CSP / `connect-src` なし）/ `GET /api/files/html/<path>` の文書・画像・テキストアセット・400 の分岐と percent decoding / ヘッダ（CSP / `no-store` / `nosniff`）/ 文書は HTML・アセットは JSON のエラー写像 / `DELETE /api/files` の委譲（`recursive=true` は `deleteDirectory`）と 204・`recursive` の検証・エラー写像 / `POST /api/files/rename` の委譲と body 検証・エラー写像（409 の透過を含む）・契約外の応答の 502 |
| `server/test/sandbox-delete-dir.test.ts` | `DELETE /v1/dirs`（`recursive` の解釈 / 空ディレクトリ / 非空の 400 と部分削除なし / 配下ごとの削除と接頭辞境界 / パス形式と root 外・不存在・非ディレクトリ・symlink の 400・404 / 配下 symlink のリンクだけの削除 / 一覧上限外の子 / `__proto__` / 認証） |
| `server/test/sandbox-client.test.ts` | NDJSON / JSON 経路の写像と、`deleteDirectory` が `DELETE /v1/dirs?recursive=true` を呼び 204 の本文を読まないこと / `renameEntry` が `POST /v1/files/rename` を呼び、409 を文言ごと透過すること |
| `server/test/sandbox-rename.test.ts` | `POST /v1/files/rename`（ファイル / ディレクトリの改名と応答パス / 大文字小文字だけの変更 / 同名 409 と変更なし / 不正な名前・パス形式の 400 / 不存在 404 / root 外 400 / symlink の 400 とリンク先の維持・symlink への上書きの 409 / symlink ディレクトリ経由 / 認証） |
| `server/test/static.test.ts` | SPA フォールバック（拡張子なしの画面 URL / `/api`・`/assets` の境界 / `Accept` / 未ビルド 503） |

## 参照

- [ui-layout.md](ui-layout.md) — 本文の中でツリーとプレビューをどう並べるか
- [markdown.md](markdown.md) — 共有するトークナイザの対応言語・上限と、インラインコードをファイル参照の操作要素にする描画契約
- [api.md](api.md#テキストプレビュー) — プレビューの転送契約
- [api.md](api.md#html-プレビュー) — HTML プレビューのヘッダとエラー応答
