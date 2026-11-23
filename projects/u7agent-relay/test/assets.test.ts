// 生成物の抽出とパス正規化の契約。Markdown の画像・リンクだけを対象にし、cwd 外と対象外の拡張子を落とす。
import { describe, expect, test } from "bun:test";
import { MAX_RUN_ASSETS, assetKindOf, extractRunAssets, normalizeCwd, normalizeFilePath } from "../src/server/assets";

describe("normalizeFilePath", () => {
  test("先頭の ./ と重複セグメントを正規化する", () => {
    expect(normalizeFilePath("./generated/a.png")).toBe("generated/a.png");
    expect(normalizeFilePath("a//b/./c.html")).toBe("a/b/c.html");
    expect(normalizeFilePath("generated/")).toBe("generated");
  });

  test("cwd 外・絶対パス・URL・空白・query を拒否する", () => {
    for (const value of [
      "",
      "../secret.png",
      "/etc/passwd",
      "a\\b.png",
      "a b.png",
      "a?b.png",
      "a#b.png",
      "https://agent.example.com/a.png",
    ]) {
      expect(normalizeFilePath(value)).toBeNull();
    }
  });
});

describe("normalizeCwd", () => {
  test("root 自身はファイル API の対象外にする", () => {
    expect(normalizeCwd("projects/app/")).toBe("projects/app");
    expect(normalizeCwd("./projects/app")).toBe("projects/app");
    expect(normalizeCwd("")).toBeNull();
    expect(normalizeCwd(".")).toBeNull();
    expect(normalizeCwd("../app")).toBeNull();
    expect(normalizeCwd(undefined)).toBeNull();
  });
});

describe("assetKindOf", () => {
  test("allowlist の拡張子だけを kind に写す", () => {
    expect(assetKindOf("generated/a.png")).toBe("image");
    expect(assetKindOf("generated/a.JPG")).toBe("image");
    expect(assetKindOf("generated/a.mp3")).toBe("audio");
    expect(assetKindOf("generated/a.html")).toBe("html");
    expect(assetKindOf("generated/a.md")).toBe("text");
    expect(assetKindOf("generated/a.svg")).toBeNull();
    expect(assetKindOf("generated/a")).toBeNull();
  });
});

describe("extractRunAssets", () => {
  const runId = "fedcba9876543210";

  test("その run の assistant 本文から画像と allowlist リンクを拾う", () => {
    const assets = extractRunAssets(
      [
        { role: "user", text: "![u](generated/user.png)", assistantId: `${runId}:0` },
        {
          role: "assistant",
          assistantId: `${runId}:0`,
          text: [
            "![cafe](./generated/cafe.png)",
            '[demo](docs/demo.html "title")',
            "![dup](generated/cafe.png)",
            "![external](https://example.com/x.png)",
            "![out](../out.png)",
            "![svg](generated/icon.svg)",
            "![space](generated/a b.png)",
            '<img src="generated/raw.png">',
          ].join("\n"),
        },
        { role: "assistant", assistantId: "aaaaaaaaaaaaaaaa:0", text: "![old](generated/old.png)" },
      ],
      runId,
    );

    expect(assets).toEqual([
      { path: "generated/cafe.png", kind: "image" },
      { path: "docs/demo.html", kind: "html" },
    ]);
  });

  test("コードの中の画像記法は拾わない", () => {
    const text = [
      "```",
      "![code](generated/code.png)",
      "```",
      "`![inline](generated/inline.png)`",
      "![real](generated/real.png)",
    ].join("\n");
    const assets = extractRunAssets([{ role: "assistant", assistantId: `${runId}:0`, text }], runId);

    expect(assets).toEqual([{ path: "generated/real.png", kind: "image" }]);
  });

  test("件数の上限を守る", () => {
    const text = Array.from({ length: MAX_RUN_ASSETS + 5 }, (_, index) => `![x](generated/${index}.png)`).join("\n");
    const assets = extractRunAssets([{ role: "assistant", assistantId: `${runId}:0`, text }], runId);

    expect(assets).toHaveLength(MAX_RUN_ASSETS);
    expect(assets.at(-1)?.path).toBe(`generated/${MAX_RUN_ASSETS - 1}.png`);
  });
});
