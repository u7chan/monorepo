# チャット本文の Markdown 描画

assistant の本文 (`MessageView`) に含まれる Markdown を、外部ライブラリを足さずに描画する。解析は `client/src/lib/markdown/` の純関数、描画は `client/src/components/markdown/` の React 要素が持つ。見た目とテーマ / CSP の前提は [frontend.md](frontend.md)、検証コマンドは [../AGENTS.md](../AGENTS.md) を参照する。

## 原則

1. **サブセット実装**: CommonMark の完全互換は狙わない。対応する記法をこの文書で明示し、それ以外は原文表示に落とす。
2. **落ちない**: 解析は例外を投げない。解釈できない記法はその部分だけ元のテキストに戻し、メッセージ全体は描画し続ける。
3. **DOM 文字列を作らない**: `innerHTML` / `dangerouslySetInnerHTML` / `DOMParser` を使わない。本文由来の文字列が HTML として解釈される経路そのものを持たない（`client/test/markdownSafety.test.ts` がソース走査で固定する）。
4. **解析は DOM / React 非依存**: `lib/markdown/` は相対 import だけの純関数にして、Node のテストで検証できるようにする。
5. **外部ライブラリを足さない**: クライアントは React + Tailwind のみ。KaTeX や Mermaid.js はインライン `style` 属性を出力し、本番の CSP（`style-src 'self'`）で崩れるため採用しない。

## パイプライン

```
MessageView (assistant の本文)
  └─ MarkdownView          text → MdBlock[]        lib/markdown/parse.ts
        ├─ コードフェンス → MdToken[]              lib/markdown/highlight.ts
        ├─ 表 / リスト / 引用 → 再帰的に parse + 描画
        └─ 段落・見出し → MdInline[]               lib/markdown/inline.ts
              └─ 強調 / コードスパン / リンク / 生 HTML / 自動リンク
                    └─ HtmlNode                    lib/markdown/html.ts
  └─ components/markdown/{MarkdownView,CodeBlock,HtmlInline}.tsx
```

`parse.ts` は 1 段だけブロックに分ける。リスト項目・引用の中身は `source` 文字列として保持し、描画側が `MarkdownBlocks` を再帰的に呼ぶ。この形にすると、props が文字列だけで済むためブロック単位の `memo` が効き、ストリーミング中は伸びているブロックだけを解析し直す。

## 対応サブセット（契約）

