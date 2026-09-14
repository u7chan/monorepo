// 数式 (LaTeX サブセット) の契約: トークン化 / AST / レイアウトモデル / `$` の判定 / 失敗時の ok: false。
// 解析は例外を投げず、上限を超えた入力も原文表示に落ちることを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { parseInline } from "../src/lib/markdown/inline";
import { LATEX_MAX_LENGTH, LATEX_MAX_NODES, parseLatex } from "../src/lib/markdown/latex";
import { toMathLayout } from "../src/lib/markdown/latexLayout";
import { parseMarkdown } from "../src/lib/markdown/parse";
import type { MathNode } from "../src/lib/markdown/types";

const text = (value: string) => ({ kind: "text" as const, text: value });
const atom = (cls: "mat" | "mop", value: string) => ({ kind: "atom" as const, cls, text: value });

/** 解析に成功することを確かめたうえで AST を返す */
function ast(source: string): MathNode {
  const result = parseLatex(source);
  assert.ok(result.ok, `${source} を解析できる`);
  return result.node;
}

function layout(source: string) {
  return toMathLayout(ast(source));
}

test("分数は分子と分母を分けて持つ", () => {
  assert.deepEqual(ast("\\frac{1}{2}"), {
    kind: "row",
    children: [{ kind: "frac", num: { kind: "row", children: [text("1")] }, den: { kind: "row", children: [text("2")] } }],
  });
  assert.deepEqual(layout("\\frac{1}{2}"), {
    kind: "row",
    children: [
      {
        kind: "frac",
        num: { kind: "row", children: [atom("mat", "1")] },
        den: { kind: "row", children: [atom("mat", "2")] },
      },
    ],
  });
});

test("根号は任意インデックスを取る", () => {
  assert.deepEqual(ast("\\sqrt{2}"), {
    kind: "row",
    children: [{ kind: "sqrt", index: null, body: { kind: "row", children: [text("2")] } }],
  });
  assert.deepEqual(ast("\\sqrt[3]{x}"), {
    kind: "row",
    children: [
      { kind: "sqrt", index: { kind: "row", children: [text("3")] }, body: { kind: "row", children: [text("x")] } },
    ],
  });
  // 添字の無いときは index を持たない (CSS 側で .idx を出さない)
  assert.deepEqual(layout("\\sqrt{2}"), {
    kind: "row",
    children: [
      {
        kind: "sqrt",
        index: null,
        body: { kind: "row", children: [atom("mat", "2")] },
      },
    ],
  });
});

test("大型演算子の上下限は横ではなく上下に積む", () => {
  const sum = ast("\\sum_{k=1}^{n}");
  assert.deepEqual(sum, {
    kind: "row",
    children: [
      {
        kind: "bigop",
        glyph: "∑",
        lower: { kind: "row", children: [text("k"), { kind: "op", text: "=" }, text("1")] },
        upper: { kind: "row", children: [text("n")] },
      },
    ],
  });
  // `_` と `^` の順序が逆でも同じ位置に入る
  assert.deepEqual(layout("\\int^{\\infty}_{0}"), layout("\\int_{0}^{\\infty}"));
  const integral = layout("\\int_{0}^{\\infty}"); 
  assert.equal(integral.kind === "row" && integral.children[0].kind === "bigop" ? integral.children[0].glyph : "", "∫");
  // \lim は語なので、記号と同じ大きさに組まない (word フラグを CSS が使う)
  const lim = layout("\\lim_{x \\to 0}");
  assert.deepEqual(lim.kind === "row" && lim.children[0].kind === "bigop" ? lim.children[0].word : null, true);
  assert.deepEqual(lim.kind === "row" && lim.children[0].kind === "bigop" ? lim.children[0].upper : null, null);
});

test("上下限が無い大型演算子はそのまま置く", () => {
  const layouted = layout("\\prod x");
  assert.deepEqual(layouted.kind === "row" && layouted.children[0].kind === "bigop" ? layouted.children[0] : null, {
    kind: "bigop",
    glyph: "∏",
    word: false,
    upper: null,
    lower: null,
  });
});

