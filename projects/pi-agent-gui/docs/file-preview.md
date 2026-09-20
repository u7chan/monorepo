# ファイルプレビューの表示（行番号 / シンタックスハイライト / HTML 描画 / 画像）

ファイル画面（`FileTreePage` / `SessionFilesPanel` → `FileBrowser` → `FilePreview`）の本文は、`GET /api/files/preview` で取得したプレーンテキストを表示用に整えて出す。HTML は `GET /api/files/html/<root 相対>` を iframe で描画し、画像は `GET /api/files/raw` を `<img>` で読む。整形は `client/src/lib/fileCode.ts` の純関数、タブと表示モードは `client/src/lib/fileTabs.ts`、描画は `client/src/components/FilePreview.tsx` が担う。タブと本文のキャッシュは [api.md](api.md#テキストプレビュー) を参照する。

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

クライアント内で HTML 文字列を iframe へ流す方法（`srcdoc` / Blob URL / `data:` URL）は使わない。アプリの本番 CSP（`default-src 'self'; style-src 'self'; script-src 'self'`）は `srcdoc` / `blob:` の iframe に継承され、インラインの style / script がブロックされるため描画できない（`frame-src` が `default-src` にフォールバックして `blob:` のフレーム自体も拒否される）。Chromium に本番相当の CSP を当てて確認済み。

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
- 失敗したときは `GET` の応答エラーをそのまま出す（タブは勝手に閉じない）

## 画面と root

ツリーとプレビューの本体は `client/src/components/FileBrowser.tsx` で、root を props で受け取る。同じ実装を 2 画面が別の root で使う。

| 画面 | 外装 | root | 出す条件 |
| --- | --- | --- | --- |
| 設定 → ファイル | `FileTreePage`（`SettingsPageLayout` + ヘッダ） | ワークスペース root 固定（`cwd=""` → `"."`） | 常時 |
| チャットの右パネル | `SessionFilesPanel`（ヘッダ + 閉じる） | 選択中セッションの作業フォルダ（`payload.cwd`） | desktop のチャット画面で、作業フォルダがあるときだけ（`client/src/lib/sessionFiles.ts`） |

- `FileBrowser` は root が変わると復元・取得・保存をやり直す必要があるので、呼び出し側が `key` を張り替える。パネルはセッションの切替で `SessionFilesPanel` ごと入れ替える（`FileBrowser` の `root` は mount の間一定）
- 取り直しの入口は外装の「再読み込み」と run_end で共通の `reloadToken` に集める（`SessionFilesPanel` は ヘッダの「再読み込み」の回数 + `ChatState.runEndSeq` の合計を渡す）。mount 時の token では撃たない（root の切替は `key` が扱うため）。run_end は描画された `runStatus` の差ではなく、reducer が `run_end` で進める `runEndSeq` を起点にする（`run_start` と `run_end` が同じバッチで届くと React は 1 回の描画にまとめるため、画面側では `running` を観測できず取りこぼす。SSE が切れて `resync` で復帰したときも、`running` を抜けていれば reducer が進める）。実行中の `tool_end` ごとの更新はしない
- `GET /api/files` の path は root を前置する（`fileTreeFetchPath`）ので、パネルは `.pi-agent-gui/sessions/<id>` 配下を root として扱う。サンドボックス / API は変えない（同じファイルを設定 → ファイル からも開ける）

## 削除

誤ってアップロードしたファイルを取り消す導線。ファイル行の右端のゴミ箱（`TrashIcon`）から、`window.confirm`（セッション / プロジェクト / エージェント削除と同じ）で確認してから `DELETE /api/files` を呼ぶ。

- **出す画面はセッションの作業フォルダ（チャット右パネル）だけ**。`FileBrowser` の `canDelete` を `SessionFilesPanel` だけ true にし、設定 → ファイル（ワークスペース root）は読み取り専用のままにする。プロジェクトのソースを GUI から 1 クリックで消せると事故が大きいため（取り消したいのはアップロード）
- **消せるのは通常ファイルだけ**。ディレクトリと symlink はサンドボックスが 400 で拒否するため、行にも導線を出さない（symlink の行には既存の「リンク」バッジが付く）。`uploads/` はフラットで、誤アップロードの取り消しにディレクトリ削除は要らない
- 行は選択（本文を開く）と削除の 2 つの `button` に分ける（`button` の入れ子は作れない）。削除は常時見せ、hover で隠さない（タッチ端末で押せなくなるため）
- 成功したらその行を一覧から落とし（`removeFileTreeEntry`）、開いていたタブを閉じる。**自分で消したものだけ**閉じる（外部で消えたファイルのタブは本文の取得エラーを出して残す現行挙動のまま）
- 失敗したら親ディレクトリのエラーとして出し、行は残す（`applyFileTreeError`。他のディレクトリの表示は維持し、「再読み込み」で消える）
- 未送信の添付チップが指すファイルを消しても、送信自体は通る（注記は `uploads/` のパスを載せるだけ）がサムネイルは 404 になる。今回は許容する（チップ側からも消せるようにするなら別途）
- 同じ行の二重送信は実行中のパスを持つ ref で弾く。エージェント実行中・プレビュー取得中との直列化は持たない（既存の同時操作と同じ）

## 復帰（F5・画面の往復）

ファイル画面は、F5 や チャット ⇄ 設定 の往復、パネルの閉じ開き、セッションの切替でも直前の状態に戻る（`client/src/lib/filePreviewState.ts`）。復帰は `FileBrowser` の mount ごとに 1 回で、root が変わるたび（設定を離れて戻る / パネルを開き直す / セッションを切り替える）に再適用し、通常の render やツリーの再取得・「再読み込み」では適用しない。保存は cwd ごとに分かれ、設定 → ファイル は常に `"."`（ワークスペース root 固定）、パネルは `.pi-agent-gui/sessions/<id>` を使うので、同じファイルを 2 画面で開いてもタブは混ざらない。保存値に残った他 cwd はそのまま残す（掃除はしない）。

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
| `client/test/fileTabs.test.ts` | 表示モードの既定（HTML と画像だけプレビュー）/ 選択の保持と破棄 / 全画面を続ける条件 / タブの開閉と上限 / 保存値からの復元（表示中の繰り上がりと上限） |
| `client/test/filePreviewFullscreen.test.ts` | HTML プレビューの全画面（`showModal()` で開く / Escape を全画面のときだけ止める / iframe は 1 つだけ / 出すときのタブに紐づける / 残すのは戻るボタンだけ） |
| `client/test/filePreviewCopy.test.ts` | 本文のコピー（パス行に置く / `reveal` を渡さない / 表示中の本文を渡す / 画像と HTML のプレビューでは出さない / タブを切り替えたら成功表示を捨てる） |
| `client/test/fileTree.test.ts` | 開閉・子のマージ・エラー保持 / 削除した行だけを落として他を保つこと / 保存する展開の抽出と復元（root の初期化、親を閉じた子の open、truncated） |
| `client/test/filePreviewState.test.ts` | 保存 schema の encode / decode / 検証と上限 / 壊れた入力の捨て方 / 他 cwd を消さない merge / read・write の例外とメモリ snapshot |
| `client/test/sessionFiles.test.ts` | 右パネルの出し分け（desktop × チャット画面 × 作業フォルダあり） |
| `client/test/chatReducer.test.ts` | `runEndSeq` が `run_end` と `running` を抜けた `resync` でだけ進むこと（同じバッチで届いた `run_start` / `run_end` でも 1 回、新規チャットでも戻らない） |
| `client/test/route.test.ts` | pathname と画面の対応（大文字・末尾スラッシュ・percent encoding・不正な入力の畳み方）と往復 |
| `client/test/fileUrl.test.ts` | パスのセグメント単位 encode（`#` / `?` / `%` / `+` / 日本語 / 1 回の decode で戻ること）/ `fileHtmlPreviewUrl` がクエリでなくパス形式で組み立てること |
| `server/test/files.test.ts` | HTML プレビューのポリシー定数（段階ごとの CSP / `connect-src` なし）/ `GET /api/files/html/<path>` の文書・画像・テキストアセット・400 の分岐と percent decoding / ヘッダ（CSP / `no-store` / `nosniff`）/ 文書は HTML・アセットは JSON のエラー写像 / `DELETE /api/files` の委譲と 204・エラー写像 |
| `server/test/static.test.ts` | SPA フォールバック（拡張子なしの画面 URL / `/api`・`/assets` の境界 / `Accept` / 未ビルド 503） |

## 参照

- [ui-layout.md](ui-layout.md) — 本文の中でツリーとプレビューをどう並べるか
- [markdown.md](markdown.md) — 共有するトークナイザの対応言語・上限
- [api.md](api.md#テキストプレビュー) — プレビューの転送契約
- [api.md](api.md#html-プレビュー) — HTML プレビューのヘッダとエラー応答
