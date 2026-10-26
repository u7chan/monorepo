// アイコンの背景色が id だけで決まり、固定パレットの中に収まることを固定する。
import { describe, expect, test } from "bun:test";
import { ACCOUNT_ICON_COLORS, accountIconColor } from "../src/client/lib/account-color";

describe("accountIconColor", () => {
  test("同じ id からは常に同じ色を返す", () => {
    const id = "11111111-1111-4111-8111-111111111111";

    expect(accountIconColor(id)).toBe(accountIconColor(id));
  });

  test("プリセットのパレットだけを返す", () => {
    for (let index = 0; index < 200; index += 1) {
      const color = accountIconColor(`account-${index}`);

      expect(ACCOUNT_ICON_COLORS as readonly string[]).toContain(color);
    }
  });

  test("パレットの 8 色すべてに振り分けられる", () => {
    const used = new Set<string>();

    for (let index = 0; index < 500; index += 1) {
      used.add(accountIconColor(`account-${index}`));
    }

    expect(used.size).toBe(ACCOUNT_ICON_COLORS.length);
  });

  test("白いアイコンを載せられる濃さで、色数は 8", () => {
    expect(ACCOUNT_ICON_COLORS).toHaveLength(8);

    for (const color of ACCOUNT_ICON_COLORS) {
      // 白 (#ffffff) とのコントラスト比が 4.5:1 以上あることを、相対輝度から確かめる。
      const [red, green, blue] = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
      const luminance = 0.2126 * channel(red ?? 0) + 0.7152 * channel(green ?? 0) + 0.0722 * channel(blue ?? 0);

      expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

function channel(value: number): number {
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
