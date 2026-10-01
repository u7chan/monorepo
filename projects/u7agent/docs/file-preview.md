# ファイルプレビューの表示（行番号 / シンタックスハイライト / HTML 描画 / 画像）

ファイル画面（`FileTreePage` / `SessionFilesPanel` / スキル設定のファイルタブ → `FileBrowser` → `FilePreview`）の本文は、`GET /api/files/preview` で取得したプレーンテキストを表示用に整えて出す。HTML は `GET /api/files/html/<root 相対>` を iframe で描画し、画像は `GET /api/files/raw` を `<img>` で読む。整形は `client/src/lib/fileCode.ts` の純関数、タブと表示モードは `client/src/lib/fileTabs.ts`、描画は `client/src/components/FilePreview.tsx` が担う。タブと本文のキャッシュは [api.md](api.md#テキストプレビュー) を参照する。

## 原則

1. **ソース表示の転送はプレーンテキストのまま**: 行番号も色も表示側の都合で、API / DTO / サンドボックスは変えない。Markdown を描画しない方針も変わらない（色を付けるだけ）。HTML は別ルートの応答を iframe で描画し、画像は raw の応答を `<img>` で読む（原則 5）。
2. **外部ライブラリを足さない**: 色付けはチャット本文と同じ `lib/markdown/highlight.ts` のトークナイザを使う（対応言語は [markdown.md](markdown.md)）。ファイル用の別実装を持たない。
3. **DOM 文字列を作らない**: `innerHTML` / `dangerouslySetInnerHTML` / インライン `style` を使わない（本番の CSP は `style-src 'self'`）。行番号もクラスと CSS だけで出す。`client/test/fileCode.test.ts` がソース走査で固定する。
4. **行番号と本文を 1 対 1 にする**: 番号の列は本文と同じ行送りで重ね、行数は本文から数える。ブラウザーの末尾改行の扱いに依存させない。
5. **HTML の描画は応答ヘッダと iframe 属性で隔離する**: iframe の src は `GET /api/files/html/<root 相対>` で、既定はストレージ有効モードの別オリジン（別リスナー）、パス行のスイッチでアプリと同一オリジンの隔離へ戻せる（後述）。同じルートが文書と相対アセット（画像 / テキスト）を配るが、拡張子ごとに CSP / Content-Type を分ける。クライアント内で HTML 文字列を iframe へ流す方法（`srcdoc` / Blob URL / `data:` URL）は、親の CSP を継承してインライン style / script が動かないため使わない。

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

## タブ

タブバーは開いた順に並べて横スクロールし（タブが増えても行の高さと本文の幅を変えない）、同時に開けるのは `FILE_TAB_LIMIT`（8 枚。9 枚目を開くと最も古いタブを落とす）。選択は並びを変えず、表示中のタブを閉じたときだけ右隣 → 左隣 → 全消去へ繰り上がる（`closeFileTab`。削除とリネームの張り替えも同じ規則を使う）。

- 閉じる導線はタブの右端の `×` と、**PC のホイール押し込みによる中クリック**の 2 つ。中クリックはタブの箱（ラベル / `×` のどちらの上でも）で受け、表示中でないタブを閉じても表示は動かさない（`closeFileTab`）
- 中クリックは `auxclick` の `button === 1` だけを閉じる操作にし、同じ `mousedown` の既定動作（Windows のオートスクロール / Linux のペースト）は `preventDefault` で止める。既定動作は `auxclick` では止められず、止めないと閉じると同時にスクロールモードへ入る
- 中クリックを持たないタッチ端末では `×` だけが導線になるので、`×` は残す

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

## コピー

ソース表示のパス行（`lang · N 行` の隣）に `CopyButton`（アイコンのみ、`aria-label` / `title` は `本文をコピー`）を常時出す。`reveal` を渡さないので、hover できる端末でも隠さずタッチ端末と同じ見え方にする。

- コピーするのは表示中の本文（`buildPreviewCode` の `text` を `previewCopyText` で取る）。行番号の列もハイライトの markup も含めない
- 本文は正規化後（CRLF / CR → LF、末尾の空行を落とす）なので、**クリップボードの内容は行末の CRLF / CR を LF に変え、末尾の空行を落とした分だけファイルの生バイトと違いうる**
- 空のファイル（空文字）/ 言語判定なし / トークン上限で素のテキストになった場合も同じボタンでコピーできる
- 成功表示は既存のコピーと同じ `useMessageCopy`（チェックアイコン + `コピーしました` を 2 秒）。失敗時は成功表示にしない
- 成功表示は表示中のタブ（`FileCopyButton` の key）に紐づけ、タブを切り替えたら捨てる。見えている本文が変わるため、戻っても表示を復帰させない
- 画像のプレビューには出さない。HTML はプレビュー中にソースを取得しないので出さず、ソース表示へ切り替えてからコピーする
- 2 MiB 超で本文を取得できないファイルは対象外（本文自体が無い。上限の値と変更手順は [上限](#上限)）
- 行番号付きコピー / 範囲指定コピーは持たない（持ち出しはツリーの行のダウンロードを使う。[ダウンロード](#ダウンロード)）

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

`.html` / `.htm` のタブ（`isHtmlPath`）は、行番号付きのソース表示と iframe で描画したプレビューを切り替えられる（`client/src/components/FilePreview.tsx`）。

### 方式

描画は iframe の src に `GET /api/files/html/<root 相対>` を指定し、応答ヘッダと iframe 属性の両方で隔離する。同じルートが要求パスの拡張子で分岐し、文書と同じディレクトリを基準にした相対参照（`./cat.png` / `../app.css`）を解決できるようにする（`<base>` の注入はしない）。

同じルートは BFF の **2 つのリスナー**に載る。アプリと同じリスナー（dev 4317 / prod 8015）は現行どおり隔離し、プレビュー専用リスナー（待受は env `PI_FILE_PREVIEW_LISTEN_PORT`、ブラウザから見たポートは env `PI_FILE_PREVIEW_PORT` で、既定はいずれも 4318。prod は `8017:4318` を publish してブラウザ側に 8017 を載せる）は storage を有効にする。プレビュー オリジンに載せるのはこのルート 1 本だけで、書き込み系（削除 / rename / アップロード / セッション API）は載せない（有効モードの文書からアプリの面を叩けないようにする）。どちらのオリジンで開くかはクライアントのタブごとのスイッチで選び（**既定はプレビュー オリジン**）、リクエストにフラグは付けない。

| 要求 | 応答 |
| --- | --- |
| `.html` / `.htm` | 従来どおりの HTML 文書（CSP + sandbox 付き。本文は `workspace.previewFile()`） |
| 画像（`raw` の allowlist） | `workspace.rawFile()` を流用した生配信（`Content-Type` / `Content-Length` / `no-store` / `nosniff`） |
| 音声（`mp3` / `m4a` / `ogg` / `oga` / `wav` / `flac`） | 画像と同じく `workspace.rawFile()` の生配信（100 MiB 以下） |
| `.js` / `.mjs` / `.css` / `.json` / `.txt` | `workspace.previewFile()` を流用し、拡張子から Content-Type を付けて返す |
| それ以外（`.svg` を含む） | 400 `Not a servable asset: <path>` |

- 文書以外は CSP を付けず、Content-Type と `nosniff` で守る。`.svg` と HTML はアセットとして配らない（同一オリジンでスクリプトを動かさない）。動画 / フォントは対象外
- アセットの上限はテキストが 2 MiB（UTF-8）、画像 / 音声の raw が 100 MiB。超える `.js` / `.css` は 400、100 MiB 超の画像 / 音声は 413 になり、プレビューから読めない
- 音声は raw のストリームをそのまま返す（`Range` / 206 は返さないので、シークで未バッファ位置へ飛ぶと全体を取り直す）
- `.json` は CSP に `connect-src` が無いため、現状のプレビュー内から読む手段が無い（`fetch` も classic script も不可）
- path はクライアントがセグメント単位で percent encoding する（`client/src/lib/fileUrl.ts`）。Hono 側（`:path{.+}`）は 1 回だけ decode する。文書 / アセット / エラー文書の分岐と応答ヘッダ（`Cache-Control: no-store` / `X-Content-Type-Options: nosniff`）は 2 つのオリジンで同じで、CORS ヘッダは付けない
- プレビュー オリジンは認証を持たない（アプリと同じ）。待受は env `PI_FILE_PREVIEW_LISTEN_PORT`（既定 4318）で、ポート使用中は BFF の起動が止まる（`scripts/dev.mjs` も同じ値の空きを先に確認する）。**待受とブラウザから見た値は独立で、ずれると iframe は繋がらない**ため、`pnpm dev` は `PI_FILE_PREVIEW_PORT` を正として両方を揃える（待受 env しか無いときはその値へ寄せる）

クライアント内で HTML 文字列を iframe へ流す方法（`srcdoc` / Blob URL / `data:` URL）は使わない。アプリの本番 CSP（`default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'self' http://*:<プレビュー ポート>`）は `srcdoc` / `blob:` の iframe に継承され、インラインの style / script がブロックされるため描画できない（`frame-src` を明示した後は `blob:` / `data:` がこの一覧に含まれないため、フレーム自体も拒否される）。Chromium に本番相当の CSP を当てて確認済み。`frame-src` に `'self'` を残すのは、落とすとスイッチで別オリジンを OFF にした（隔離へ戻した）ときの同一オリジン フレームが拒否されるため。

### 隔離（CSP と sandbox）

CSP は `server/src/routes/files.ts` の `HTML_PREVIEW_POLICY` 1 箇所から導出する。既定は Lv2（`cdn`）で、`assets` / `inline` へ切り替えると読み込めるリソースだけが狭くなる（クライアントへポリシーは配らない）。`sandbox` 段はリスナーごとに固定し、**iframe 属性にも同じフラグを書く**（sandbox は禁止フラグの和集合なので、有効になる能力は積になる。片方だけ緩めてもオペークのままで storage は使えない）。

| オリジン | リスナー | CSP と iframe 属性の sandbox フラグ | 用途 |
| --- | --- | --- | --- |
| アプリ | 4317（prod 8015） | `allow-scripts` | 隔離モード（スイッチで別オリジンを OFF にしたときだけ） |
| プレビュー | `PI_FILE_PREVIEW_LISTEN_PORT`（既定 4318。prod は `8017:4318` を publish） | `allow-scripts allow-same-origin allow-pointer-lock` | 既定のストレージ有効モード（`localStorage` など + ゲームの pointer lock） |

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

- 既定はプレビュー。他の拡張子は従来どおりソース表示で、切替（ソース / プレビュー と 別オリジンのスイッチ）は HTML のタブにだけ出す
- iframe の src は `client/src/api.ts` の `fileHtmlPreviewUrl(path)` が組み立てるパス形式の URL で、path はセグメント単位で encode する（`client/src/lib/fileUrl.ts`）。ストレージ有効側の URL は `fileStoragePreviewUrl(path, port)` で組み立てる（`http://<location.hostname>:<port>` の別オリジン。`location.host` は使わない = dev はアプリが Vite の 3000 に居るため）。ポリシー（CSP の段階）はクライアントへ配らない
- パス行の別オリジンのスイッチ（`ToggleSwitch` の `size="sm"`。パス行の ソース / プレビュー と同じ高さに揃える）がタブごとの配信元を切り替える（`role="switch"` + `aria-checked`）。**既定は ON（別オリジン）**で、OFF にすると現行どおりの同一オリジン URL + `allow-scripts` へ戻る。切替は iframe の src が変わる = プレビューが再読み込みされる。`title` には押した結果を状態別に書き、OFF のときは「別オリジンで開き直し、localStorage などを使えるようにします」、ON のときは「アプリと同じオリジンで開き直し、localStorage などを使えなくします」にする
- ポートは health の `filePreviewPort`（ブラウザから見たポート）で受ける。未取得の間はスイッチを無効にし、client にポートを焼き込まない。既定が ON でもポートが無ければ隔離のまま開く（`aria-checked` も実体に合わせる）。`App` が health から受けて、ファイルを開ける 4 面（設定 → ファイル / チャット右パネル / チャットの sheet / スキルのファイルタブ）の `FileBrowser` へ prop で渡す（面ごとに health を取り直さない）
- 配信元の選択はタブごとに保持し、タブを閉じると既定（ストレージ有効）へ戻る（`previewOriginFor` / `withPreviewOrigin` / `dropClosedPreviewOrigins` / `renamePreviewOrigins`）。表示モードと違い**保存はしない**ので、F5 と タブを閉じて開き直すと既定（ON）から始まる
- **配信元の切替は iframe の `key` を変えて要素ごと作り直す**。Chromium はナビゲーション開始時の sandbox フラグで文書を作るため、同じ更新で `src` と `sandbox` を書き換えると古いフラグ（`allow-scripts`）のまま読み込まれ、後から属性を直しても再ナビゲーションされない（CSP の `sandbox allow-scripts allow-same-origin allow-pointer-lock` は要素側の制限を打ち消せない = 和集合）。sandbox 属性が変わらないタブ間の切替は作り直さない（`src` だけが変わり、フラグはそのまま正しい）
- 表示モードの選択もタブごとに保持し、タブを閉じると捨てる（`previewModeFor` / `withPreviewMode` / `dropClosedPreviewModes`）。state は `FileBrowser` が持つ。選択は「タブを閉じるまで」が条件で、「再読み込み」は `FilePreview` を remount して本文だけを捨てる（本文はタブごとに保持するが、選択は再取得では戻さない）
- プレビュー中はソース本文を取得しない（`lang · N 行` も本文のコピーもソース表示のときだけ出す）
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
- 別オリジンの面が 1 つ増える（CORS ヘッダを付けず、`no-store` と CSP + sandbox で無害化する）。prod では**無認証でワークスペースの allowlist ファイルを読める面が 1 つ増える**が、載るのは GET の HTML プレビュー ルート 1 本だけ（書き込み系は載せない）
- ストレージ有効モードはプレビュー オリジン 1 つを全プレビューで共有するため、同じオリジンの別ファイルの storage も読める（キー衝突は自己責任）。ファイルごとの名前空間を UI で誘導するのは将来の話
- ストレージ有効モードで読めるアセットは隔離モードと同じ allowlist のまま（`.wasm` / `.svg` / フォント / 動画は 400）

## 画像プレビュー

画像（`png` / `jpg` / `jpeg` / `gif` / `webp` / `avif` / `bmp` / `ico`）の既定モードはプレビューで、`GET /api/files/raw` の URL を `<img>` の src にする（[api.md](api.md#画像配信raw)）。`GET /api/files/preview` はバイナリを 400 で拒否するため呼ばない（本文を取得しないので、"読み込み中…" も行数も出さない）。

- 配信は画像だけに制限し、SVG / HTML は allowlist 外として 400 になる（同一オリジンでスクリプトを実行させない）
- 表示は `object-contain` で親の幅・高さに合わせる。ピクセル等倍の切替や拡大縮小の UI は持たない
- **透過は本文の枠の市松で示す**（`styles/index.css` の `.image-canvas`）。色は `--c-soft` と `--c-ink` の `color-mix` で作り、6 テーマぶんの定義を足さずに追随する（1 タイル 16px = 8px 角）。市松は本文の枠いっぱいに敷き、画像の外側（`p-2` の余白）にも出る（VS Code などと同じ扱い。画像の箱の下だけに敷く案は、小さい透過画像で周囲が平らなままになるため採らない）。透明度の有無による出し分けはしない（判定に canvas の縮小が必要で、誤判定とモバイルのデコード負荷に見合わない）
- **パス行の右端に 寸法 · サイズ を出す**（例: `1536 × 1536 · 24.4 KB`）。寸法は `<img>` の `onLoad` の `naturalWidth` / `naturalHeight`（内在ピクセル。表示倍率は持たない）、サイズは `FileBrowser` がツリーの取得済みの行（`FileEntry.size`）から引いて `activeSize` で渡す。表記の組み立ては `client/src/lib/imageMeta.ts` の純関数で、**分かる項目だけを並べ、どちらも分からなければ行ごと出さない**
- サイズの取得に一覧を取り直さない（1 タブごとに余分な往復を作らない）。このため親ディレクトリが未取得の面（F5 で親を閉じていた場合、一覧の上限 500 件で載っていない場合）ではサイズが出ず、寸法だけになる。ツリーのサイズは「再読み込み」で画像本体と一緒に新しくなる（`invalidateFileTree` が取得済みの子を捨て、プレビューは `key` の張り替えで取り直す）ため、表示中の画像とメタの鮮度は揃う
- 寸法は表示中のタブのものだけを出す（読み込み結果をパスと一緒に持ち、タブを切り替えたら前のタブの値を使わない）。メタは `shrink-0` で、幅が足りないぶんはパンくずの横スクロールが吸収する（compact も同じ 1 行）
- 表示モードの切替は画像には出さない（ソース表示はバイナリなので意味が無い）。本文を取得しないので、コピーボタンも出さない
- 失敗したとき（404 / 400 / 画像以外の配信拒否）はブラウザーの読み込み失敗表示になる（`alt` は `<パス> のプレビュー`）。テキスト / HTML のようなアプリ側のエラー文言は出さない（タブは勝手に閉じない。`<img>` に `onError` を持たせるのは別 Issue）

## 画面と root

ツリーとプレビューの本体は `client/src/components/FileBrowser.tsx` で、root を props で受け取る。同じ実装を 3 面が別の root で使う。

| 画面 | 外装 | root | 出す条件 |
| --- | --- | --- | --- |
| 設定 → ファイル | `FileTreePage`（`SettingsPageLayout` + ヘッダ） | ワークスペース root 固定（`cwd=""` → `"."`） | 常時 |
| チャットの右パネル | `SessionFilesPanel`（ヘッダ + 閉じる） | 選択中セッションの作業フォルダ（`payload.cwd`） | desktop のチャット画面で、作業フォルダがあるときだけ（`client/src/lib/sessionFiles.ts`） |
| 設定 → スキルのファイルタブ | `ReadOnlySkillPanel`（`SkillDetailPanel` の中の 1 タブ） | SKILL.md の親ディレクトリ（root 相対。`client/src/lib/fileSkills.ts` の `fileSkillDir`） | `scope !== "builtin"` かつ root 相対の `.../SKILL.md` の親が取れるときだけ（組み込みの仮想パスと root 外の絶対パスは出さない）。**ダウンロード / 削除 / リネームは `readOnly` で出さない** |

- `FileBrowser` は root が変わると復元・取得・保存をやり直す必要があるので、呼び出し側が `key` を張り替える。パネルはセッションの切替で `SessionFilesPanel` ごと入れ替える（`FileBrowser` の `root` は mount の間一定）。スキルのファイルタブは選択したスキルごとに `ReadOnlySkillPanel` ごと入れ替え、初回にタブを開いたときだけ `FileBrowser` を mount する（以降は `display` で隠して保持する）
- 取り直しの入口は外装の「再読み込み」と run_end で共通の `reloadToken` に集める（`SessionFilesPanel` は ヘッダの「再読み込み」の回数 + `ChatState.runEndSeq` の合計を渡す）。mount 時の token では撃たない（root の切替は `key` が扱うため）。run_end は描画された `runStatus` の差ではなく、reducer が `run_end` で進める `runEndSeq` を起点にする（`run_start` と `run_end` が同じバッチで届くと React は 1 回の描画にまとめるため、画面側では `running` を観測できず取りこぼす。SSE が切れて `resync` で復帰したときも、`running` を抜けていれば reducer が進める）。実行中の `tool_end` ごとの更新はしない
- `GET /api/files` の path は root を前置する（`fileTreeFetchPath`）ので、パネルは `payload.cwd`（プロジェクト所属なら登録ディレクトリ、未所属なら `.u7agent/sessions/<id>`）を root として扱う。サンドボックス / API は変えない（同じファイルを設定 → ファイル からも開ける）

## ディレクトリの開閉

ディレクトリ行の開閉は、子の入れ物の高さを grid の行（`0fr` → `1fr`）で遷移させて見せる（`FileBrowser` の `.tree-fold`、遷移は `styles/index.css`）。`details` の折りたたみと違い開閉の状態は React が持つので、CSS は遷移だけを担う。子を `min-height: 0` / `overflow: hidden` で潰すため、`interpolate-size` に依存しない。

- 入れ物（`.tree-fold`）は開く前から置く。mount した要素には遷移の前の値が無いため、開いたときに初めて mount すると初回の開が瞬時になる
- **「読み込み中…」の行と内容は別の入れ物にする**（`open && !loaded` / `open && loaded`）。同じ入れ物の中で入れ替えると、開き切った後の高さ（`1fr` の解決値）は変わっても遷移が走らず、一覧の到着が飛んで見える（実測: 取得を 850ms 遅らせると 30px → 158px が瞬時になる）。分けると、畳まれる読み込み中の行と伸びる内容の 2 つの遷移が同じ長さで重なる
- 閉じた枝も**取得済みの内容は DOM に残す**（内容の入れ物は開閉に関わらず描き、`children` があるときだけ `Branch` を入れる）。畳むときも同じ遷移で潰すため。取得は `pendingFileTreeDirectories` の経路のまま（閉じた枝からは取りに行かない）
- 閉じている入れ物は `inert` にする（`data-open` と同じ条件で、ディレクトリが開いていても閉じている入れ物は対象）。高さ 0 で見えない行をフォーカスさせず、支援技術からも外す（取得が終わった後の「読み込み中…」が読み上げに残らない）
- `prefers-reduced-motion` では遷移させず瞬時に開閉する（`details` の折りたたみと同じ扱い）
- 高さの遷移の途中は行の位置が確定しないため、reveal はスクロールを遷移の後に合わせ直す。合図は `transitionend`（`grid-template-rows` の遷移だけ）にする: 遷移が走った枝にだけ listener が付くので、**祖先が既に開いているときは何も起きず**、直後の手動スクロールを巻き戻さない。`transitionend` は泡で届くため、**その入れ物自身の遷移だけ**を見る（`event.target === event.currentTarget`。兄弟の枝を開いても祖先の listener が鳴る）。遷移の長さを JS の定数に写すと CSS を変えたときに黙ってずれるため、待ち時間の定数は持たない（`prefers-reduced-motion` でも遷移が無く、最初のスクロールがそのまま正しい）
- 見え方は client に DOM テスト基盤が無いため自動では見ず、**手動確認**とする（テストは CSS の定義と配線と時間の一致だけを固定する）

## ツリーの reveal

ツリーでファイルの位置が分かるように、対象の祖先ディレクトリを開いて対象の行へスクロールし、しばらく一時ハイライトする（`FileBrowser`）。**画面の root は変えない**（サブツリーへ再ルートする機能は持たない）。表示するパスは常に画面 root 相対のままで、タブ・ドラッグ参照・confirm と同じ座標を使う。入口は 2 つで、どちらも同じ `revealRow` を通る。

- **ファイル参照からタブを開いたとき**（`openRequest` の適用時）。参照のファイルは深い階層にあることが多く、プレビューだけ開くとツリーのどこにあるか分からないため
- **プレビューのパンくずのクリック**。ソース表示のパス行はセグメントごとのボタンになり、押すとその階層をツリーで示す（表示中のファイル自身もボタン）

- 祖先を開くのは `lib/fileTree.ts` の `openFileTreeAncestors`（純関数）。取得済みの子・loading・error は保ち、未取得の祖先は `open` だけの状態を作る。取得は既存の `pendingFileTreeDirectories` の経路が親から順に拾うので、reveal 専用の取得経路は持たない
- スクロールは対象の行が現れてから行う（祖先の取得中は行が無い）。行は `reveal` の state と `revealRowRef` で受け、`tree` が進むたびに Effect を再実行して取りこぼさない。スクロール済みの `seq` は再実行で弾く
- 一時ハイライト（`ring-2 ring-focus ring-inset`）はスクロールのあと `REVEAL_HIGHLIGHT_MS`（1.6 秒）で消す。タイマーは掛け直しと unmount で掃除する
- reveal で開いた階層は通常の展開と同じく `filePreviewStore` の保存対象に入る（F5・面の往復で復帰する）。reveal の対象とハイライトは保存しない
- パンくずは画面 root 相対の祖先と表示中のファイルだけを並べる（画面 root 自体はツリーにその行が無く押せないうえ、各面のヘッダが同じパスを出す: チャット右パネルのヘッダ / 設定の caption / スキルのファイルタブの root 行）。全体パスは `fetchPath` のまま `title` に残す。項目の組み立ては `fileTreeBreadcrumbs` の純関数

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
- 復元は `useState` の初期化、要求は Effect で適用するため、要求が最後に効く（表示中のタブが要求のパスになる）。要求の適用時はツリーの祖先を開いて対象の行を示す（[ツリーの reveal](#ツリーの-reveal)）
- 表示モードは既存の選択規則のまま（未選択の HTML だけ既定でプレビュー。ユーザーがソースを選んだタブはソースのまま）
- compact の sheet は閉じたときに、クリックした button を `App` が保持して focus を戻す（`document.activeElement` はクリックした button を指すとは限らない）。起点がセッション切替などで消えていたら focus を移さない。トグルから開いたときは戻さない。Escape は dialog の標準動作で閉じる（プレビューの中にフォーカスがあると親へ届かない既知制約は HTML プレビューと同じ）
- provider は `App` が `rootCwd` / `cwd` / callback だけの memo 値で配る。要求 `seq` やパネル開閉を value に混ぜず、SSE の更新で過去の本文を再解析・再描画させない。インラインコード側だけが context を購読するため、独自 comparator を持つ `MdBlockView` / `MdList` / `MdListItemView` / `MdTable` に callback を通す必要がない

## ツリーの行のドラッグ（入力欄への参照）

デスクトップの右パネルのファイル行をチャットの入力欄へドロップすると、その行のパスが本文へ `@<作業フォルダ相対のパス>` として挿さる。**添付（アップロード）ではない**のでファイルは送られず、モデルが必要なときに `read` で開く（`@<path>` が cwd 相対の参照であることは `server/src/agent.ts` の `appendSystemPrompt` が説明する）。字面と区切りの規則は `client/src/lib/fileMention.ts` の純関数、ドロップの受け取りは `Composer` が持つ。

- ドラッグできるのは参照のパスが作業フォルダと一致する面だけ（`FileBrowser` の `canRef`。渡すのは desktop の右パネル）。設定 → ファイル はワークスペース root、スキルのファイルタブは SKILL.md の親ディレクトリで、パスの意味が違う。compact の sheet は全画面 modal で入力欄へ届かない
- ディレクトリ行はドラッグできない（`@<dir>` はファイルとして `read` できない）
- 積む型は参照専用の `application/x-u7agent-file-mention`（パス）と `text/plain`（`@<パス>`）。入力欄はこの専用の型を `Files` より先に見て、参照を添付へ倒さない。`text/plain` があるため、他のアプリ / 入力欄へ落とすと参照の字面になる
- 挿入位置はドロップ座標（`caretPositionFromPoint`。`caretRangeFromPoint` は textarea で正しい位置を返さないブラウザーがある）、取れなければ現在の選択。前後が非空白なら区切りに空白を足し、カーソルは参照の直後（続きを書ける位置）へ置く
- 空白・二重引用符・バックスラッシュを含むパスは `@"<パス>"` と二重引用符で囲む（`"` と `\` はエスケープ）。区切りに足す空白と同じ字がパスに入っていると、送信時の `trim`（クライアントの `value.trim()` とサーバーの本文）で末尾の空白が消えて別のファイルを指すため
- 存在確認も展開もしない。消えているパスでも挿せて、区切りの解釈はモデルに委ねる（[メッセージからの導線](#メッセージからの導線ファイル参照) の matcher とは別の規則）

## 行の操作メニュー（⋯）

行の右端の ⋯（`client/src/components/RowMenu.tsx`）に、その行の操作（ダウンロード / リネーム / 削除）を 1 つのメニューとして畳む。同じ ⋯ を左サイドバーのプロジェクト行 / セッション行とも共有する（[ui-layout.md](ui-layout.md#サイドバー)）。行ごとにアイコンを並べる方式では、幅の狭い列（当時は `@2xl:w-72` = 288px 固定。最大 3 スロット = 84px）で名前が数文字まで truncate され、1 行あたりのタブストップも最大 3 つあった。

- **出し分けの正は `client/src/lib/fileRowMenu.ts` の `fileRowActions`**。`null` = 行の操作領域ごと出さない（`readOnly`）、`[]` = 領域は出すが項目が無い（symlink。`aria-hidden` の `size-6` の空きスロット `EmptySlot` を 1 個だけ置いて時刻の右端をそろえる）と契約を分ける（`[]` だけで両方を表すと、`FileBrowser` 側で `readOnly` と symlink を区別できない）。項目は ダウンロード → リネーム → 削除 の順で、ディレクトリのダウンロードだけラベル「ZIP でダウンロード」+ 2 行目「ビルド成果物と依存を除く」を持つ（以前の `title` の開示をメニュー項目へ移した）。条件は移行前と同じで、[ダウンロード](#ダウンロード) / [リネーム](#リネーム) / [削除](#削除) をそれぞれ参照
- **項目の型と、位置 / キーボード移動の計算は `client/src/lib/rowMenu.ts` の共有部**（`RowMenuAction` / `rowMenuPlacement` / `rowMenuAnchorVisible` / `nextRowMenuIndex`）。画面ごとの出し分けはここ（`fileRowMenu.ts` の `fileRowActions`）と `client/src/lib/sidebarRowMenu.ts` の `projectRowActions` / `sessionRowActions` が持ち、描画は `RowMenu.tsx` 1 箇所で共有する
- **外装は native `popover="auto"`**。top layer に載るのでツリーのスクロール枠（`overflow-y-auto`）に切られず、外側クリックと `Escape` は標準の light dismiss に任せる。本体は常時 mount し、React の条件付き mount で出し入れしない（閉じている間の非表示は UA 既定の `display: none`）。開閉の正は popover の状態で、React は `toggle` イベントで `aria-expanded` を写すだけにする
- **⋯ には `popoverTarget` を付け、`onClick` で既定動作を打ち消してから `showPopover()` / `hidePopover()` を呼ぶ**。popover の外にある ⋯ の click は light dismiss（pointerup）の後に届くため、`popoverTarget` が無いと「開いた状態で ⋯ を押す」たびに閉じて開き直り、トグルが効かない。`popoverTarget` は UA の activation behavior も持つので、同じトグルを二重に走らせないよう `preventDefault()` する。開閉の入口はこの 1 つで、標準の close（Escape / 外側クリック）も含めて状態は `toggle` イベントで観測する
- **位置は開いた時に `getBoundingClientRect()` から計算する**。UA 既定（`inset: 0` / `margin: auto` / `border` / `padding` / `overflow`）をクラスで打ち消してから `fixed` の `left` / `top` を直接書く（React の `style` では持たない）。純関数 `rowMenuPlacement` が ⋯ の右下（右端をそろえる）を既定に、右端 / 下端で収まらないときは左 / 上へ倒して viewport へ clamp する。スクロール（capture）と resize で取り直し、⋯ がツリーのスクロール枠 / viewport の外へ出たら閉じる（`rowMenuAnchorVisible`）。**React の再レンダーでレイアウトが変わるリサイズ（左サイドバーの docked ⇄ overlay はファイルツリーの幅も動かす）は resize イベントより後に DOM へ届く**ため、commit 後（`useLayoutEffect`）にも置き直す。これが無いと、境界をまたぐ 1 回のリサイズで ⋯ だけが左バーの幅の分だけ動き、次のイベントまでメニューが取り残される。この追従は境界を跨いでも生存する行（メイン列のファイルツリー）の話で、左サイドバーの行は境界で `Sidebar` ごと unmount されて ⋯ も行と一緒に消える（メニューだけが取り残されない。追従はしない）。CSS anchor positioning は Baseline 2026-01 で動く環境の下限を揃えられないため使わない
- **キーボードは親の `role="menu"` の容器で受ける**。項目は `role="menuitem"` / `tabIndex={-1}` で、↑↓ は `nextRowMenuIndex` で移動し端では止まる（循環しない）。`Tab` / `Shift+Tab` は既定のフォーカス移動に任せ、`focusout`（`relatedTarget` がメニューの外）で閉じる。`Escape` は閉じるのを標準挙動に任せ、伝播だけ止める（`App` の「設定ページからチャットへ戻る」に届かせない。[ImageZoom](markdown.md#画像の拡大表示) と同じ扱い）
- **開いた直後に座標を確定してから先頭項目へフォーカスを移す**。`Escape` は native の復帰で ⋯ へ戻す。**項目の選択では ⋯ へ戻さない**（native の復帰は閉じる時にフォーカスが popover 内にあるときだけ起きるので、隠す前にフォーカスを外へ退避させてから `hidePopover()` する）。外側クリック / `focusout` / 行の消滅では戻り先が無いので何もしない（明示的な `focus()` は足さない）。⋯ 自身の押下で focusout が走る場合は、直後の click がトグルとして働くよう閉じるのを保留する
- **削除の項目は danger のトーン**（`MenuItem` の `danger`）。寸法は `MenuItem` の 1 箇所のまま（`min-h-7.5` / `px-2` / `text-xs` / `size-4` のアイコン箱）で、メニュー側に新しい寸法を書かない。⋯ の読み上げ名は `<名前> の操作`（どの行の操作かを含める）
- 項目の選択・`focusout` で閉じるときは、`window.confirm` / `window.prompt` を出す前に `hidePopover()` を通す（開いたままだとダイアログがメニューの背後に残る）
- 実ブラウザーでしか確かめられないもの（light dismiss / top layer / スクロール追従 / フォーカスの実挙動）は自動テストに残さず、`client/test/fileRowMenu.test.ts` は純関数と描画属性、自前の close が `hidePopover()` を通ることまでを固定する

## 削除

誤ってアップロードしたファイルやエージェントの成果物を取り消す導線。通常ファイルとディレクトリの行の右端の ⋯（[行の操作メニュー](#行の操作メニュー)）の「削除」から、`window.confirm`（セッション / プロジェクト / エージェント削除と同じ）で確認してから `DELETE /api/files` を呼ぶ。

- **出す画面は設定 → ファイル（ワークスペース root）とチャット右パネル（セッションの作業フォルダ）の 2 つ**。`FileBrowser` に画面を分ける `canDelete` は持たせず（`onDelete` も必須にする）、通常ファイルとディレクトリの行の ⋯ には常に「削除」を出す。プロジェクトのソースを GUI から消せる点は「ワークスペース全体を見ながら片付けたい」という要望を優先して受け入れ、事故防止は confirm のパス表記が担う。**dev の root は `PI_APP_CWD`（既定は `projects/u7agent` 自身）なので、自分のソースも消せる**
- **スキル設定のファイルタブ（読み取り専用の面）は `readOnly` を渡し、ダウンロード / 削除 / リネームの ⋯ を行ごと出さない**（スキルの補助ファイルは「ファイル」画面から持ち出し / 片付けする）。既定は false なので、上の 2 画面の挙動は変わらない
- **confirm にはその画面の root 相対（ツリーに見えているパス）を出す**。ファイルは `client/src/lib/fileTree.ts` の `fileTreeDeleteConfirm(path)`（`「<path>」を削除しますか？この操作は取り消せません。`）で、設定 → ファイル は `.u7agent/uploads/3a7bfba36f/shot.png`、チャット右パネルは作業ディレクトリ相対（`node/main.ts` など）になる。ディレクトリは `fileTreeDeleteDirectoryConfirm(path)` で、配下ごと消えることを示す `「<path>」と配下のファイルをすべて削除しますか？この操作は取り消せません。` を出す。パネルでワークスペース root 相対（見えていない長いパス）を出すと行との対応が取れないため、見えているパスに合わせる（ワークスペース root を見る設定 → ファイル では両者が一致する）
- **通常ファイルは 1 件、ディレクトリは配下ごと消える**（`recursive=true`。空ディレクトリも同じ導線）。削除範囲は一覧の上限（500 件 / ディレクトリ）に縛られず、未表示の子も消える。**symlink は行に導線を出さない**（サンドボックスが 400 で拒否する。ファイル / ディレクトリとも。symlink の行には既存の「リンク」バッジが付く）。`.u7agent/uploads/<id>/` はフラットだが、セッション作業フォルダの `uploads/` などの片付けにディレクトリ削除を使える
- **削除したディレクトリ配下の symlink はリンクだけが消え、リンク先は残る**（`rm -rf` と同じ）。削除対象そのものが symlink なら 400 で、リンクもリンク先も残る
- 行は選択（本文を開く）と ⋯ の 2 つの `button` に分ける（`button` の入れ子は作れない）。⋯ は常時見せ、hover で隠さない（タッチ端末で押せなくなるため）。削除は ⋯ の中へ移り、1 行あたりのタブストップは ⋯ の 1 つに縮む（移行前は最大 3）
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

名前を直したいフォルダを削除して作り直さずに済むよう、設定 → ファイル のフォルダ行にリネームの導線を出す。行の右端の ⋯（[行の操作メニュー](#行の操作メニュー)）の「名前を変更」から、削除と同じ流れの `window.prompt` で新しい名前を入力し、`POST /api/files/rename` を呼ぶ。

- **出すのは設定 → ファイル（ワークスペース root）だけ**。`FileBrowser` の `canRename` prop（既定 false）で切り、`FileTreePage` だけが true を渡す。チャット右パネル（`SessionFilesPanel`）は対話中のパスと食い違うため出さない。スキル設定のファイルタブは `readOnly` で削除と一緒に消す（`canRename` も渡さない）
- **リネームを出すのはフォルダ行だけ**。UI からファイルは改名できない（API はファイル / ディレクトリの両方を受ける。移動（親ディレクトリの変更）は非ゴール）。symlink の行にも出さない（サンドボックスが 400 で拒否する）
- **prompt の初期値は現在の名前**（`fileTreeRenamePrompt(path)` が見出し、現在の名前を第 2 引数に渡す）。取り消し（`null`）・空・未変更なら何もしない。削除の `window.confirm` と同じく、同じ行の二重送信は実行中のパスを持つ ref で弾く。run 中でも操作できる（削除と同じでガードなし）
- **成功後はツリーとタブ・表示モードの経路を新しい名前へ張り替える**。親一覧の行の名前を差し替え（`renameFileTreeEntry`）、配下の state のキー（`renameFileTabs` / `renamePreviewModes`）を移す。開いている階層と取得済みの子はそのままなので親の再取得は起きず、タブの本文だけを新しい経路で取り直す（プレビューの `results` は経路ごとなので、新キーで再取得する）。**取得中だった一覧は `loading` を落として新しい経路で取り直す**（飛んでいた応答は旧キーへ着地するため、持ち越すと改名したフォルダが「読み込み中…」のまま固定される）。画面の root 相対は親 + 新しい名前で組み立てる（応答の実パスは symlink 経由の要求でツリーのキーとずれるため）
- **失敗は親ディレクトリの行に理由を出す**（`applyFileTreeError`。削除と同じ。同名 409 の文言をそのまま出す）。行はそのまま残る
- 改名先が既存の名前なら 409 で何も変えない（上書きも自動採番もしない）。大文字小文字だけの変更は許す（[sandbox-api.md](sandbox-api.md#post-v1filesrename)）
- リネームで登録プロジェクトの root や `.u7agent/sessions/<id>` を改名すると、プロジェクト / セッションの `payload.cwd` は追随しない（削除でも同じ。保護パスは設けない）

### 既知の制限（リネーム）

- **pending 一覧の復活**: 削除と同じ。改名直前に飛んでいた旧名の親一覧の応答が後から適用されると、旧名の行が復活し得る（クリックすると 404 になり、次の取得で消える）
- **同名の競合（TOCTOU）**: サンドボックスの同名判定は `lstat` → `rename(2)` の順なので、その間に同じ名前が作られると上書きされうる（Node に no-replace の rename が無い。単一ユーザーでエージェントと同時に触った場合のみ。[sandbox-api.md](sandbox-api.md#post-v1filesrename)）
- リネーム先が既存タブと同じ経路になったとき（外部で消えたファイルのタブが残っている等）は、重複したタブを作らず先のタブへ寄せる

## ダウンロード

ワークスペースからファイル / フォルダを持ち出す導線。ツリーの行の右端の ⋯（[行の操作メニュー](#行の操作メニュー)）のダウンロード項目から、**事前チェック（`GET /api/files/download/check`）を通してから**保存を始める。通常ファイルは生バイトのまま、フォルダは ZIP になる。

- **出す画面は設定 → ファイル（ワークスペース root）とチャット右パネル（セッションの作業フォルダ）の 2 つ**。行の右端は 時刻 + ⋯ の 1 スロットで、メニューの項目が ダウンロード → リネーム → 削除 の順になる。ダウンロードは通常ファイルとフォルダの行に出る。**スキル設定のファイルタブは `readOnly` で ⋯ ごと消す**（組み込みスキルはワークスペース外でサンドボックスから解決できないため、削除 / リネームと同じ扱い）
- **symlink の行には出さない**（サンドボックスが 400 で拒否する。削除と同じ判定）。**除外規則に一致する名前の行にも出さない**（`node_modules` など。出すと押した直後に 400 になるため）。項目の無い行も `size-6` の空きスロットだけを残し、時刻と ⋯ の右端をそろえる
- **除外名は設定 → アーカイブ（`/settings/archive`）で編集する**。一覧はアプリデータの SQLite に保存し、未設定のときは既定の一覧（`DEFAULT_ARCHIVE_EXCLUDE_NAMES`）、保存するとその一覧が正になる（`[]` は「除外なし」。空にすると `node_modules` も入るため画面が警告する）。規則はベース名の完全一致・全階層で、symlink は一覧に関係なく常に対象外（[api.md](api.md#アーカイブの除外名)、[persistence.md](persistence.md#アプリデータsqlite)）
- **除外名は設定ストアの実効値（`GET /api/settings/archive` の `excludeNames`）を `App` から prop で受ける**（`app.archiveSettings.settings?.excludeNames ?? []`）。取得元を health から app 状態へ移したのは、設定の保存直後に再 mount なしで 設定 → ファイル とチャット右パネルの両方が追随するため。未取得の間は空（= 除外なし）として導線を出し、実際の判定はサーバーの `check` に任せる（ずれた瞬間は `check` が 400 を返し、ツリーのエラー行に出る）
- **クリックで先に `check` を呼び、結果で振り分ける**。`kind: "archive"` で `skipped` が 1 件以上あるときだけ `window.confirm` を 1 回出し、**サイズ / 件数の超過（413）・除外名のディレクトリそのもの（400）は確認より先にエラー行へ出す**（ダウンロードは始まらない）。確認の文言は `client/src/lib/archive.ts` の `archiveConfirmMessage` で、`「<名前>」を ZIP でダウンロードします。` + `含まれるファイル数 N 件 / 合計サイズ X` + `除外: node_modules, dist`（**実際に落ちた名前をサーバーの `skipped` からそのまま出す**）。除外 0 件のフォルダと通常ファイルは確認なしで始まる
- **開始は `<a download>` のプログラム的クリック**（`startArchiveDownload`）。本文を `fetch` して state に保持しないため 100 MiB をメモリに載せず、ページ遷移も起きない（チャットのタブ・ツリーの開閉・実行中のランはそのまま）。`href` は `fileDownloadUrl` の URL、`download` 属性は `check.name`（サーバーの `Content-Disposition` と同じ名前。日本語名も化けない）
- **失敗（400 / 404 / 413 / 502 / 503）は削除 / リネームと同じく親ディレクトリの行に出す**（`applyFileTreeError`。生 JSON をブラウザに開かせない）。行はそのまま残り、「再読み込み」で消える
- メニュー項目はフォルダが「ZIP でダウンロード」+ 2 行目「ビルド成果物と依存を除く」、ファイルが「ダウンロード」で、⋯ の読み上げ名は `<名前> の操作`（除外の開示は確認ダイアログとメニューの 2 行目だけ。正確な規則は [sandbox-api.md](sandbox-api.md#get-v1filesdownload)）
- 同じ行の二重送信は実行中のパスを持つ ref（`downloadingRef`）で弾く。ダウンロード中も他の行は操作でき、ツリーの再取得やラン終了も止めない
- **上限は合計 100 MiB / 10,000 エントリ**（サンドボックスの定数）。単体ファイルも同じ 100 MiB で、メッセージは 1 本（`Download is too large (max … bytes)`）。上限は本文の送出前に判定するため、超過は「切れた zip」ではなく 413 になる
- **ZIP の中身はフォルダ直下をルートに置く**（フォルダ自身は前置せず、ダウンロード名 `<フォルダ名>.zip` が担う）。空ディレクトリは末尾 `/` のエントリとして残り、展開後に空フォルダとして復元される（**空のフォルダ自体を配ると中身が無いので空の zip になる**）。symlink は辿らず、エントリにも入らない
- 保存名・`Content-Type`・長さはサンドボックスが決め、BFF はストリームとヘッダを中継する（[api.md](api.md#ダウンロード)）。zip は長さを確定できないため `Content-Length` を付けない（ブラウザは保存表示で進捗を出す）

### 既知の制限（ダウンロード）

- **途中失敗は切れた zip になる**: 事前 walk の後にファイルが消えた / 読めなくなった / 接続が切れた場合、ブラウザは失敗として扱うが部分ファイルが残り得る（事前 walk で大半は防げる）。レジューム（`Accept-Ranges`）と進捗 UI は持たない
- **事前 walk と圧縮の間の増減で見積りがずれる**: 増えても実害はサイズだけで、減るとエントリが黙って落ちる（上限は近似になる）
- **クライアントが握る除外名（設定ストアの実効値）と実効値がずれる瞬間がある**: その場合は `check` が拒否し、ツリーのエラー行に出る（導線が出ないより先に整合する）
- **除外の拡大で「忠実なコピーではない」性質が強い**: 何が入らないかを開示するのは確認ダイアログとメニューの 2 行目だけで、正確な規則は [sandbox-api.md](sandbox-api.md#get-v1filesdownload) の記述を正とする
- ⋯ に畳むと削除が 1 クリック増え、深い階層では indent（16px × 深さ）の分だけメニュー化後も名前が数十 px しか戻らない階層が残る。同時ダウンロードの制限は持たない（単一ユーザー前提。zip 1 本あたりは 1 リクエスト）
- Zip64（4 GiB 超 / 65,535 エントリ超）は書かない。上限で回避する（緩和は別）

## 時刻

ディレクトリ行 / ファイル行の右端に更新時刻（`FileEntry.mtime`、epoch ms）を出す。`mtime` を持つ行だけに出すので、stat できない壊れた symlink の行には出ない。

- テキストはファイル行専用の `fileTimeLabel`（`client/src/lib/messageTime.ts`。今日 → `08:53` / 今年 → `9/21 08:53` / それ以前 → `2026/9/21 08:53`）。メッセージの `messageTimeLabel` は今年の分を `9/21` と日付だけで出すが、一覧では更新の前後を比べたいので月日を出すときも時刻を添える（今日 / 今年 / それ以前の分岐は両者で `timeScope` を共有する）。`title` に `messageFullTimeLabel`（`2026/9/21(日) 08:53`）を出す。`<time dateTime={new Date(mtime).toISOString()} title={…}>` の形の前例はチャットの吹き出し（`MessageView.tsx`）。数字の幅で行ごとにガタつかないよう `tabular-nums` を付ける
- 時刻に時間を添えた分だけ名前の幅が減る。**コンテナ幅が `@2xs`（288px）未満では、時刻と末尾スロットを入れた `RowTail` を `basis-full` で次の段へ落とし、行を 2 段にする**（`@2xs:basis-auto` で 1 段に戻る）。右パネルの下限は `min(360px, 30vw)`（未指定のときの幅。幅はハンドルで選べる。[ui-layout.md](ui-layout.md#モードごとの構成)）なので desktop の最小幅 720px では 216px になり、ここで 1 段に押し込むと名前の幅が先に尽きる。名前の幅が 0 になっても flex は行のアイコン（ディレクトリは chevron 16 + folder 16 + gap 8 = 40px）を縮められないため、1 段のままだとアイコンが時刻の上へはみ出す（実測: 幅 216px・`2025/9/5 23:05` の行でファイルアイコンが時刻に 9.92px 重なり、名前の幅は 0px）。2 段にすると名前は行幅いっぱいを使え（実測: 幅 216px で `node_modules` 87.17px・`package.json` 79.02px）、行高は 30px から 52px になる
- **ディレクトリ行もファイル行と同じ「div + 操作 button」の形にする**（以前は行全体が 1 つの `button`）。時刻を `button` の中に入れると accessible name に時刻が混ざり、時刻のクリックでも開閉してしまうため。`button` は `flex-1` のままなので、行のクリック領域は実質変わらない
- 時刻の右端をそろえるため、両行の右 padding を `pr-2` にそろえ、行の末尾に `size-6` の ⋯ のスロットを 1 つ置く（行の右端は共通の `EntryRowActions`、その入れ物は `RowTail`）。時刻とスロットが接して見えないよう、行の `gap-x-1.5` を名前 / 時刻 / スロットの間隔にし、一覧の左右の余白は `px-4`（行全体の外側）で持つ。項目の無い行（symlink）だけ `aria-hidden` の空きスロット `EmptySlot` になり、設定 → ファイル と チャット右パネル の差はメニューの中身だけになる（[行の操作メニュー](#行の操作メニュー)、[ダウンロード](#ダウンロード)）。⋯ は常時表示なので、設定 → ファイル は移行前に比べて名前へ 60px（`size-6` + `gap-x-1.5` の 2 スロット分）広がる。px の一致は client に DOM テスト基盤が無いため自動では固定せず、**手動確認**とする（`client/test/fileBrowserRowTime.test.ts` は両行が同じ形であることまでを、`client/test/fileRowMenu.test.ts` は⋯ の幅と空きスロットの一致と出し分けを固定する）
- 意味は「更新」。サンドボックスが返せるのは mtime で、`birthtime` は overlayfs 等で 0 になり得るため使わない（アップロード / エージェントの書き出しでは実質の作成時刻と一致する）
- **サンドボックスの一覧はディレクトリにも `mtime` を付ける**（`size` はファイルだけ。ディレクトリの `size` はファイルの内容量を表さない）。規則は symlink は辿った先（`stat`）、それ以外は `lstat` を全エントリに適用し、`classifyEntry` が種別判定に使った `stat` は捨てずに再利用する（増える syscall は素のディレクトリの `lstat` 1 回）。ディレクトリ symlink にはリンク先の mtime が付く（一覧が実体で表す既存契約と一致）
- 一覧は追加の更新を持たないので、**行の時刻は「再読み込み」と run 終了でしか更新されない**。削除しても親ディレクトリ行の `mtime` は次の取得まで古いまま

## 復帰（F5・画面の往復）

ファイル画面は、F5 や チャット ⇄ 設定 の往復、パネルの閉じ開き、セッションの切替でも直前の状態に戻る（`client/src/lib/filePreviewState.ts`）。復帰は `FileBrowser` の mount ごとに 1 回で、root が変わるたび（設定を離れて戻る / パネルを開き直す / セッションを切り替える / スキルのファイルタブを開き直す）に再適用し、通常の render やツリーの再取得・「再読み込み」では適用しない。保存は cwd ごとに分かれ、設定 → ファイル は常に `"."`（ワークスペース root 固定）、パネルは `payload.cwd`、スキルのファイルタブは SKILL.md の親ディレクトリを使うので、同じファイルを別の面で開いてもタブは混ざらない。保存値に残った他 cwd はそのまま残す（掃除はしない）。

- 復帰するのは タブの並び / 表示中のタブ / タブごとの表示モード / 開いているディレクトリ。配信元の選択は**保存しない**（F5 とタブを閉じるで既定の ON に戻る）。本文・children・loading・error は保存しない（他キーや複数 cwd と合算した容量と、鮮度の問題）。復帰後に本文を取得し直すため、表示中のタブ以外は選択したときに取得する（HTML は `/api/files/html/<path>`、ソースは `/api/files/preview`）
- 親を閉じた子の open は保持し、保存された子のために親を勝手に開かない。root は常に開く。取得は既存の「可視の親から子へ」の経路のままで、親を開いた時点で子の open が効く
- 消えていたファイルのタブは残し、本文の取得エラーをそのまま出す（勝手に閉じない）。削除済みディレクトリの枝は一覧の取得で落ちる。listing が `truncated` のとき未掲載の枝も落ちるため、完全な復元は保証しない
- 「再読み込み」はタブ・表示モード・展開を保ったまま本文だけを取り直す。最後のタブを閉じた状態（保存する内容が無い）は cwd ごと消すので、F5 後も空のままになる
- 保存値が壊れている / 形が合わない cwd は捨てる（他の cwd は残す）。9 枚のタブを持つ保存値も捨てる。これは通常操作の 9 枚目で最古を落とす `FILE_TAB_LIMIT` とは別の契約
- 保存領域が使えない環境（SecurityError / quota 超過）では、write が失敗した cwd をメモリ snapshot として持ち、同一セッション内の往復は復元できる。F5 を跨ぐ復元は保証しない（古い保存値が戻り得る）。保存キーと上限の全体は [frontend.md](frontend.md#保存キーと保存範囲)

## テスト

| テスト | 固定すること |
| --- | --- |
| `client/test/fileCode.test.ts` | 拡張子の言語判定 / 正規化と行数 / コピーする本文（正規化後・行番号なし・空文字）/ 上限でのフォールバック / 例外を投げない / 描画側が DOM 文字列とインライン style を使わない / HTML の判定 / iframe が sandbox 付きで 2 つの URL ヘルパ（隔離 / 有効）を使う（行番号の列と行数の数え方はチャット本文と共通で [markdown.md](markdown.md#コードブロックの行番号)） |
| `client/test/fileTabs.test.ts` | 表示モードの既定（HTML と画像だけプレビュー）/ 表示モードと配信元の選択の保持と破棄（配信元の既定は別オリジン = ストレージ有効）/ タブの開閉と上限 / ディレクトリ配下のタブの一括削除（接頭辞境界と繰り上がり）/ リネームの経路の張り替え（並び・表示中の保持、配下、重複の排除、表示モードと配信元）/ 保存値からの復元（表示中の繰り上がりと上限） |
| `client/test/toggleSwitch.test.ts` | 共有スイッチの寸法（既定の md は通知設定の旧寸法のまま / `sm` はプレビューのパス行と同じ高さ）/ `role="switch"` と `aria-checked`・丸の印・`disabled` / 押下で `checked` を反転 |
| `client/test/filePreviewStorageMode.test.ts` | 別オリジンのスイッチ（既定は ON = 別オリジン + `allow-scripts allow-same-origin allow-pointer-lock` / OFF はアプリ オリジン + `allow-scripts` / ポート未取得では無効で隔離のまま / `role="switch"` と `aria-checked`、`ToggleSwitch` の `size="sm"` / ラベルが `別オリジン` で `title` が押した結果になること / 新しいタブは切替と無関係に常に別オリジン / ポートを client に焼き込まない / health から `FileBrowser` 経由で受ける / 切替で iframe を作り直す `key`）（`react-dom/server` の描画 + ソース走査。sandbox フラグが読まれる時点は Chromium の実挙動なので E2E で見る） |
| `client/test/filePreviewNewTab.test.ts` | 新しいタブで開く（パス行に置いて HTML プレビュー中だけ出す / 常に別オリジンの `fileStoragePreviewUrl(fetchPath, filePreviewPort)` を開き、ポート未取得のときだけ `fileHtmlPreviewUrl(fetchPath)` へ倒す / `target="_blank"` + `rel="noreferrer noopener"` で `window.open` を使わない / アイコンだけのリンクに `aria-label` と `title`）（ソース走査） |
| `client/test/filePreviewCopy.test.ts` | 本文のコピー（パス行に置く / `reveal` を渡さない / 表示中の本文を渡す / 画像と HTML のプレビューでは出さない / タブを切り替えたら成功表示を捨てる） |
| `client/test/filePreviewImage.test.ts` | 画像プレビューの下地とメタ（メタはパス行に置いて画像タブだけに出る / `.image-canvas` が市松で、色はテーマのトークンだけで作り 1 タイルの大きさを持つ / 寸法は `onLoad` の内在ピクセルから取り、表示中のタブの値だけを出す / サイズはツリーの行から引いて `activeSize` で渡す）（ソース走査） |
| `client/test/imageMeta.test.ts` | 画像メタの表記（寸法とサイズの両方 / 片方だけ / どちらも無ければ null / 不正値の落とし方と 0 B） |
| `client/test/filePreviewTabClose.test.ts` | タブを中クリックで閉じる契約（`button === 1` だけ / タブの箱で受ける / down 側の既定動作を止める / `×` を残す） |
| `client/test/fileTree.test.ts` | 開閉・子のマージ・エラー保持 / 削除した行だけを落として他を保つこと / 削除の confirm 文言（ファイル / 配下ごとのディレクトリ、画面の root 相対パス）/ ディレクトリ削除後の枝の prune（接頭辞境界と own プロパティ契約）/ リネームの prompt 文言と、親の行の名前差し替え・配下キーの張り替え・開閉と取得済みの子の保持（接頭辞境界・未取得の親・`__proto__`）/ 取得中のリネームで loading を落として新しいキーで取り直すこと（旧キーの応答で新キーを汚さない）/ 保存する展開の抽出と復元（root の初期化、親を閉じた子の open、truncated）/ reveal の祖先（root から近い順・root 直下は空・同 object を返す条件・loading と子の保持・`__proto__`）/ パンくずの項目（root 相対の祖先とファイル）/ 取得済みの行の引き（未取得の親・一覧の上限外・前方一致・`__proto__`・再読み込み後） |
| `client/test/fileTreeReveal.test.ts` | reveal の配線（参照の適用時に祖先を開く / パンくずと `revealRow` を共有 / 行が現れてからスクロール / 一時ハイライトとタイマーの掃除 / 対象の行だけが ref とハイライトを持つ / 合わせ直しはその入れ物自身の遷移だけを対象にすること（泡で届いた兄弟の枝の遷移を弾く））と、パンくずの構造（画面 root を出さない / root 相対の祖先とファイルはボタン / 全体パスは `title` / `aria-current` / クリックは画面 root 相対のまま）（`react-dom/server` の描画 + ソース走査） |
| `client/test/fileTreeFold.test.ts` | ディレクトリの開閉（`.tree-fold` が grid の行を 0fr → 1fr へ遷移させる / 子を潰す `min-height` と `overflow` / 入れ物を開く前から置き、読み込み中と内容を別の入れ物にして閉じた枝の内容も残すこと / 閉じている入れ物の `inert` / `prefers-reduced-motion` で遷移しないこと / reveal の合わせ直しが遷移の長さを JS に写さず `transitionend` を合図にすること）（ソース走査） |
| `client/test/fileRowMenu.test.ts` | 行の操作の出し分け（readOnly は `null` / symlink は `[]` / ダウンロード → リネーム → 削除 の順と条件 / ディレクトリの ZIP ラベルと 2 行目の開示）/ ⋯ の `aria-haspopup`・`aria-expanded` と本体の `role="menu"`・`aria-labelledby`、項目の `role="menuitem"`・`tabIndex=-1`・並び順と danger / 位置の純関数（右端・下端での反転と clamp）/ 可視判定 / ↑↓ の端止まり / 自前の close が `hidePopover()` を通り、`Escape` が伝播だけ止めること（`react-dom/server` の描画 + ソース走査） |
| `client/test/fileBrowserRowTime.test.ts` | ディレクトリ行とファイル行が同じ形の時刻と ⋯ を持つこと（`<EntryTime at={entry.mtime}>` / `flex-wrap … gap-x-1.5 gap-y-1 rounded-lg pr-2` / 共通の `RowTail` + `EntryRowActions`）/ 狭い面で行を 2 段にする契約（`RowTail` の `basis-full` と `@2xs:basis-auto`）/ 行の右端が ⋯ 1 個で、項目 0 の行だけ空きスロット（`aria-hidden` の `size-6`）へ落ちること / `readOnly` では両行とも行の操作ごと消えること / 時刻が開閉の `button` の外にあること / 削除が種類ごとに confirm と API を分けること（ディレクトリは `deleteDirectory` と配下の state / タブの除去）/ 時刻が `fileTimeLabel` と `title` の完全な表記を使い、`mtime` 無しの行には出ないこと |
| `client/test/fileDownloadRow.test.ts` | ダウンロードの出し分け（ファイル / フォルダ行のラベルと 2 行目の開示 / 除外名・symlink 行には出ない / `readOnly` は行の操作ごと消える）/ 確認文言（実際の除外名 / 件数 / サイズ表記 / ディレクトリだけ）/ `check` を先に通して `<a download>` で開始すること / 失敗をツリー内のエラー行へ出すこと / 除外名を app 状態から prop で受け取り、`FileBrowser` が health を取りに行かないこと（純関数 + ソース走査） |
| `client/test/archiveSettings.test.ts` | 除外名の下書きの純関数（実効値からの初期化と配列を共有しないこと / dirty の比較（未設定のまま既定を保存させない）/ 追加の trim・空・重複・上限 / 削除 / 検証（サーバーと同じ 1 セグメント名の規則と件数上限）） |
| `client/test/archiveSettingsPage.test.ts` | 設定 → アーカイブの描画（未設定バッジ / 上書き中 / 行と件数 / 明示空の警告 / note のエラー / 読み込み中と失敗 / 行がカードの入れ子になっていないこと（枠と面を持たず、削除が行の右端に常時出る））と配線（保存 → `PUT` / 既定に戻す → `DELETE` / 応答を app 状態へ反映 / 行の出し分けが app 状態の実効値を使う）（`react-dom/server` の描画 + ソース走査） |
| `client/test/fileBrowserRename.test.ts` | リネームの出し分け（`canRename` のフォルダ行だけ / ダウンロードの後ろ・削除の前 / ファイル行と symlink 行には出ない / 既定は出さない）/ `readOnly` は行の操作ごと消えること / prompt の初期値と空・未変更の no-op / API への委譲とツリー・タブ・表示モードの張り替え・失敗の表示 / 渡すのは `FileTreePage` だけ、`readOnly` はスキルのファイルタブだけ（純関数 + ソース走査） |
| `client/test/readOnlySkillPanel.test.ts` | 読み取り専用スキルの本文の取得元（選択のたびに `GET /api/files/preview` / 組み込みは一覧の `body`）/ 本文 / ファイル タブの出し分け（`fileSkillDir` / 読み取り専用の `FileBrowser` / root の caption / 初回 mount と `display` の保持）/ 本文のコピーが表示と同じ生テキストであること（`react-dom/server` の描画 + ソース走査） |
| `client/test/fileRef.test.ts` | matcher の採否表（正規化と別表記の同ービキー / 制御文字 U+0000 / Unicode 空白 U+00A0・U+3000 / dotfile / scheme / `..` / 末尾ドット）と、解決の表（rootCwd 前置き / cwd 外 / rootCwd 未取得 / 明示的な相対 / cwd 未確定） |
| `client/test/fileMention.test.ts` | ドラッグの種類の判定（参照の型は添付の `Files` より優先 / 対象外は null）/ 参照の字面（空白・引用符・バックスラッシュを含むパスの引用とエスケープ）/ 挿入規則（空・末尾・語中・選択の置換・既に空白がある位置・改行の後ろ、カーソルは参照の直後）/ 送信時の `trim` を通してもパスが変わらないこと / 配線のソース走査（ファイル行が積む型と `text/plain` / `canRef` を渡すのは desktop の右パネルだけ / Composer が参照を添付より先に見ること / ドロップ座標の解決と挿入） |
| `client/test/fileRefRequest.test.ts` | 未消費は 1 件で最新優先 / ack は seq が一致するときだけ消す（request1 → request2 → ack1）/ 選択変更の破棄後に復活しない / 旧 ack で新しい要求を消さない / sessionId の一致判定 / 購読の通知 / 配線のソース走査（選択変更の 3 経路、App の受け渡し、`FileBrowser` の seq ガード、sheet の focus 復帰） |
| `client/test/markdownFileRef.test.ts` | 参照になるインラインコードだけ button にする / provider の外と参照でない字面は code のまま / rootCwd 前置きと cwd 外の解決 / リンク内 code の除外 / 引用・リスト・表の中の code / 長文フォールバックの例外（描画 + ソース走査） |
| `client/test/filePreviewState.test.ts` | 保存 schema の encode / decode / 検証と上限 / 壊れた入力の捨て方 / 他 cwd を消さない merge / read・write の例外とメモリ snapshot / 配信元（ストレージ有効モード）を保存しないこと |
| `client/test/sessionFiles.test.ts` | 右パネルの出し分け（desktop × チャット画面 × 作業フォルダあり） |
| `client/test/chatReducer.test.ts` | `runEndSeq` が `run_end` と `running` を抜けた `resync` でだけ進むこと（同じバッチで届いた `run_start` / `run_end` でも 1 回、新規チャットでも戻らない） |
| `client/test/route.test.ts` | pathname と画面の対応（大文字・末尾スラッシュ・percent encoding・不正な入力の畳み方）と往復 |
| `client/test/fileUrl.test.ts` | パスのセグメント単位 encode（`#` / `?` / `%` / `+` / 日本語 / 1 回の decode で戻ること）/ `fileHtmlPreviewUrl` がクエリでなくパス形式で組み立てること / `fileStoragePreviewUrl` が hostname + ポートで別オリジンの URL を組み立てること |
| `server/test/files.test.ts` | HTML プレビューのポリシー定数（段階ごとの CSP / `connect-src` なし / リスナーごとの sandbox 段）/ `GET /api/files/html/<path>` の文書・画像・音声・テキストアセット・400 の分岐と percent decoding（音声は raw・テキストは preview の使い分けと動画 / フォントの 400 を含む）/ ヘッダ（CSP / `no-store` / `nosniff`）/ `previewApp` の storage 有効 CSP（文書は HTML・アセットは CSP 無しの JSON）とマウント範囲（HTML プレビュー ルートだけ）/ `GET /api/files/raw` が音声を 400 で拒むこと / 文書は HTML・アセットは JSON のエラー写像 / `DELETE /api/files` の委譲（`recursive=true` は `deleteDirectory`）と 204・`recursive` の検証・エラー写像 / `POST /api/files/rename` の委譲と body 検証・エラー写像（409 の透過を含む）・契約外の応答の 502 |
| `server/test/file-preview-port.test.ts` | プレビュー オリジンのポート解決（待受とブラウザから見た値の既定はどちらも 4318 / 未設定は既定 / 1〜65535 の整数 / 不正値は throw して指定した env を名指しする / `pnpm dev` 用の統一（`PI_FILE_PREVIEW_PORT` が正・待受 env しか無いときはその値へ寄せる・空白だけは未設定）） |
| `server/test/dev-file-preview-port.test.ts` | `pnpm dev` が解決した 1 つの値を待受の空き確認と BFF の両 env（`PI_FILE_PREVIEW_PORT` / `PI_FILE_PREVIEW_LISTEN_PORT`）へ渡し、既定ポートを直書きしないこと（ソース走査） |
| `server/test/archive-rules.test.ts` | 既定の除外名（再生成物 / ビルド成果物 / `vendor` などを入れない）/ 上書きの解決（空配列は全解除・trim と重複の除去・呼び出し側の変更から既定を守る）/ 正規化（trim / 空落とし / 先勝ちの重複 / 順序と大文字小文字の保持）/ 検証（`.`・`..`・区切り・制御文字・200 文字超・100 件超）/ `GET /api/health` が実効値を返すこと |
| `server/test/archive-settings.test.ts` | 設定ストア（未設定 = 既定 / 保存の正規化と明示空 / リセットで行を消す / 検証エラーの 400 と非破壊 / DB 不可のフォールバックと 503）とルート（GET / PUT / DELETE の同じ形 / zod の 400 / 再起動後の保持 / DB 不可の 503）/ 整合（PUT の直後に health と download / check が同じ実効値を見る） |
| `server/test/zip-writer.test.ts` | ZIP ライタ（既知ベクタの CRC32 と分割入力 / store と deflate の選択 / UTF-8 名と bit 3・bit 11 / 空ファイル・空ディレクトリ / 複数チャンク / 途中失敗でストリームを失敗させる） |
| `server/test/sandbox-archive.test.ts` | `GET /v1/files/download` と `/check`（zip の中身と除外 / skipped の内容 / `exclude` の省略 = 既定と空値のみ = 除外なし / 繰り返しの一覧 / 不正名と 100 件超の 400 / 除外名のディレクトリの 400 / symlink の 400 と配下 symlink の除外 / 単体ファイルの生配信とヘッダ / root の zip / 空ディレクトリ / 末尾スラッシュ / 404・root 外 400・`..` の 400 / 上限 413 / 認証） |
| `server/test/file-download.test.ts` | BFF の `GET /api/files/download` と `/check`（ストリーム中継とヘッダ / `Content-Disposition` の透過 / `Content-Length` の有無 / 設定ストアの実効値を `exclude` の繰り返しで渡すこと（未設定 = 既定 / 明示空 = 空のまま）/ 400・404・413・502・503 の写像 / 契約外の check 応答の 502） |
| `server/test/sandbox-delete-dir.test.ts` | `DELETE /v1/dirs`（`recursive` の解釈 / 空ディレクトリ / 非空の 400 と部分削除なし / 配下ごとの削除と接頭辞境界 / パス形式と root 外・不存在・非ディレクトリ・symlink の 400・404 / 配下 symlink のリンクだけの削除 / 一覧上限外の子 / `__proto__` / 認証） |
| `server/test/sandbox-client.test.ts` | NDJSON / JSON 経路の写像と、`deleteDirectory` が `DELETE /v1/dirs?recursive=true` を呼び 204 の本文を読まないこと / `renameEntry` が `POST /v1/files/rename` を呼び、409 を文言ごと透過すること |
| `server/test/sandbox-rename.test.ts` | `POST /v1/files/rename`（ファイル / ディレクトリの改名と応答パス / 大文字小文字だけの変更 / 同名 409 と変更なし / 不正な名前・パス形式の 400 / 不存在 404 / root 外 400 / symlink の 400 とリンク先の維持・symlink への上書きの 409 / symlink ディレクトリ経由 / 認証） |
| `server/test/static.test.ts` | SPA フォールバック（拡張子なしの画面 URL / `/api`・`/assets` の境界 / `Accept` / 未ビルド 503）と、アプリ CSP の `frame-src`（`'self'` + プレビュー オリジンのポート） |

## 参照

- [ui-layout.md](ui-layout.md) — 本文の中でツリーとプレビューをどう並べるか
- [markdown.md](markdown.md) — 共有するトークナイザの対応言語・上限と、インラインコードをファイル参照の操作要素にする描画契約
- [api.md](api.md#テキストプレビュー) — プレビューの転送契約
- [api.md](api.md#html-プレビュー) — HTML プレビューのヘッダとエラー応答
- [api.md](api.md#ダウンロード) — ダウンロードの転送契約
- [sandbox-api.md](sandbox-api.md#get-v1filesdownload) — ZIP の除外規則・上限・ZIP ライタの実装
- [api.md](api.md#アーカイブの除外名) — 除外名の設定 API（未設定と明示空の区別・検証）
