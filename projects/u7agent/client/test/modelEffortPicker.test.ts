// Model / Effort のポップアップ (client/src/components/composer/ModelEffortControls.tsx) の描画。
// 入力欄の行に select を戻さず popover として常時 mount することと、開閉・注意文の公開属性を
// react-dom/server で固定する (ネイティブ popover の実際の開閉はブラウザ受入で確認する)。
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComposerSettings } from "../src/hooks/useU7Agent";

// useU7Agent が api.ts を読み、その時点で location を要求する (ブラウザ前提のモジュール)
globalThis.location ??= { origin: "http://localhost" } as Location;
const { ModelEffortPicker } = await import("../src/components/composer/ModelEffortControls");

type Props = Parameters<typeof ModelEffortPicker>[0];

const settings: ComposerSettings = {
  modelOptions: [
    {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      supportsThinking: true,
      thinkingLevels: ["off", "low", "medium", "high"],
    },
  ],
  model: "anthropic/claude-sonnet-4-5",
  modelLabel: "Claude Sonnet 4.5",
  effortLabel: "High",
  thinkingLevel: "high",
  supportsThinking: true,
  thinkingLevels: ["off", "low", "medium", "high"],
  disabled: false,
  changing: false,
  compactDisabled: false,
};

const render = (overrides: Partial<Props> = {}): string =>
  renderToStaticMarkup(
    createElement(ModelEffortPicker, {
      settings,
      compact: false,
      open: false,
      onOpenChange: () => {},
      onChangeModel: () => {},
      onChangeThinkingLevel: () => {},
      ...overrides,
    }),
  );

test("描画: トリガーは popover を指し、開閉状態と焦点の外へ出たときの終了に必要な属性を持つ", () => {
  const closed = render();

  assert.ok(closed.includes('aria-expanded="false"'));
  assert.ok(closed.includes('aria-haspopup="dialog"'), "開くものの種別を出す");
  assert.ok(closed.includes('aria-label="モデルと Effort の設定"'));
  assert.ok(closed.includes('aria-controls="'), "popover との関係を id で持つ");

  const open = render({ open: true });
  assert.ok(open.includes('aria-expanded="true"'), "開いている状態をトリガーへ写す");
});

test("描画: popover は閉じていても DOM に居て、Model / Effort の入力と注意文を中に持つ", () => {
  const html = render({ settings: { ...settings, modelWarning: "zzz/unknown は現在利用できません。" } });

  assert.ok(html.includes('popover="auto"'), "popover を常時 mount していない");
  assert.ok(html.includes('role="dialog"'));
  assert.ok(html.includes('aria-label="モデルと Effort"'));
  assert.ok(html.includes(">Model<") && html.includes(">Effort<"));
  assert.ok(html.includes('aria-label="モデルを選択"'));
  assert.ok(html.includes('aria-label="Effort を選択"'));
  assert.ok(html.includes("Claude Sonnet 4.5"), "候補の表示名を出す");
  assert.ok(html.includes("High"), "Effort のラベルを出す");
  assert.ok(html.includes("zzz/unknown は現在利用できません。"), "注意文は popover の中に出す");
});

test("描画: 注意文はモデルが使えない警告を優先し、無いときだけ Effort の注意を出す", () => {
  const warned = render({
    settings: {
      ...settings,
      modelWarning: "zzz/unknown は現在利用できません。",
      effortNotice: "使用モデルに応じて補正されます",
    },
  });
  assert.ok(warned.includes("zzz/unknown は現在利用できません。"));
  assert.ok(!warned.includes("使用モデルに応じて補正されます"), "2 つを同時に出さない");

  const noticeOnly = render({
    settings: { ...settings, model: undefined, effortNotice: "使用モデルに応じて補正されます" },
  });
  assert.ok(noticeOnly.includes("使用モデルに応じて補正されます"));
});

test("描画: 注意文が無いときは popover 内に警告の段落を出さない", () => {
  const html = render();

  assert.ok(!html.includes("text-warn"), "空の段落を残さない");
});
