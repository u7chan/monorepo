// 帰属表示が配布物（final stage）に入ることと、通知の内容が実体と合っていることを固定する。
// COPY 行を消しても image のビルドと CI は成功するため、通知の同梱と参照先だけをここで見張る。
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const notice = readFileSync(resolve(root, "THIRD_PARTY_NOTICES.txt"), "utf8");

describe("THIRD_PARTY_NOTICES.txt", () => {
  test("final stage が通知を image に含める", () => {
    const final = dockerfile.slice(dockerfile.indexOf(" AS final"));

    expect(final).toMatch(/^COPY\b[^\n]*\bTHIRD_PARTY_NOTICES\.txt\b/m);
  });

  test("通知はロゴの取り込み元と MIT の条件を含み、参照するファイルが実在する", () => {
    const source = /(src\/[\w/.-]+)/.exec(notice)?.[1] ?? null;

    expect(notice).toContain("@lobehub/icons-static-svg");
    expect(notice).toContain("Copyright (c) 2023 LobeHub");
    expect(notice).toContain("Permission is hereby granted, free of charge");
    expect(source).not.toBeNull();
    expect(existsSync(resolve(root, source ?? ""))).toBe(true);
  });
});
