import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToggleSwitch } from "../src/components/ToggleSwitch";

test("スイッチは名前・選択状態・無効状態を公開する", () => {
  for (const size of ["md", "sm"] as const) {
    for (const checked of [false, true]) {
      const html = renderToStaticMarkup(
        createElement(ToggleSwitch, {
          label: "有効",
          size,
          checked,
          disabled: true,
          onChange: () => {},
        }),
      );
      assert.match(html, /role="switch"/);
      assert.ok(html.includes(`aria-checked="${checked}"`));
      assert.match(html, /disabled=""/);
      assert.ok(html.includes("有効"));
    }
  }
});

test("押下は現在の状態の反転をコールバックへ渡す", () => {
  for (const checked of [false, true]) {
    const changes: boolean[] = [];
    const button = ToggleSwitch({ checked, label: "有効", onChange: (next) => changes.push(next) }) as ReactElement<{
      onClick: () => void;
    }>;
    button.props.onClick();
    assert.deepEqual(changes, [!checked]);
  }
});
