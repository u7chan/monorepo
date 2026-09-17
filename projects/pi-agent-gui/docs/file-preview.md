# ファイルプレビューの表示（行番号とシンタックスハイライト）

ファイル画面（`FileTreePage` → `FilePreview`）の本文は、`GET /api/files/preview` で取得したプレーンテキストを表示用に整えて出す。整形は `client/src/lib/fileCode.ts` の純関数、描画は `client/src/components/FilePreview.tsx` が担う。タブと本文のキャッシュは [api.md](api.md#テキストプレビュー) と `client/src/lib/fileTabs.ts` を参照する。

## 原則

1. **転送はプレーンテキストのまま**: 行番号も色も表示側の都合で、API / DTO / サンドボックスは変えない。HTML や Markdown を実行・描画しない方針も変わらない（色を付けるだけで描画はしない）。
2. **外部ライブラリを足さない**: 色付けはチャット本文と同じ `lib/markdown/highlight.ts` のトークナイザを使う（対応言語は [markdown.md](markdown.md)）。ファイル用の別実装を持たない。
3. **DOM 文字列を作らない**: `innerHTML` / `dangerouslySetInnerHTML` / インライン `style` を使わない（本番の CSP は `style-src 'self'`）。行番号もクラスと CSS だけで出す。`client/test/fileCode.test.ts` がソース走査で固定する。
4. **行番号と本文を 1 対 1 にする**: 番号の列は本文と同じ行送りで重ね、行数は本文から数える。ブラウザーの末尾改行の扱いに依存させない。

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

## テスト

| テスト | 固定すること |
| --- | --- |
| `client/test/fileCode.test.ts` | 拡張子の言語判定 / 正規化と行数 / 上限でのフォールバック / 行番号の列 / 例外を投げない / 描画側が DOM 文字列とインライン style を使わない |

## 参照

- [ui-layout.md](ui-layout.md) — 本文の中でツリーとプレビューをどう並べるか
- [markdown.md](markdown.md) — 共有するトークナイザの対応言語・上限
- [api.md](api.md#テキストプレビュー) — プレビューの転送契約