test("pmatrix は & を列、\\\\ を行にする", () => {
  const node = ast("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}");
  assert.deepEqual(node, {
    kind: "row",
    children: [
      {
        kind: "grid",
        env: "pmatrix",
        rows: [
          [{ kind: "row", children: [text("a")] }, { kind: "row", children: [text("b")] }],
          [{ kind: "row", children: [text("c")] }, { kind: "row", children: [text("d")] }],
        ],
      },
    ],
  });
  const layouted = layout("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}");
  const matrix = layouted.kind === "row" ? layouted.children[0] : null;
  assert.ok(matrix !== null && matrix.kind === "matrix");
  assert.equal(matrix.columns, 2);
  assert.equal(matrix.cells.length, 4);
  assert.equal(matrix.open?.kind === "delim" ? matrix.open.text : null, "(");
  assert.equal(matrix.close?.kind === "delim" ? matrix.close.text : null, ")");
  // 2 行の行列は 2 段階の括弧になる
  assert.equal(matrix.open?.kind === "delim" ? matrix.open.scale : null, 2);
});

test("cases は開き括弧だけを持ち、セルが足りない行は空で埋める", () => {
  const layouted = layout("\\begin{cases} 1 & (x > 0) \\\\ 0 \\end{cases}");
  const matrix = layouted.kind === "row" ? layouted.children[0] : null;
  assert.ok(matrix !== null && matrix.kind === "matrix");
  assert.equal(matrix.cls, "cases");
  assert.equal(matrix.columns, 2);
  assert.equal(matrix.open?.kind === "delim" ? matrix.open.text : null, "{");
  assert.equal(matrix.close, null);
  assert.deepEqual(matrix.cells[3], { kind: "empty" });
  // `\\` の直後で閉じた空行は落とす
  const trailing = layout("\\begin{pmatrix} a \\\\ \\end{pmatrix}");
  const one = trailing.kind === "row" ? trailing.children[0] : null;
  assert.equal(one !== null && one.kind === "matrix" ? one.cells.length : 0, 1);
});

test("\\left…\\right は括弧を拡大し、中身の段数で大きさを決める", () => {
  const plain = layout("\\left( x \\right)");
  const fenced = plain.kind === "row" ? plain.children[0] : null;
  assert.ok(fenced !== null && fenced.kind === "fenced");
  assert.equal(fenced.open?.kind === "delim" ? fenced.open.text : null, "(");
  assert.equal(fenced.open?.kind === "delim" ? fenced.open.scale : null, 1);
  const tall = layout("\\left( \\frac{a}{b} \\right)");
  const nested = tall.kind === "row" ? tall.children[0] : null;
  assert.equal(nested !== null && nested.kind === "fenced" && nested.open?.kind === "delim" ? nested.open.scale : 0, 2);
  // `.` は括弧を出さない印なので、区切りを持たない
  const dot = layout("\\left. x \\right|");
  const oneSide = dot.kind === "row" ? dot.children[0] : null;
  assert.equal(oneSide !== null && oneSide.kind === "fenced" ? oneSide.open : null, null);
  assert.equal(oneSide !== null && oneSide.kind === "fenced" && oneSide.close?.kind === "delim" ? oneSide.close.text : null, "|");
});

test("上付き / 下付き / グルーピング / 立体の関数名", () => {
  assert.deepEqual(ast("e^{-x^2}"), {
    kind: "row",
    children: [
      {
        kind: "script",
        base: text("e"),
        sub: null,
        sup: {
          kind: "row",
          children: [
            { kind: "op", text: "−" },
            { kind: "script", base: text("x"), sub: null, sup: text("2") },
          ],
        },
      },
    ],
  });
  assert.deepEqual(ast("x_1^2"), {
    kind: "row",
    children: [{ kind: "script", base: text("x"), sub: text("1"), sup: text("2") }],
  });
  // 関数名は立体 (op) で組む
  assert.deepEqual(ast("\\log x"), {
    kind: "row",
    children: [{ kind: "op", text: "log" }, { kind: "space", width: 0 }, text("x")],
  });
});

