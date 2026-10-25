// docs:check が、存在しないリポジトリ内パスと、monorepo checkout での project root 外のリンク切れを fail にすることを固定する。
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../scripts/docs-check.mjs");
const dirs: string[] = [];

type Fixture = {
  projectDir: string;
};

function fixture({ monorepo }: { monorepo: boolean }): Fixture {
  const base = mkdtempSync(join(tmpdir(), "usage-portal-docs-"));
  const monorepoRoot = monorepo ? join(base, "monorepo") : base;
  const projectDir = monorepo ? join(monorepoRoot, "projects", "usage-portal") : base;

  dirs.push(base);

  mkdirSync(join(projectDir, "scripts"), { recursive: true });
  cpSync(script, join(projectDir, "scripts", "docs-check.mjs"));

  if (monorepo) {
    mkdirSync(join(monorepoRoot, ".github"), { recursive: true });
    writeFileSync(join(monorepoRoot, "AGENTS.md"), "# root\n");
  }

  return { projectDir };
}

function write(projectDir: string, path: string, body: string): void {
  mkdirSync(resolve(projectDir, path, ".."), { recursive: true });
  writeFileSync(join(projectDir, path), body);
}

function run(projectDir: string) {
  const result = spawnSync(process.execPath, ["scripts/docs-check.mjs"], { cwd: projectDir, encoding: "utf8" });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("docs-check", () => {
  test("本文のインラインコードにあるリポジトリ内パスが実在すれば通る", () => {
    const { projectDir } = fixture({ monorepo: false });

    write(projectDir, "README.md", "`src/server.ts` と `docs/adr/` を見る。\n");
    write(projectDir, "src/server.ts", "export {};\n");

    const result = run(projectDir);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  test("本文のインラインコードにある存在しないパスは fail する", () => {
    const { projectDir } = fixture({ monorepo: false });

    write(projectDir, "README.md", "`src/does-not-exist.ts` を見る。\n");

    const result = run(projectDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("パスがありません: src/does-not-exist.ts");
  });

  test("フェンス付きコードブロックの中はパスとして検査しない", () => {
    const { projectDir } = fixture({ monorepo: false });

    write(projectDir, "README.md", "```text\nsrc/does-not-exist.ts\n```\n");

    expect(run(projectDir).status).toBe(0);
  });

  test("存在しない相対リンクは fail する", () => {
    const { projectDir } = fixture({ monorepo: false });

    write(projectDir, "docs/a.md", "[b](./b.md)\n");

    const result = run(projectDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("リンク先がありません: ./b.md");
  });

  test("monorepo checkout では project root 外のリンク切れも fail する", () => {
    const { projectDir } = fixture({ monorepo: true });

    write(projectDir, "AGENTS.md", "[root](../../AGENTS-does-not-exist.md)\n");

    const result = run(projectDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("リンク先がありません: ../../AGENTS-does-not-exist.md");
  });

  test("monorepo checkout では project root 外の実在リンクを通す", () => {
    const { projectDir } = fixture({ monorepo: true });

    write(projectDir, "AGENTS.md", "[root](../../AGENTS.md)\n");

    const result = run(projectDir);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0 links outside the project root unchecked");
  });

  test("monorepo が無い Docker 相当では project root 外のリンクを未検査として数える", () => {
    const { projectDir } = fixture({ monorepo: false });

    write(projectDir, "AGENTS.md", "[root](../../AGENTS.md)\n");

    const result = run(projectDir);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 links outside the project root unchecked");
  });
});
