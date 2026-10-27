// Model / Effort の切り替え (client/src/components/composer/ModelEffortControls.tsx) の描画。
// 入力欄の上の状態行のモデル名 / Effort がトリガーになること、入力欄の行に select を戻さず popover を
// 常時 mount すること、開閉・注意文・無効の公開属性を react-dom/server で固定する
// (ネイティブ popover の実際の開閉はブラウザ受入で確認する)。
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

/** モデルが未解決のチャット (候補 0 件・既定も無い) */
const unsetSettings: ComposerSettings = {
  ...settings,
  modelOptions: [],
  model: undefined,
  modelLabel: undefined,
  effortLabel: undefined,
  thinkingLevel: undefined,
};

const render = (overrides: Partial<Props> = {}): string =>
  renderToStaticMarkup(
    createElement(ModelEffortPicker, {
      settings,
      singleColumn: false,
      open: false,
      onOpenChange: () => {},
      onChangeModel: () => {},
      onChangeThinkingLevel: () => {},
      ...overrides,
    }),
  );

/** トリガーの要素 (開始タグと中身) */
const trigger = (html: string): string => /<button[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
/** トリガーの開始タグ (属性とクラスだけ) */
const triggerTag = (html: string): string => trigger(html).split(">")[0];
/** popover の中身 (トリガーのクラスと混ぜない) */
const popover = (html: string): string => html.slice(html.indexOf('popover="auto"'));
/** Effort の select が持つ option の value を描画順に並べる */
const effortOptions = (html: string): string[] => {
  const start = html.indexOf('aria-label="Effort を選択"');
  const select = html.slice(start, html.indexOf("</select>", start));
  return [...select.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);
};

test("描画: トリガーは現在値を可視テキストと aria-label に持ち、popover を指す", () => {
  const closed = render();
  const tag = triggerTag(closed);

  assert.ok(tag.includes('aria-expanded="false"'));
  assert.ok(tag.includes('aria-haspopup="dialog"'), "開くものの種別を出す");
  assert.ok(
    tag.includes('aria-label="モデルと Effort の設定（Claude Sonnet 4.5 - High）"'),
    "可視テキストと同じ区切りで現在値を含める",
  );
  assert.ok(tag.includes('aria-controls="'), "popover との関係を id で持つ");
  assert.ok(tag.includes('title="anthropic/claude-sonnet-4-5"'), "provider/id は hover (title) に残す");
  assert.ok(closed.includes(">Claude Sonnet 4.5<"), "表示名を可視テキストに出す");
  assert.ok(closed.includes(">- High<"), "Effort は区切ってモデル名の右へ続ける");
  assert.ok(trigger(closed).includes("<svg"), "押せると分かる chevron を添える");

  const open = render({ open: true });
  assert.ok(triggerTag(open).includes('aria-expanded="true"'), "開いている状態をトリガーへ写す");
});

test("描画: warn のトーンはトリガーが持ち、未選択でも同じ色で示す", () => {
  assert.ok(!triggerTag(render()).includes("text-warn"), "候補を引けるときは warn にしない");

  const warned = triggerTag(render({ settings: { ...settings, modelWarning: "zzz/unknown は現在利用できません。" } }));
  assert.ok(warned.includes("text-warn"), "実効モデルが候補に無いとき");

  const unset = render({ settings: unsetSettings });
  assert.ok(triggerTag(unset).includes("text-warn"), "未選択も同じ warn のトーンで示す");
  assert.ok(unset.includes(">未選択<"), "表示名が無いときは未選択と出す");
});

test("描画: 選べる Model が無くモデルも未解決のときだけトリガーを無効にする", () => {
  const unset = trigger(render({ settings: unsetSettings }));

  assert.ok(triggerTag(unset).includes("disabled"), "開いても選べるものが無いなら無効にする");
  assert.ok(triggerTag(unset).includes("composer-model-trigger"), "状態行の寸法と押せない見た目を共有する");
  assert.ok(!unset.includes("<svg"), "無効なときは chevron を出さない");

  const resolved = trigger(render({ settings: { ...settings, modelOptions: [] } }));
  assert.ok(!triggerTag(resolved).includes("disabled"), "モデルを表示できるなら開ける (中の select は無効のまま)");
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
    settings: { ...settings, model: undefined, modelLabel: undefined, effortNotice: "使用モデルに応じて補正されます" },
  });
  assert.ok(noticeOnly.includes("使用モデルに応じて補正されます"));
});

test("描画: 注意文が無いときは popover の中に警告の段落を出さない", () => {
  assert.ok(!popover(render()).includes("text-warn"), "空の段落を残さない");
});

test("描画: Effort の選択肢は段階順に並び、Max が最後に残る", () => {
  const html = render({
    settings: { ...settings, thinkingLevel: "medium", thinkingLevels: ["low", "high", "max"] },
  });

  assert.deepEqual(
    effortOptions(html),
    ["low", "medium", "high", "max"],
    "候補に無い実効値も段階の位置に入れ、Max の後ろへは置かない",
  );
  assert.deepEqual(effortOptions(render()), ["off", "low", "medium", "high"], "候補にあるときは候補の並び");
});
