// 定型プロンプトの編集面が上限をどう見せるか。件数は見出し、文字数は入力欄の隣で、現在値と上限 (n / max) を
// 出すこと、件数の上限では「追加」を無効にするだけでなく理由を説明行へ出すこと (上限の存在に気づけない
// まま保存できない状態を作らない) を react-dom/server で固定する。クリックの動きは実 DOM が要るため、
// 見た目と属性だけを見る。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SuggestionsEditor } from "../src/components/agent-settings/SuggestionsEditor";
import {
  SuggestionDeleteDialog,
  SUGGESTION_DELETE_CONFIRM_LABEL,
  SUGGESTION_DELETE_TITLE,
} from "../src/components/agent-settings/SuggestionDeleteDialog";
import type { AgentSuggestion } from "../src/types";

const suggestionsOf = (count: number): AgentSuggestion[] =>
  Array.from({ length: count }, (_, index) => ({ label: `案 ${index + 1}`, prompt: `依頼 ${index + 1}` }));

const render = (suggestions: AgentSuggestion[]): string =>
  renderToStaticMarkup(
    createElement(SuggestionsEditor, {
      suggestions,
      onChange: () => {},
      onRemove: () => {},
      onAdd: () => {},
    }),
  );

/** JSX の隣り合う text node の間には境目のコメントが入るため、文字列の照合は取り除いてから行う */
const textOf = (html: string): string => html.replaceAll("<!-- -->", "");

/** 追加ボタンの開始タグ (className にも `disabled:` があるので属性名で見る) */
const addButtonTag = (html: string): string => {
  const label = html.lastIndexOf("追加");
  return html.slice(html.lastIndexOf("<button", label), html.indexOf(">", label) + 1);
};

test("描画: 見出しは件数を、入力欄は文字数を上限つきで出す", () => {
  const html = render(suggestionsOf(2));
  assert.match(textOf(html), /2 \/ 6/);
  // ラベルは "案 1" の 3 文字、プロンプトは "依頼 1" の 4 文字
  assert.match(textOf(html), /3 \/ 60/g);
  assert.match(textOf(html), /4 \/ 500/g);
  assert.ok(!addButtonTag(html).includes(' disabled=""'), "上限未満では追加できる");
  assert.ok(!textOf(html).includes("上限の"), "上限未満では無効の理由を出さない");
});

test("描画: 文字数は入力制限と同じく trim 前の長さで数える", () => {
  // 入力制限 (maxLength) は生の文字列を数える。trim 後で数えると、前後の空白があるときに
  // 「まだ入る」と読めるのに次の文字が拒否される
  const html = render([{ label: " 案", prompt: "依頼  " }]);
  assert.match(textOf(html), /2 \/ 60/);
  assert.match(textOf(html), /4 \/ 500/);
});

test("描画: 上限では追加を無効にし、理由を説明行へ出す", () => {
  const html = render(suggestionsOf(6));
  assert.match(textOf(html), /6 \/ 6/);
  assert.ok(addButtonTag(html).includes(' disabled=""'), "上限では追加を止める");
  // 理由は無効の手前ではなく、押せない状態の説明として読める位置に出す
  assert.match(textOf(html), /上限の 6 件です。追加するにはどれかを削除してください。/);
  assert.ok(textOf(html).includes("空の会話の最初の画面にボタンとして出ます"), "説明は上限の有無に関わらず残す");
});

test("描画: 削除は確認の面を挟み、行のボタンからは直接消さない", () => {
  const html = render([{ label: "案 1", prompt: "依頼 1" }]);
  // onClick は面を開くだけ。押した時点で onRemove は呼ばれない (静的描画では呼び出し回数を見ない)
  assert.match(html, /aria-haspopup="dialog"/);
  assert.ok(!html.includes("<dialog"), "開く前から面を出さない");
});

test("描画: 確認の面は対象のラベルとプロンプトを並べ、保存で効くと伝える", () => {
  const html = textOf(
    renderToStaticMarkup(
      createElement(SuggestionDeleteDialog, {
        suggestion: { label: "案 1", prompt: "依頼 1" },
        index: 2,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    ),
  );
  assert.ok(html.includes(SUGGESTION_DELETE_TITLE));
  assert.match(html, /02/, "何番目の行かを見出しに出す");
  assert.ok(html.includes("案 1") && html.includes("依頼 1"));
  assert.ok(html.includes("保存すると、このエージェントの定型プロンプトから外れます。"));
  assert.ok(html.includes(SUGGESTION_DELETE_CONFIRM_LABEL));
  assert.ok(html.includes("やめる"));
  // 入れ子の form は無効な HTML になる (この面は編集フォームの中に置く)
  assert.equal(html.match(/<form/g), null, "form を持たない");
});
