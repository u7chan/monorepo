// イメージ参照と入力検証のユニットテスト

import { describe, expect, test } from "bun:test";
import {
  describeImage,
  findNewerImageTag,
  isDeployableImageTag,
  isOlderImageTag,
  isValidDeployTarget,
  isValidImageTag,
  monorepoProject,
  parseImageReference,
} from "./image";

describe("parseImageReference", () => {
  test("タグ付きのイメージをリポジトリとタグへ分ける", () => {
    expect(parseImageReference("ghcr.io/u7chan/monorepo/portal:sha-abc1234")).toEqual({
      repository: "ghcr.io/u7chan/monorepo/portal",
      tag: "sha-abc1234",
    });
  });

  test("レジストリのポートとタグのコロンを区別する", () => {
    expect(parseImageReference("registry.example:5000/team/app:v1")).toEqual({
      repository: "registry.example:5000/team/app",
      tag: "v1",
    });
  });

  test("digest 付きのイメージはタグを持たない", () => {
    expect(parseImageReference("ghcr.io/u7chan/monorepo/portal@sha256:abc123")).toEqual({
      repository: "ghcr.io/u7chan/monorepo/portal",
    });
  });

  test("タグなしのイメージはリポジトリだけを返す", () => {
    expect(parseImageReference("ghcr.io/u7chan/monorepo/portal")).toEqual({
      repository: "ghcr.io/u7chan/monorepo/portal",
    });
  });

  test("空文字は空のリポジトリとして扱う", () => {
    expect(parseImageReference("")).toEqual({ repository: "" });
  });
});

describe("describeImage", () => {
  test("タグ付きのイメージを、プレフィックス・名前・コロン付きのタグに分ける", () => {
    expect(describeImage("ghcr.io/u7chan/monorepo/portal:sha-abc1234")).toEqual({
      prefix: "ghcr.io/u7chan/monorepo/",
      name: "portal",
      version: ":sha-abc1234",
    });
  });

  test("レジストリのポートはタグに含めない", () => {
    expect(describeImage("registry.example:5000/team/app:v1")).toEqual({
      prefix: "registry.example:5000/team/",
      name: "app",
      version: ":v1",
    });
  });

  test("名前空間の無いイメージは、プレフィックスを空にする", () => {
    expect(describeImage("nginx:alpine")).toEqual({
      prefix: "",
      name: "nginx",
      version: ":alpine",
    });
  });

  test("タグも digest も無いイメージは、識別子を空にする", () => {
    expect(describeImage("redis")).toEqual({ prefix: "", name: "redis", version: "" });
  });

  test("digest は algorithm を残して先頭 12 桁に短縮する", () => {
    expect(
      describeImage(
        "ghcr.io/u7chan/monorepo/file-server@sha256:0f4e2c9b1d7a3586c0be24f9a1d8e37750b6c4a2e91d3f8c7b5a6021de4f9a3c",
      ),
    ).toEqual({
      prefix: "ghcr.io/u7chan/monorepo/",
      name: "file-server",
      version: "@sha256:0f4e2c9b1d7a",
    });
  });

  test("タグと digest の両方があれば、両方を識別子に残す", () => {
    expect(describeImage("app:v2@sha256:0f4e2c9b1d7a3586c0be")).toEqual({
      prefix: "",
      name: "app",
      version: ":v2@sha256:0f4e2c9b1d7a",
    });
  });
});

describe("monorepoProject", () => {
  test("monorepo の GHCR イメージだけ project 名を返す", () => {
    expect(monorepoProject("ghcr.io/u7chan/monorepo/usage-portal:sha-abc1234")).toBe(
      "usage-portal",
    );
    expect(monorepoProject("ghcr.io/u7chan/monorepo/file-server@sha256:abc123")).toBe(
      "file-server",
    );
  });

  test("Docker Hub のイメージは対象外", () => {
    expect(monorepoProject("caddy:2")).toBeUndefined();
    expect(monorepoProject("postgres:17-alpine")).toBeUndefined();
  });

  test("第三者の GHCR イメージは対象外", () => {
    expect(monorepoProject("ghcr.io/amir20/dozzle:latest")).toBeUndefined();
  });

  test("project 名が空、または不正な形なら対象外", () => {
    expect(monorepoProject("ghcr.io/u7chan/monorepo/")).toBeUndefined();
    expect(monorepoProject("ghcr.io/u7chan/monorepo/portal/extra")).toBeUndefined();
    expect(monorepoProject("ghcr.io/u7chan/monorepo/Portal")).toBeUndefined();
  });
});

describe("isValidImageTag", () => {
  test("Docker のタグとして有効な文字列を受け付ける", () => {
    expect(isValidImageTag("latest")).toBe(true);
    expect(isValidImageTag("sha-0ff5c144")).toBe(true);
    expect(isValidImageTag("manual_feat-1.2")).toBe(true);
  });

  test("空、空白、スラッシュ、改行は拒否する", () => {
    expect(isValidImageTag("")).toBe(false);
    expect(isValidImageTag(" ")).toBe(false);
    expect(isValidImageTag("team/tag")).toBe(false);
    expect(isValidImageTag("tag\nimage")).toBe(false);
  });

  test("128 文字を超えるタグは拒否する", () => {
    expect(isValidImageTag(`a${"b".repeat(127)}`)).toBe(true);
    expect(isValidImageTag(`a${"b".repeat(128)}`)).toBe(false);
  });
});