| 記法 | 対応 | 備考 |
| --- | --- | --- |
| 見出し `#`〜`######` / 段落 / 段落内改行 | ✓ | 段落内の改行は `<br>` にする（従来の `whitespace-pre-wrap` と同じ見え方） |
| 強調 `**b**` `*i*` `~~s~~` / コードスパン | ✓ | `_` は語中では強調しない（`snake_case` を壊さない） |
| リンク `[t](url "title")` / 自動リンク / 画像 | ✓ | 画像は同一オリジン（相対パス）のみ |
| 箇条書き / 番号付き / 入れ子 / タスクリスト `- [ ]` | ✓ | 番号付きは開始番号を保つ |
| 引用 `>` / 水平線 | ✓ | |
| 表（パイプテーブル、`:---:` の整列） | ✓ | 横スクロール。区切り行の列数がヘッダと違うときは表にしない |
| コードフェンス | ✓ | ts / tsx / js / json / bash / python / css / html / diff / md。未知の言語はハイライトなし |
| 生 HTML | △ | 下記の許可リストのみ |
| 実体参照 `&amp;` `&#65;` | △ | 生 HTML の中のテキストだけ標準 5 種（`&amp;` `&lt;` `&gt;` `&quot;` `&apos;`）と数値参照を戻す。markdown 本文（生 HTML の外）はそのまま表示する |
| 数式 `$…$` `$$…$$` | ✗ | 現時点は原文表示（後続の PR で対応する） |
| 図 ` ```mermaid ` | ✗ | 現時点はコードブロックとして素通し（後続の PR で対応する） |
| HTML ブロック / 脚注 / 定義リスト / 表のセル内改行 / 遅延継続行 | ✗ | 原文表示 |

## 解析の上限（ストリーミング対策）

本文は SSE で伸びるため、1 フレームの作業量に上限を置く。上限を超えた部分は解析せず原文表示にする（無言で消さない）。

| 上限 | 値 | 場所 |
| --- | --- | --- |
| 本文全体（これを超えると Markdown にせずプレーン表示） | 200 KB | `MARKDOWN_MAX_LENGTH` (`parse.ts`) |
| コードブロックのハイライト | 40 KB | `HIGHLIGHT_MAX_LENGTH` (`highlight.ts`) |
| 1 段落で試す区切り（強調・リンク・コードスパン）の回数 | 2000 | `inline.ts` |
| 1 段落で生 HTML を走査する文字数 | 20000 | `inline.ts` / `html.ts` |
| 生 HTML の入れ子 / インライン記法の入れ子 | 8 段 | `html.ts` / `inline.ts` |

未終端のフェンスは `closed: false` として「生成中…」表示にし、本文は途中までハイライトする（閉じたフェンスに戻ればコピー操作が出る）。ブロック単位の `memo` により、伸びているブロック以外は再解析しない。

## 生 HTML の許可リスト

タグを自前でトークン化し、許可したタグだけを React 要素へ写す。挙動は 3 段階に分かれる。

| 入力 | 表示 | 理由 |
| --- | --- | --- |
| `<b>太字</b>` | **太字** | タグを描画する |
| `<span style="color:red">x</span>` | x | タグは描画し、装飾・識別属性（`style` / `class` / `id` / `on*`）は落とす |
| `<div>x</div>` / `<script>…</script>` | `<div>x</div>` | 許可外のタグはタグごと原文（実行も描画もしない） |
| `<a href="javascript:…">x</a>` | `<a href="javascript:…">x</a>` | URL が不正ならタグごと原文 |
| `<b>閉じない` | `<b>閉じない` | 対応する閉じが無ければ開始タグだけ原文。自動補完はしない |

- 許可タグ: `b strong i em u s del ins code kbd mark small sub sup span a br hr img`
- 内容に意味を持つ属性は `a[href,title]` / `img[src,alt,title]` だけを通す。リンクには `target="_blank" rel="noreferrer noopener"` を強制する
- URL は http / https / mailto / 同一オリジンの相対パスのみ。`img` は相対パス（＝同一オリジン）だけを描画する（外部 URL は CSP `default-src 'self'` で読み込めず、無言で壊れるため原文表示にする）
- 色やサイズはテーマ側の CSS が決める。`style` 属性は CSP でも動かないため、そもそも通さない

Markdown 記法側の URL（`[t](url)` / `![alt](src)`）も同じ `safeUrl` を通す。不正な URL のリンクは記法ごと原文表示（等幅）に落とす。

## テーマ

- シンタックスの色は 6 テーマすべてが `--c-syn-{key,str,num,com,fn,type,op}` を定義し、`.tok-*` クラスだけを付ける（`client/src/styles/index.css`）。インライン `style` は使わない
- 種別と CSS の対応、および 6 テーマ分の定義漏れは `client/test/markdownHighlight.test.ts` が固定する
- 横に長いもの（コード / 表）は折り返さず、その要素だけ横スクロールする

## テスト

| テスト | 固定すること |
| --- | --- |
| `client/test/markdownParse.test.ts` | 見出し / 段落 / リスト / 引用 / 表 / フェンス / 未終端 / CRLF / 空行 / 例外を投げない |
| `client/test/markdownInline.test.ts` | 強調の入れ子 / コードスパン / リンク / 自動リンク / エスケープ / 改行 / 無言で消さない |
| `client/test/markdownHtml.test.ts` | 許可リスト / 属性の除去 / `on*` `javascript:` の拒否 / 未閉じは原文 / `safeUrl` |
| `client/test/markdownHighlight.test.ts` | 言語判定 / 未知言語と上限超過 / トークンが入力を欠落させない / CSS との対応 |
| `client/test/markdownSafety.test.ts` | `lib/markdown` と `components/markdown` に DOM 文字列の生成・インライン style が現れない（ソース走査） |
