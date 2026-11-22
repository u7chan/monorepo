// 新着イメージ API の応答解釈のユニットテスト

import { describe, expect, test } from "bun:test";
import { parseImageUpdates } from "./useImageUpdates";

describe("parseImageUpdates", () => {
  test("updates 配列を containerId ごとの Map にする", () => {
    const updates = parseImageUpdates({
      updates: [
        { containerId: "a", latestTag: "sha-new", createdAt: "2026-11-13T13:06:22Z" },
        { containerId: "b", latestTag: "sha-new2" },
      ],
    });

    expect([...updates.keys()]).toEqual(["a", "b"]);
    expect(updates.get("a")).toEqual({
      containerId: "a",
      latestTag: "sha-new",
      createdAt: "2026-11-13T13:06:22Z",
    });
    expect(updates.get("b")).toEqual({ containerId: "b", latestTag: "sha-new2" });
  });

  test("配列でない応答は空の Map にする", () => {
    expect(parseImageUpdates(null).size).toBe(0);
    expect(parseImageUpdates({ updates: "none" }).size).toBe(0);
    expect(parseImageUpdates({}).size).toBe(0);
  });

  test("containerId か latestTag が文字列でない要素は無視する", () => {
    const updates = parseImageUpdates({
      updates: [
        { containerId: 1, latestTag: "sha-new" },
        { containerId: "a" },
        { containerId: "b", latestTag: "sha-new", createdAt: 42 },
        { containerId: "c", latestTag: "sha-new" },
      ],
    });

    expect([...updates.keys()]).toEqual(["c"]);
  });

  test("同じ containerId が複数あれば後勝ちにする", () => {
    const updates = parseImageUpdates({
      updates: [
        { containerId: "a", latestTag: "sha-old" },
        { containerId: "a", latestTag: "sha-new" },
      ],
    });

    expect(updates.get("a")?.latestTag).toBe("sha-new");
    expect(updates.size).toBe(1);
  });
});