describe("isDeployableImageTag", () => {
  test("latest は送信対象にしない", () => {
    expect(isDeployableImageTag("latest")).toBe(false);
    expect(isDeployableImageTag("sha-0ff5c144")).toBe(true);
    expect(isDeployableImageTag("manual-test-abc1234")).toBe(true);
  });

  test("Docker のタグとして不正な文字列は拒否する", () => {
    expect(isDeployableImageTag("team/tag")).toBe(false);
  });
});

describe("isOlderImageTag", () => {
  const tags = [
    { tag: "sha-new", createdAt: "2026-11-13T13:06:22Z" },
    { tag: "manual-new", createdAt: "2026-11-13T13:06:22Z" },
    { tag: "sha-old", createdAt: "2026-11-12T09:00:00Z" },
  ];

  test("選択タグが current より前のビルドなら true", () => {
    expect(isOlderImageTag(tags, "sha-new", "sha-old")).toBe(true);
  });

  test("選択タグが current より後、または同じビルドなら false", () => {
    expect(isOlderImageTag(tags, "sha-old", "sha-new")).toBe(false);
    expect(isOlderImageTag(tags, "sha-new", "manual-new")).toBe(false);
    expect(isOlderImageTag(tags, "sha-new", "sha-new")).toBe(false);
  });

  test("current が一覧に無い、または latest なら比較せず false", () => {
    expect(isOlderImageTag(tags, "sha-gone", "sha-old")).toBe(false);
    expect(isOlderImageTag(tags, "latest", "sha-old")).toBe(false);
    expect(isOlderImageTag(tags, "", "sha-old")).toBe(false);
  });

  test("選択タグが一覧に無い、または空なら比較せず false", () => {
    expect(isOlderImageTag(tags, "sha-new", "sha-gone")).toBe(false);
    expect(isOlderImageTag(tags, "sha-new", "")).toBe(false);
    expect(isOlderImageTag([], "sha-new", "sha-old")).toBe(false);
  });

  test("日時が無い、または解析できないタグは比較せず false", () => {
    const partial = [
      { tag: "sha-new", createdAt: "2026-11-13T13:06:22Z" },
      { tag: "sha-old" },
      { tag: "sha-broken", createdAt: "not-a-date" },
    ];
    expect(isOlderImageTag(partial, "sha-new", "sha-old")).toBe(false);
    expect(isOlderImageTag(partial, "sha-new", "sha-broken")).toBe(false);
    expect(
      isOlderImageTag(
        [{ tag: "sha-new" }, { tag: "sha-old", createdAt: "2026-11-12T09:00:00Z" }],
        "sha-new",
        "sha-old",
      ),
    ).toBe(false);
  });
});

describe("findNewerImageTag", () => {
  const tags = [
    { tag: "sha-new", createdAt: "2026-11-13T13:06:22Z" },
    { tag: "manual-new", createdAt: "2026-11-13T13:06:22Z" },
    { tag: "sha-old", createdAt: "2026-11-12T09:00:00Z" },
  ];

  test("現在より後にビルドされたタグがあれば、その最新を返す", () => {
    expect(findNewerImageTag(tags, "sha-old")?.tag).toBe("sha-new");
  });

  test("最新のビルドが動いていれば undefined", () => {
    expect(findNewerImageTag(tags, "sha-new")).toBeUndefined();
    expect(findNewerImageTag(tags, "manual-new")).toBeUndefined();
  });

  test("現在のタグが一覧に無い、latest、空なら比較しない", () => {
    expect(findNewerImageTag(tags, "sha-gone")).toBeUndefined();
    expect(findNewerImageTag(tags, "latest")).toBeUndefined();
    expect(findNewerImageTag(tags, "")).toBeUndefined();
  });

  test("日時が無い、または解析できないタグは新着として扱わない", () => {
    const partial = [
      { tag: "sha-current", createdAt: "2026-11-12T09:00:00Z" },
      { tag: "sha-unknown" },
      { tag: "sha-broken", createdAt: "not-a-date" },
    ];

    expect(findNewerImageTag(partial, "sha-current")).toBeUndefined();
  });

  test("一覧が空なら undefined", () => {
    expect(findNewerImageTag([], "sha-old")).toBeUndefined();
  });
});

describe("isValidDeployTarget", () => {
  test("kebab-case の target を受け付ける", () => {
    expect(isValidDeployTarget("usage-portal")).toBe(true);
    expect(isValidDeployTarget("portal")).toBe(true);
  });

  test("大文字、空白、スラッシュ、改行は拒否する", () => {
    expect(isValidDeployTarget("UsagePortal")).toBe(false);
    expect(isValidDeployTarget("usage portal")).toBe(false);
    expect(isValidDeployTarget("../portal")).toBe(false);
    expect(isValidDeployTarget("portal\n--help")).toBe(false);
  });
});
