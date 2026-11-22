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

  test("通知はロゴが商標であることと取り込み先を示し、参照するファイルが実在する", () => {
    const source = /(src\/client\/lib\/[\w/.-]+)/.exec(notice)?.[1] ?? null;

    expect(notice).toContain("trademarks of their respective owners");
    expect(source).not.toBeNull();
    expect(existsSync(resolve(root, source ?? ""))).toBe(true);
  });
});