test("ギリシャ文字と主要な記号を写す", () => {
  const layouted = layout("\\alpha \\le \\Omega \\infty \\partial \\nabla \\ldots");
  const children = layouted.kind === "row" ? layouted.children : [];
  assert.deepEqual(
    children.filter((child) => child.kind === "atom").map((child) => (child.kind === "atom" ? child.text : "")),
    ["α", " ", "≤", " ", "Ω", " ", "∞", " ", "∂", " ", "∇", " ", "…"],
  );
});

test("\\text の中は数式として解釈しない", () => {
  assert.deepEqual(ast("\\text{if x > 0}"), { kind: "row", children: [text("if x > 0")] });
});

test("レイアウトモデルは同じ入力から同じ結果になる", () => {
  const source = "f(x) = \\begin{cases} \\frac{1}{2} & (x > 0) \\\\ 0 & (x \\le 0) \\end{cases}";
  const node = ast(source);
  const snapshot = JSON.stringify(node);
  assert.deepEqual(toMathLayout(node), toMathLayout(node));
  assert.deepEqual(toMathLayout(ast(source)), toMathLayout(ast(source)));
  // 入力の AST を書き換えない
  assert.equal(JSON.stringify(node), snapshot);
});

test("インライン数式は $…$ と \\(…\\) の両方を受ける", () => {
  assert.deepEqual(parseInline("$E = mc^2$"), [
    {
      kind: "math",
      node: {
        kind: "row",
        children: [text("E"), { kind: "space", width: 0 }, { kind: "op", text: "=" }, { kind: "space", width: 0 }, { kind: "script", base: text("mc"), sub: null, sup: text("2") }],
      },
    },
  ]);
  assert.deepEqual(parseInline("\\(x^2\\)"), [
    { kind: "math", node: { kind: "row", children: [{ kind: "script", base: text("x"), sub: null, sup: text("2") }] } },
  ]);
  // 前後の地の文はそのまま残る
  assert.deepEqual(parseInline("前 $x$ 後"), [text("前 "), { kind: "math", node: { kind: "row", children: [text("x")] } }, text(" 後")]);
});

test("通貨記号は数式にしない", () => {
  assert.deepEqual(parseInline("価格は $100 から $200 へ。ここは数式にしない。"), [
    text("価格は $100 から $200 へ。ここは数式にしない。"),
  ]);
  // 開きの直後が空白 / 閉じの直前が空白のときも数式にしない
  assert.deepEqual(parseInline("$ x$"), [text("$ x$")]);
  assert.deepEqual(parseInline("$x $"), [text("$x $")]);
  assert.deepEqual(parseInline("$x"), [text("$x")]);
});

test("$ の後ろにトークン化できない中身があるときは記号ごと原文に落とす", () => {
  assert.deepEqual(parseInline("$\\frac{1}$"), [{ kind: "literal", text: "$\\frac{1}$" }]);
  assert.deepEqual(parseInline("$\\foo$"), [{ kind: "literal", text: "$\\foo$" }]);
  assert.deepEqual(parseInline("\\(x^2\\)"), [
    { kind: "math", node: { kind: "row", children: [{ kind: "script", base: text("x"), sub: null, sup: text("2") }] } },
  ]);
  // エスケープした $ は文字として扱う
  assert.deepEqual(parseInline("\\$100"), [text("$100")]);
});

