// イメージ参照と入力検証のユニットテスト

import { describe, expect, test } from "bun:test";
import {
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
