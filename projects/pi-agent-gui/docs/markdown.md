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
        ├─ 図フェンス → SvgModel                   lib/markdown/diagram.ts
        ├─ 数式 ($$ / \[) → MathNode               lib/markdown/latex.ts
        │     └─ レイアウト (CSS クラス + 派生値)   lib/markdown/latexLayout.ts
        ├─ 表 / リスト / 引用 → 再帰的に parse + 描画
        └─ 段落・見出し → MdInline[]               lib/markdown/inline.ts
              └─ 強調 / コードスパン / リンク / 生 HTML / 自動リンク / インライン数式
                    └─ HtmlNode / MathNode         lib/markdown/{html,latex}.ts
  └─ components/markdown/{MarkdownView,CodeBlock,HtmlInline,MathView,Diagram}.tsx
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
| 数式 `$…$` `\(…\)` `$$…$$` `\[…\]` | ✓ | 前後に空白が無い `$` だけでインライン数式にする。対応コマンドは下記 |
| 図 ` ```mermaid ` | ✓ | `flowchart TD` / `TB` / `LR` と `sequenceDiagram`。フェンスが閉じてからのみ描画する（下記） |
| HTML ブロック / 脚注 / 定義リスト / 表のセル内改行 / 遅延継続行 | ✗ | 原文表示 |

## 解析の上限（ストリーミング対策）

本文は SSE で伸びるため、1 フレームの作業量に上限を置く。上限を超えた部分は解析せず原文表示にする（無言で消さない）。

| 上限 | 値 | 場所 |
| --- | --- | --- |
| 本文全体（これを超えると Markdown にせずプレーン表示） | 200 KB | `MARKDOWN_MAX_LENGTH` (`parse.ts`) |
| コードブロックのハイライト | 40 KB | `HIGHLIGHT_MAX_LENGTH` (`highlight.ts`) |
| 1 段落で試す区切り（強調・リンク・コードスパン・数式）の回数 | 2000 | `inline.ts` |
| 1 段落で生 HTML を走査する文字数 | 20000 | `inline.ts` / `html.ts` |
| 1 段落でインライン数式の判定に使う文字数（探索した分だけ減る） | 20000 | `MAX_MATH_STEPS` (`inline.ts`) |
| インライン数式 1 つの探索範囲（開きの位置から閉じを探す距離） | 4096 | `MAX_MATH_SPAN` (`inline.ts`) |
| 数式 1 つの中身の文字数 / ノード数（解析本体。実質はブロック数式に効く） | 20000 / 4000 | `LATEX_MAX_LENGTH` / `LATEX_MAX_NODES` (`latex.ts`) |
| 図フェンスのソース文字数 / ラベル 1 つの文字数 | 20000 / 120 | `DIAGRAM_MAX_LENGTH` / `DIAGRAM_MAX_LABEL` (`diagram.ts`) |
| 図のラベル 1 つの折り返し行数 | 6 | `DIAGRAM_MAX_LINES` (`diagram.ts`) |
| flowchart のノード数 / エッジ数 | 60 / 120 | `DIAGRAM_MAX_NODES` / `DIAGRAM_MAX_EDGES` (`diagram.ts`) |
| sequenceDiagram の参加者数 / メッセージ数（Note を含む） | 20 / 60 | `DIAGRAM_MAX_PARTICIPANTS` / `DIAGRAM_MAX_MESSAGES` (`diagram.ts`) |
| 生 HTML の入れ子 / インライン記法の入れ子 | 8 段 | `html.ts` / `inline.ts` |

同じハイライタ (`highlight.ts`) をファイルプレビューも使う。ファイル側は取得した本文全体を 1 回だけ変換し、上限は別に定義する（[file-preview.md](file-preview.md)）。

未終端のフェンスは `closed: false` として「生成中…」表示にし、本文は途中までハイライトする（閉じたフェンスに戻ればコピー操作が出る）。図は閉じたフェンスだけを描画し、閉じるまではコードブロックのままにする。ブロック単位の `memo` により、伸びているブロック以外は再解析しない。

数式は `parseMarkdown` と `parseInline` の段階で解析し終える（`MdBlock` / `MdInline` が `MathNode` を持つ）。`MathView` は AST からレイアウトモデルを作るところだけを `memo` の入力単位で行い、再描画のたびに解析し直さない。

## 数式（LaTeX サブセット）

分数・根号・上下限・行列を CSS（flex / grid / 罫線）だけで組む。KaTeX は使わない。

| 種類 | 記法 |
| --- | --- |
| 構造 | `\frac{}{}` `\sqrt{}` `\sqrt[n]{}` `\left…\right`（`( ) [ ] \{ \} | .`）`\text{}` `{}` |
| 大型演算子 | `\sum` `\int` `\prod` `\lim`（`_` `^` は上下に積む） |
| 行列 | `\begin{pmatrix}…\end{pmatrix}`（`&` が列、`\\` が行）`\begin{cases}…\end{cases}` |
| 上下付き | `^` `_` |
| 空白 | `\quad` `\qquad` |
| 関数名（立体） | `\log` `\ln` `\sin` `\cos` `\tan` `\exp` `\max` `\min` |
| 記号 | ギリシャ文字（`\alpha`〜`\Omega`）と `\le \ge \ne \pm \times \cdot \div \to \infty \partial \nabla \approx \equiv \in \subset \cup \cap \forall \exists \Rightarrow \Leftrightarrow \cdots \ldots` |

- インライン数式は `$…$` と `\(…\)` の 2 通り。`$…$` は 3 条件すべてのときだけ数式にする: ① 開き `$` の直後が空白でない ② 同じ段落内に閉じがあり、その直前が空白でない ③ 解析が成功する
- ① ② は `$` 専用の条件（通貨記号と衝突させないため）。`\(…\)` は区切りが衝突しないので空白を見ず、`\)` があれば数式にする（`\( x \)` も数式になる）
- ①② が欠けた `$` は地の文のまま、③ で落ちたときだけ記法ごと原文（`literal` → `<code class="md-lit">`）にする
- ①② は前後の空白しか見ないため、空白の無い通貨記号が同じ段落に 2 つ以上あると数式として解釈されうる
- インライン数式 1 つの探索範囲は 4096 文字まで（`MAX_MATH_SPAN` = 開きから閉じを探す距離）。超えると閉じを見つけられず地の文のまま残るので、`$…$` / `\(…\)` の中身は 4094 文字が実質の上限になる（解析本体の 20000 文字はブロック数式に効く）
- 解析に失敗したとき（引数不足 / 閉じない環境 / 上限超過 / 未対応コマンド）は例外を投げず、原文を等幅で出す。ブロックは `$$` を含む原文を改行ごと出す
- 記号の表（`ATOMS` / `OPERATORS` / `BIGOPS`）は `Object.hasOwn` で引く。`\constructor` のような `Object.prototype` の名前を命令として拾うと、文字列でない値が AST に入り、描画側で例外になる
- 行列の列数は 6 まで、括弧の拡大は 4 段階まで。高さは実寸を測らず、分数・大型演算子・行列の段数から決める（同じ入力からは必ず同じレイアウトになる）
- 地の文・未終端の `$$` は数式にせずそのまま出す（未終端の `$$` は段落の中の文字になる）

## 図（Mermaid サブセット）

フェンス言語が `mermaid`（大文字小文字は問わない）で、かつフェンスが閉じているときだけ SVG にする。`plantuml` などの他の言語は従来どおりコードブロックにする。

| 種類 | 記法 |
| --- | --- |
| flowchart | 先頭行 `flowchart TD` / `flowchart TB`（TD と同じ）/ `flowchart LR`。別名 `graph` も同じ文法 |
| ノード形状 | `id[テキスト]`（角丸矩形）/ `id(テキスト)`（丸め）/ `id{テキスト}`（ひし形。アクセント色）/ `id((テキスト))`（円）/ 裸の `id`（矩形、ラベルは id） |
| エッジ | `A --> B` / `A -.-> B`（破線）/ `A -->\|ラベル\| B` / `A -.->\|ラベル\| B` / チェーン `A --> B --> C` |
| sequenceDiagram | `participant X as ラベル` / `participant X`（ラベルは id）/ `A->>B: テキスト` / `A-->>B: テキスト`（破線）/ 自己メッセージ `A->>A: テキスト` / `Note over A: テキスト` / `Note over A,B: テキスト` |

- `%%` の行コメントと空行は無視する。ノードの並びは初出順で、同じ id を裸で参照しても既存のラベルは消えない（形状つきの宣言が後から来たらそちらを採る）
- id は英数字と `_` だけにする（`-` は矢印と衝突するため使えない）。日本語のラベルは `[]` `()` `{}` `(())` の中に書く
- ラベルは字面どおりに扱い、実体参照はデコードしない。区切り文字（`]` `)` `}`）はラベルに含められない
- ラベルは文字幅の見積もりで決定的に折り返す（空白があれば語の境界で、語が 1 行に収まらないときは 1 文字単位）。ノード / 参加者ボックスの高さは行数から決まり、ひし形・円は行数に応じて高さ・直径も伸びる
- 折り返しは最大 6 行。6 行に収まらないラベルは例外にせず図全体をソース表示にする（ひし形・円は 1 行に入る幅が狭いため、長いラベルでは矩形より先にこの上限に当たる）
- ラベルは 120 文字まで。折り返した各行の矩形もキャンバスの計算に含めるので、テキストが SVG の外へ出て切り落とされることはない
- `subgraph` `end` `direction` `style` `class` `classDef` `click` `linkStyle` は予約語として行ごとエラーにする（未対応の記法を黙って 1 ノードに化けさせない）
- **解釈できない非空行が 1 つでもあれば図全体をソース表示にする**（行を黙って落とさない）。`flowchart BT` / `flowchart RL` と `gantt` / `pie` / `classDiagram` / `stateDiagram` / `erDiagram` / `mindmap` / `journey` も同じ
- 解析に失敗したときは例外を投げず、`CodeBlock`（`lang="mermaid"`）で原文を出して「未対応の記法のためソースを表示しています（対応: flowchart / sequenceDiagram）」を 1 行添える

レイアウトはランク割り当て（後退エッジを除いた最長路）と文字幅の見積もり（ASCII 0.62em / 全角 1em / その他 0.72em）だけで決める。`document` / `canvas` / `measureText` は使わない。

- 同じ入力からは必ず同じモデル（座標・順序まで一致）になる。ノードの寸法はラベルから決まる（上限あり）ので、幅だけが変わる
- エッジは直交（縦 → 横 → 縦）で、ノードの境界から出て境界で止まる。矢印は SVG の `marker` で描き、`id` は `useId()` で図ごとに一意にする
- エッジのラベルは、自分のものも含めたどのエッジの線分（矢印の先を含む）とも、他のラベルとも、ノードとも重ならない位置へ置く（余白 3px）。仮置きの位置がぶつかるときは「帯の中で左右 → 上下 → 図形の外側のマージン」の順に決定的に動かす（外へ出た分はキャンバスが広がる）。どこにも置けないときは重ねて描かず、図全体をソース表示にする
- 自己ループのラベルは周回の横に仮置きし、同じノードから出る他エッジの縦線と重なるときは衝突解決で動かす
- 折れはランク間のすき間で作るので、隣のランクへのエッジは線がランクの帯を横切らない。2 ランク以上先へ進むエッジと戻る向きのエッジは、ランク軸に直交する外側のレーン（全ノードの左外 / 右外）へ回り込ませ、同じ側を使う 2 本目以降は 1 本ずつ外へずらす。**よってどのエッジもノードの矩形を横切らない**
- 行き先が最上段・出発点が最下段のときは図の外側に専用の帯を取る（必要な分だけ `normalize` がキャンバスを広げる）。自己ループはランクの下のすき間へ落として描く（隣のノードを横切らないように）
- 戻る向きのエッジはランクの計算には後退エッジとして使わない（そのまま使うとランクが際限なく伸びるため）
- sequenceDiagram は参加者ボックスを等間隔に並べ、破線のライフラインを下へ伸ばし、メッセージを入力順に行間隔で置く。Note は対象の参加者幅（`Note over A,B` は 2 人の幅）に広げたアクセント色の破線枠にする
- SVG は実寸の `width` / `height` と `viewBox` を持ち、内容 + 余白で決まる。種別ラベル（`mermaid · flowchart TD` / `mermaid · sequenceDiagram`）と、生 Markdown をコピーするボタンを `figcaption` に出す
- SVG には `role="img"` と種別ラベルの `aria-label` を付ける。横に長い図は折り返さず、`.md-diagram-body` を横スクロールにする

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
- 数式は `.math-inline` / `.math-block` / `.frac` / `.bigop` / `.sqrt` / `.matrix` / `.mtx` / `.cases` / `.delim` / `.mat` / `.mop` のクラスだけで組み、色は既存の `--c-ink*` / `--c-line*` / `--c-accent*` を使う（新規カラートークンは増やさない）
- 図は `.md-diagram*` のクラスだけで組み、色は既存の `--c-panel` / `--c-soft` / `--c-raised` / `--c-line*` / `--c-ink*` / `--c-accent*` を使う（同じく新規トークンは増やさない）
- 種別と CSS の対応、および 6 テーマ分の定義漏れは `client/test/markdownHighlight.test.ts` が固定する
- 横に長いもの（コード / 表 / 数式）は折り返さず、その要素だけ横スクロールする
- 原文表示の `md-lit` は CSS を持たない目印で、見た目は `.md code` が担う。Tailwind が生成するクラスではないため `.oxlintrc.json` の `shadcn/no-unknown-classes` の `allow` に登録する（`@utility` を宣言しても生成される CSS が無い）

## テスト

| テスト | 固定すること |
| --- | --- |
| `client/test/markdownParse.test.ts` | 見出し / 段落 / リスト / 引用 / 表 / フェンス / 未終端 / CRLF / 空行 / 例外を投げない |
| `client/test/markdownInline.test.ts` | 強調の入れ子 / コードスパン / リンク / 自動リンク / エスケープ / 改行 / 無言で消さない |
| `client/test/markdownHtml.test.ts` | 許可リスト / 属性の除去 / `on*` `javascript:` の拒否 / 未閉じは原文 / `safeUrl` |
| `client/test/markdownHighlight.test.ts` | 言語判定 / 未知言語と上限超過 / トークンが入力を欠落させない / CSS との対応 |
| `client/test/markdownLatex.test.ts` | `\frac` `\sqrt` 上下限 行列 cases の AST とレイアウトモデル / 決定性 / `$` の判定と通貨記号 / `$$` のブロック検出 / 失敗が `ok: false` になる / 例外を投げない |
| `client/test/markdownDiagram.test.ts` | 形状 4 種 / エッジの種類とラベル / チェーン / TD と LR のランク方向 / 境界で止まるエッジ / 戻るエッジと外側レーン / エッジラベルと線の余白 / 長いラベルの折り返しと 6 行上限 / sequenceDiagram の順序と Note / 決定性 / 未対応が `ok: false` になる / 上限 / 固定シードのランダム入力でエッジがノードを横切らずラベルも線に貫かれない / SSR した HTML にインライン style が出ない |
| `client/test/markdownSafety.test.ts` | `lib/markdown` と `components/markdown` に DOM 文字列の生成・インライン style が現れない（ソース走査） |
