# ファイルプレビューの表示（行番号 / シンタックスハイライト / HTML 描画）

ファイル画面（`FileTreePage` → `FilePreview`）の本文は、`GET /api/files/preview` で取得したプレーンテキストを表示用に整えて出す。HTML だけは `GET /api/files/html` を iframe で描画する。整形は `client/src/lib/fileCode.ts` の純関数、タブと表示モードは `client/src/lib/fileTabs.ts`、描画は `client/src/components/FilePreview.tsx` が担う。タブと本文のキャッシュは [api.md](api.md#テキストプレビュー) を参照する。

## 原則

1. **ソース表示の転送はプレーンテキストのまま**: 行番号も色も表示側の都合で、API / DTO / サンドボックスは変えない。Markdown を描画しない方針も変わらない（色を付けるだけ）。HTML だけは例外で、別ルートの応答を iframe で描画する（原則 5）。
2. **外部ライブラリを足さない**: 色付けはチャット本文と同じ `lib/markdown/highlight.ts` のトークナイザを使う（対応言語は [markdown.md](markdown.md)）。ファイル用の別実装を持たない。
3. **DOM 文字列を作らない**: `innerHTML` / `dangerouslySetInnerHTML` / インライン `style` を使わない（本番の CSP は `style-src 'self'`）。行番号もクラスと CSS だけで出す。`client/test/fileCode.test.ts` がソース走査で固定する。
4. **行番号と本文を 1 対 1 にする**: 番号の列は本文と同じ行送りで重ね、行数は本文から数える。ブラウザーの末尾改行の扱いに依存させない。
5. **HTML の描画は応答ヘッダで隔離する**: iframe の src は同一オリジンの `GET /api/files/html` で、その応答だけ CSP と `sandbox` を当ててオペークオリジンにする。クライアント内で HTML 文字列を iframe へ流す方法（`srcdoc` / Blob URL / `data:` URL）は、親の CSP を継承してインライン style / script が動かないため使わない。

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

## 上限

| 上限 | 値 | 場所 | 決め方 |
| --- | --- | --- | --- |
| ハイライトする本文 | 256 KiB | `FILE_PREVIEW_MAX_LENGTH` | サンドボックスが返す本文の上限に合わせる（超えたら素のテキスト + 行番号） |
| トークン数 | 2 万 | `FILE_PREVIEW_MAX_TOKENS` | トークン 1 つが DOM ノード 1 つになる。実測（dev / Chromium）で 232 KiB の TS（4.6 万トークン）の描画に 0.66 秒かかるため、その半分程度に収める |

上限でハイライトを落としても本文と行番号は出す（無言で消さない）。実測値の目安は、41 行の TS が 66 ms（色付き）、7,058 行 / 226 KiB の TS が 162 ms（トークン上限を超えるため素のテキスト + 行番号）。

## HTML プレビュー

`.html` / `.htm` のタブ（`isHtmlPath`）は、行番号付きのソース表示と iframe で描画したプレビューを切り替えられる（`client/src/components/FilePreview.tsx`）。

### 方式

描画は iframe の src に同一オリジンの `GET /api/files/html?path=<root 相対>` を指定し、応答ヘッダだけで隔離する。サーバーは本文をテキストプレビューと同じ `workspace.previewFile()`（サンドボックスの `GET /v1/files/preview`）から取るが、返すのは `text/html` で、CSP と `sandbox` をこの応答だけに当てる。

クライアント内で HTML 文字列を iframe へ流す方法（`srcdoc` / Blob URL / `data:` URL）は使わない。アプリの本番 CSP（`default-src 'self'; style-src 'self'; script-src 'self'`）は `srcdoc` / `blob:` の iframe に継承され、インラインの style / script がブロックされるため描画できない（`frame-src` が `default-src` にフォールバックして `blob:` のフレーム自体も拒否される）。Chromium に本番相当の CSP を当てて確認済み。

### 隔離（CSP と sandbox）

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline';
  script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'
```

- インラインの style / script と `data:` / `blob:` の画像・フォント・メディアだけを読み込む。相対パスのアセットと外部 URL は読み込めない
- `sandbox` によりオペークオリジンになり、親 DOM へ触れない（`localStorage` / cookie は SecurityError）。`/api` への fetch も `default-src 'none'` で止まる
- iframe 側の `sandbox="allow-scripts"` 属性と両方で隔離する。スクリプトの有効 / 無効は切り替えない（クライアントのトグルは ソース / プレビューの 2 択だけ）
- 本文は 256 KiB のテキストとして取得する（`FilePreviewSchema` を通す）。サンドボックス側の API は増やさず、新規依存も足さない
- 応答は本文もエラーも `Cache-Control: no-store` と `X-Content-Type-Options: nosniff`。エラーは iframe の中で読めるよう HTML 文書で返し、サンドボックス由来の文言はエスケープする

### クライアントの振る舞い

- 既定はプレビュー。他の拡張子は従来どおりソース表示で、トグルは HTML のタブにだけ出す
- トグルの選択はタブごとに保持し、タブを閉じると捨てる（`previewModeFor` / `withPreviewMode` / `dropClosedPreviewModes`）。state は `FileTreePage` が持つ。表示モードの選択は「タブを閉じるまで」が条件で、「再読み込み」は `FilePreview` を remount して本文だけを捨てる（本文はタブごとに保持するが、選択は再取得では戻さない）
- プレビュー中はソース本文を取得しない（`lang · N 行` もソース表示のときだけ出す）
- 「再読み込み」は `FilePreview` の remount（`FileTreePage` の `key` 差し替え）で iframe も取り直す（プレビュー用の追加実装は無い）

### 全画面

パス行のボタン（HTML のプレビュー中だけ出す）で、プレビューをアプリの viewport いっぱいに出す。ブラウザの Fullscreen API（`requestFullscreen`）は使わない（iPhone Safari で使えない。ブラウザの全画面は F11 で代替できる）。

- 方式はアプリ内のモーダル dialog（`showModal()` = top layer）で、全画面中もタブバーとパス行は dialog の中に残す（タブ切替と戻り導線を消さない）。`position: fixed` のオーバーレイは使わない。`@container`（`container-type: inline-size`）配下では 2024-10 より前のブラウザが layout containment を当てて fixed を祖先基準にするため viewport を覆えず、背面を inert にもできない
- **dialog は全画面でなくても常に置く**。通常時は UA の dialog スタイル（`display: none` / `position` / `width`・`height: fit-content` / `margin: auto` / `border` / `padding` / `background: Canvas`）を打ち消して普通の箱として使い、全画面のときだけ `showModal()` する。全画面専用の 2 つ目の箱を作ると、出入りのたびに iframe が再読み込みされてプレビューを取り直すため
- 全画面は「HTML をプレビューしている間」だけ続く。条件は `lib/fileTabs.ts` の `keepsFullscreenPreview`（HTML + プレビュー）で、ソース表示 / HTML 以外のタブ / タブを閉じる で解除する（HTML のプレビューから別の HTML のプレビューへ移ったときは続く）。状態は保存しない（F5 と チャット ⇄ 設定 の往復では復帰しない）
- `Escape` は全画面のときだけ dialog が受け取り（`stopPropagation`）、1 回で全画面だけを解除する。通常時も止めると設定ページの「Escape でチャットへ戻る」を食う。**プレビューの中（iframe）にフォーカスがあると Escape は親 document へ届かない**ので、そのときは `全画面をやめる` ボタンで戻る
- 全画面中は背面が inert になる（モーダルの標準挙動）。背面の SSE と実行中のランは止まらない（表示だけ）
- 見た目は `h-dvh w-screen max-h-none max-w-none m-0 border-0 bg-base` + `aria-modal` で、ツリーやタブの幅に依存しない（compact でも同じ）

### できないこと（残リスク）

- 相対パスを参照する HTML は見た目が崩れる（自己完結した HTML だけを描画する）
- `localStorage` / cookie を使う HTML は動かない（オペークオリジン）
- プレビュー自身は外部 URL へ自己遷移できる（持ち出せるのは自分自身の内容だけ）
- 同一オリジンの `/api` 面が 1 つ増える（CORS ヘッダを付けず、`no-store` と CSP + sandbox で無害化する）

## 復帰（F5・画面の往復）

設定 → ファイル の画面は、F5 や チャット ⇄ 設定 の往復でも直前の状態に戻る（`client/src/lib/filePreviewState.ts`）。復帰は「確定した root を持つ `FileTreePage` の mount ごとに 1 回」で、設定を離れて戻る・cwd A→B→A では再適用し、通常の render やツリーの再取得・「再読み込み」では適用しない。

- 復帰するのは タブの並び / 表示中のタブ / タブごとの表示モード / 開いているディレクトリ。本文・children・loading・error は保存しない（他キーや複数 cwd と合算した容量と、鮮度の問題）。復帰後に本文を取得し直すため、表示中のタブ以外は選択したときに取得する（HTML は `/api/files/html`、ソースは `/api/files/preview`）
- 親を閉じた子の open は保持し、保存された子のために親を勝手に開かない。root は常に開く。取得は既存の「可視の親から子へ」の経路のままで、親を開いた時点で子の open が効く
- 消えていたファイルのタブは残し、本文の取得エラーをそのまま出す（勝手に閉じない）。削除済みディレクトリの枝は一覧の取得で落ちる。listing が `truncated` のとき未掲載の枝も落ちるため、完全な復元は保証しない
- 「再読み込み」はタブ・表示モード・展開を保ったまま本文だけを取り直す。最後のタブを閉じた状態（保存する内容が無い）は cwd ごと消すので、F5 後も空のままになる
- 保存値が壊れている / 形が合わない cwd は捨てる（他の cwd は残す）。9 枚のタブを持つ保存値も捨てる。これは通常操作の 9 枚目で最古を落とす `FILE_TAB_LIMIT` とは別の契約
- 保存領域が使えない環境（SecurityError / quota 超過）では、write が失敗した cwd をメモリ snapshot として持ち、同一セッション内の往復は復元できる。F5 を跨ぐ復元は保証しない（古い保存値が戻り得る）。保存キーと上限の全体は [frontend.md](frontend.md#保存キーと保存範囲)

## テスト

| テスト | 固定すること |
| --- | --- |
| `client/test/fileCode.test.ts` | 拡張子の言語判定 / 正規化と行数 / 上限でのフォールバック / 行番号の列 / 例外を投げない / 描画側が DOM 文字列とインライン style を使わない / HTML の判定 / iframe が sandbox 付きで同一オリジンの URL を使う |
| `client/test/fileTabs.test.ts` | 表示モードの既定（HTML だけプレビュー）/ 選択の保持と破棄 / 全画面を続ける条件 / タブの開閉と上限 / 保存値からの復元（表示中の繰り上がりと上限） |
| `client/test/filePreviewFullscreen.test.ts` | HTML プレビューの全画面（`showModal()` で開く / Escape を全画面のときだけ止める / iframe は 1 つだけ） |
| `client/test/fileTree.test.ts` | 開閉・子のマージ・エラー保持 / 保存する展開の抽出と復元（root の初期化、親を閉じた子の open、truncated） |
| `client/test/filePreviewState.test.ts` | 保存 schema の encode / decode / 検証と上限 / 壊れた入力の捨て方 / 他 cwd を消さない merge / read・write の例外とメモリ snapshot |
| `client/test/route.test.ts` | pathname と画面の対応（大文字・末尾スラッシュ・percent encoding・不正な入力の畳み方）と往復 |
| `server/test/files.test.ts` | `GET /api/files/html` の 200 とヘッダ（CSP / `no-store` / `nosniff`）/ 400 / 404 / 502 / 503 / エラー HTML のエスケープ |
| `server/test/static.test.ts` | SPA フォールバック（拡張子なしの画面 URL / `/api`・`/assets` の境界 / `Accept` / 未ビルド 503） |

## 参照

- [ui-layout.md](ui-layout.md) — 本文の中でツリーとプレビューをどう並べるか
- [markdown.md](markdown.md) — 共有するトークナイザの対応言語・上限
- [api.md](api.md#テキストプレビュー) — プレビューの転送契約
- [api.md](api.md#html-プレビュー) — HTML プレビューのヘッダとエラー応答
