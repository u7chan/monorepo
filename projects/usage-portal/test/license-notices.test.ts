// 帰属表示が配布物（final stage）に入ることと、通知の内容が実体と合っていることを固定する。
// COPY 行を消しても image のビルドと CI は成功するため、通知の同梱と参照先だけをここで見張る。
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { providerMark } from "../src/client/lib/provider-icon";

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

  test("Gemini のマークの出典（dashboard-icons）と Apache-2.0 の全文と商標表示を含む", () => {
    expect(notice).toContain("https://github.com/homarr-labs/dashboard-icons");
    expect(notice).toContain("https://dashboardicons.com/icons/google-gemini");
    // Apache-2.0 の全文。条文の冒頭・末尾と、配布元の著作権表示まで入っていること。
    expect(notice).toContain("Apache License\n                           Version 2.0, January 2004");
    expect(notice).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION");
    expect(notice).toContain("END OF TERMS AND CONDITIONS");
    expect(notice).toContain("Copyright (c) 2024 Bjorn Lammers, Meier Lukas, Thomas Camlong and Homarr Labs");
    expect(notice).toContain("trademarks of Google");
  });

  test("通知に書いた変更の内容どおり、Gemini のマークは輪郭 1 つの単色で、グラデーションを持たない", () => {
    const mark = providerMark("gemini");

    expect(mark.viewBox).toBe("0 0 65 65");
    expect(mark.parts).toHaveLength(1);
    expect(mark.parts[0]?.shade).toBeUndefined();
    expect(mark.evenodd).toBeUndefined();
    expect(mark.parts[0]?.d).toMatch(/^M[\d.\sa-zA-Z-]+z$/);
    expect(readFileSync(resolve(root, "src/client/components/ProviderIcon.tsx"), "utf8")).toContain(
      'fill="currentColor"',
    );
  });
});
