// 外観設定の解釈と、描画前スクリプトとの整合

import { describe, expect, test } from "bun:test";
import { THEME_COLORS, THEME_STORAGE_KEY, parseThemePreference, themeColorFor } from "./theme";

describe("parseThemePreference", () => {
  test.each(["light", "dark"] as const)("保存された %s はそのまま使う", (value) => {
    expect(parseThemePreference(value)).toBe(value);
  });

  test.each([null, undefined, "", "system", "auto", "DARK", "sepia"])(
    "未保存や未知の値 (%p) は端末の設定に従う system にする",
    (value) => {
      expect(parseThemePreference(value)).toBe("system");
    },
  );
});

describe("themeColorFor", () => {
  test("system のときは meta が指す外観の色を返す", () => {
    expect(themeColorFor("system", "light")).toBe(THEME_COLORS.light);
    expect(themeColorFor("system", "dark")).toBe(THEME_COLORS.dark);
  });

  test("アプリ内で選んだ外観は、meta が指す外観によらずその色を返す", () => {
    expect(themeColorFor("dark", "light")).toBe(THEME_COLORS.dark);
    expect(themeColorFor("light", "dark")).toBe(THEME_COLORS.light);
  });
});

describe("index.html の描画前スクリプト", () => {
  const htmlUrl = new URL("../index.html", import.meta.url);

  test("アプリと同じ保存キーから外観を読む", async () => {
    const html = await Bun.file(htmlUrl).text();

    expect(html).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
  });

  test("system と light / dark それぞれの theme-color を、アプリと同じ色で持つ", async () => {
    const html = await Bun.file(htmlUrl).text();

    expect(html).toContain(
      `<meta name="theme-color" content="${THEME_COLORS.light}" media="(prefers-color-scheme: light)" />`,
    );
    expect(html).toContain(
      `<meta name="theme-color" content="${THEME_COLORS.dark}" media="(prefers-color-scheme: dark)" />`,
    );
  });
});