test("$$ はブロック数式になり、インラインでは解釈しない", () => {
  assert.deepEqual(parseInline("$$\\sum_{i=1}^N$$"), [text("$$\\sum_{i=1}^N$$")]);
  assert.deepEqual(parseMarkdown("$$\nx = \\frac{1}{2}\n$$"), [
    { kind: "math", text: "x = \\frac{1}{2}", source: "$$\nx = \\frac{1}{2}\n$$" },
  ]);
  assert.deepEqual(parseMarkdown("$$x = 1$$"), [{ kind: "math", text: "x = 1", source: "$$x = 1$$" }]);
  assert.deepEqual(parseMarkdown("\\[\nx = 1\n\\]"), [{ kind: "math", text: "x = 1", source: "\\[\nx = 1\n\\]" }]);
});

test("ブロック数式が段落の途中に混ざらない", () => {
  assert.deepEqual(parseMarkdown("前の段落\n$$\nx = 1\n$$\n後の段落"), [
    { kind: "paragraph", source: "前の段落" },
    { kind: "math", text: "x = 1", source: "$$\nx = 1\n$$" },
    { kind: "paragraph", source: "後の段落" },
  ]);
});

test("閉じの無いブロック数式は段落 (原文) として残す", () => {
  assert.deepEqual(parseMarkdown("$$\nx = 1"), [{ kind: "paragraph", source: "$$\nx = 1" }]);
  assert.deepEqual(parseMarkdown("\\[\nx = 1"), [{ kind: "paragraph", source: "\\[\nx = 1" }]);
  // 閉じの後に本文が続く行はブロック数式にしない
  assert.deepEqual(parseMarkdown("$$x = 1$$ つづき"), [{ kind: "paragraph", source: "$$x = 1$$ つづき" }]);
});

test("閉じない環境・対応しない環境は ok: false になる", () => {
  const inputs = [
    "\\begin{pmatrix} a & b",
    "\\begin{pmatrix} a \\end{cases}",
    "\\begin{matrix} a \\end{matrix}",
    "\\begin{pmatrix} a & b & c & d & e & f & g \\end{pmatrix}",
    "&",
    "a \\\\ b",
  ];
  for (const input of inputs) {
    assert.equal(parseLatex(input).ok, false, input);
  }
});

test("壊れた入力でも例外を投げず ok: false を返す", () => {
  const inputs = [
    "",
    "   ",
    "\\",
    "\\\\",
    "{",
    "{x",
    "x}",
    "\\frac{1}{",
    "\\frac{1}",
    "\\frac",
    "\\sqrt",
    "\\sqrt[3{x}",
    "\\left( x",
    "\\left x \\right)",
    "\\left( x \\right",
    "\\right)",
    "x^2^3",
    "x_1_2",
    "^2",
    "_1",
    "$$",
    "\\text",
    "\\text{x",
    "\\begin",
    "\\begin{}x\\end{}",
    "\\unknown{x}",
    "a $ b",
    "a % b",
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => parseLatex(input), JSON.stringify(input));
    assert.equal(parseLatex(input).ok, false, JSON.stringify(input));
  }
});

test("深い入れ子と巨大な入力は上限で打ち切る", () => {
  const deepBraces = "{".repeat(64) + "x" + "}".repeat(64);
  const deepFences = "\\left(".repeat(64) + "x" + "\\right)".repeat(64);
  const tooLong = "x".repeat(LATEX_MAX_LENGTH + 1) + "y";
  const tooManyNodes = "+".repeat(LATEX_MAX_NODES + 1);
  for (const input of [deepBraces, deepFences, tooLong, tooManyNodes]) {
    assert.doesNotThrow(() => parseLatex(input));
    assert.equal(parseLatex(input).ok, false);
  }
  // 上限内は解析できる
  assert.equal(parseLatex("+".repeat(LATEX_MAX_NODES - 10)).ok, true);
  assert.equal(parseLatex("x".repeat(LATEX_MAX_LENGTH)).ok, true);
});

test("数式の解析を含む本文でも実用的な時間で終わる", () => {
  const started = Date.now();
  const source = "$x$ ".repeat(2000);
  assert.ok(parseInline(source).length > 0);
  assert.ok(Date.now() - started < 5000);
});
