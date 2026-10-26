// POST /v1/skills/import。実ファイルシステムを使い、listen せず app.request() で検証する。
// ZIP は test/zip-fixtures.ts の自前ビルダで組み（writer の出力では作れない形式・壊れた値を含む）、
// 構造不正・スキル個別の不正・plan / apply の分類・置換と巻き戻し・一時データの掃除を固定する。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, symlinkSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { createSandboxService, type SandboxServiceOptions } from "../src/sandbox/service";
import type { SandboxSkillsImportApply, SandboxSkillsImportPlan } from "../src/sandbox/protocol";
import { extractZipEntry, readZipArchive } from "../src/sandbox/zip-read";
import { buildZip, skillEntries, type ZipFixtureEntry } from "./zip-fixtures";

const TOKEN = "test-sandbox-token-0123456789abcdef";

type App = ReturnType<typeof createSandboxService>["app"];

const HAS_SYMLINK = (() => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sbx-skill-import-symlink-check-"));
  try {
    symlinkSync(dir, join(dir, "link"));
    return true;
  } catch {
    return false;
  }
})();
const SYMLINK_SKIP_REASON = "symlinks are not available on this platform";

function makeRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `pi-sbx-skill-import-${prefix}-`));
}

function createService(root: string, options: Partial<SandboxServiceOptions> = {}) {
  return createSandboxService({ token: TOKEN, rootCwd: root, ...options });
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/zip" };
}

function skillText(name: string, body = "本文\n"): string {
  return `---\nname: ${name}\ndescription: "説明"\n---\n${body}`;
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** ZIP をアップロードし、応答の JSON と status を返す */
async function importArchive(
  app: App,
  body: Buffer | string,
  query = "",
): Promise<{ status: number; body: SandboxSkillsImportPlan & SandboxSkillsImportApply & { error?: string } }> {
  const response = await app.request(`/v1/skills/import${query}`, { method: "POST", headers: authHeaders(), body });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

/** ルート相対のファイルと空ディレクトリ (`name/`) のバイト列を集める */
async function readTree(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const child of await readdir(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isDirectory()) {
        files.set(`${name}/`, Buffer.alloc(0));
        await walk(join(dir, child.name), name);
        continue;
      }
      if (child.isFile()) files.set(name, await readFile(join(dir, child.name)));
    }
  };
  await walk(root, "");
  return files;
}

/** `.agents` 直下に残った取り込みの一時ディレクトリ */
async function importTempDirs(root: string): Promise<string[]> {
  const names = await readdir(join(root, ".agents")).catch(() => []);
  return names.filter((name) => name.startsWith(".import-"));
}

/** 構造不正の検証で共通に使う「何も書かれていない」の確認 */
async function assertUntouched(root: string): Promise<void> {
  assert.equal(await lstat(join(root, ".agents/skills")).catch(() => undefined), undefined);
  assert.deepEqual(await importTempDirs(root), []);
}

/** 取り込みの失敗の本文が、内部パスを含まない固定文言か (apply と前提処理で共通) */
function assertImportFailureBody(error: string | undefined, root: string): void {
  assert.equal(error, "スキルをインポートできませんでした");
  assert.ok(!(error ?? "").includes(root), "ワークスペースの絶対パスが本文に載っている");
  for (const fragment of [".agents", "mkdir", "rename", "EEXIST", "ENOTDIR", "ENOENT", "staging", ".import-"]) {
    assert.ok(!(error ?? "").includes(fragment), `本文に ${fragment} が載っている`);
  }
}

/** アーカイブを読めないときの失敗が、内部パスを含まない固定文言の 500 か */
function assertArchiveUnreadable(error: unknown, root: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  assert.equal(message, "Invalid ZIP archive: the received archive cannot be read");
  assert.equal((error as { statusCode?: number }).statusCode, 500);
  assert.ok(!message.includes(root), "ワークスペースの絶対パスが本文に載っている");
  for (const fragment of [".import-", "ENOENT", "open"]) {
    assert.ok(!message.includes(fragment), `本文に ${fragment} が載っている`);
  }
  return true;
}

test("export した ZIP を取り込むと全ファイルのバイトが一致し、発見結果に現れる", async () => {
  const source = makeRoot("roundtrip-source");
  const sourceService = createService(source);
  let zip: Buffer;
  try {
    await mkdir(join(source, ".agents/skills/alpha/references"), { recursive: true });
    await mkdir(join(source, ".agents/skills/alpha/empty"), { recursive: true });
    await writeFile(join(source, ".agents/skills/alpha/SKILL.md"), skillText("alpha"), "utf8");
    await writeFile(join(source, ".agents/skills/alpha/references/日本語 メモ.md"), "参照\n", "utf8");
    await writeFile(join(source, ".agents/skills/alpha/scripts.sh"), "#!/bin/sh\n", "utf8");
    // `.git` は export に入らない
    await mkdir(join(source, ".agents/skills/alpha/.git"), { recursive: true });
    await writeFile(join(source, ".agents/skills/alpha/.git/HEAD"), "ref\n", "utf8");
    const exported = await sourceService.app.request("/v1/skills/export", { headers: authHeaders() });
    assert.equal(exported.status, 200);
    zip = Buffer.from(await exported.arrayBuffer());
  } finally {
    sourceService.close();
  }

  const target = makeRoot("roundtrip-target");
  const targetService = createService(target);
  try {
    const result = await importArchive(targetService.app, zip);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.applied, [
      {
        name: "alpha",
        relativePath: ".agents/skills/alpha/SKILL.md",
        fileVersion: sha256(skillText("alpha")),
        replaced: false,
      },
    ]);
    assert.deepEqual(result.body.skipped, []);

    // 各スキルの全ファイルがバイトで一致する (`.git` は export 対象外なので除く)
    const expected = await readTree(join(source, ".agents/skills/alpha"));
    const actual = await readTree(join(target, ".agents/skills/alpha"));
    for (const name of expected.keys()) if (name.startsWith(".git/")) expected.delete(name);
    assert.deepEqual(actual, expected);

    // 取り込んだスキルは SDK の発見結果に現れる
    const discovered = await targetService.app.request("/v1/skills?dir=.agents%2Fskills", { headers: authHeaders() });
    assert.equal(discovered.status, 200);
    const skills = (await discovered.json()) as { skills: { name: string }[] };
    assert.deepEqual(
      skills.skills.map((skill) => skill.name),
      ["alpha"],
    );
    // 成功時も一時ディレクトリを残さない
    assert.deepEqual(await importTempDirs(target), []);
  } finally {
    targetService.close();
  }
});

test("plan は new / identical / conflict / invalid を理由つきで返し、何も書かない", async () => {
  const root = makeRoot("plan");
  const service = createService(root);
  try {
    await mkdir(join(root, ".agents/skills/same"), { recursive: true });
    await writeFile(join(root, ".agents/skills/same/SKILL.md"), skillText("same"), "utf8");
    await mkdir(join(root, ".agents/skills/diff"), { recursive: true });
    await writeFile(join(root, ".agents/skills/diff/SKILL.md"), skillText("diff", "古い\n"), "utf8");

    const zip = buildZip([
      ...skillEntries("same", { "SKILL.md": skillText("same") }),
      ...skillEntries("diff", { "SKILL.md": skillText("diff") }),
      ...skillEntries("fresh", { "SKILL.md": skillText("fresh") }),
      ...skillEntries("broken", { "SKILL.md": "frontmatter が無い SKILL.md\n" }),
    ]);
    const result = await importArchive(service.app, zip, "?dryRun=true");
    assert.equal(result.status, 200);
    const plan = result.body as SandboxSkillsImportPlan;
    assert.deepEqual(
      plan.skills.map((skill) => ({ name: skill.name, status: skill.status })),
      [
        { name: "same", status: "identical" },
        { name: "diff", status: "conflict" },
        { name: "fresh", status: "new" },
        { name: "broken", status: "invalid" },
      ],
    );
    const broken = plan.skills.find((skill) => skill.name === "broken");
    assert.ok(broken?.reason && broken.reason.length > 0, "invalid の理由が無い");
    // entries / bytes は検証に使った ZIP の総数
    assert.equal(plan.entries, 8);
    assert.equal(
      plan.bytes,
      Buffer.byteLength(skillText("same")) +
        Buffer.byteLength(skillText("diff")) +
        Buffer.byteLength(skillText("fresh")) +
        Buffer.byteLength("frontmatter が無い SKILL.md\n"),
    );

    // plan は何も変更しない
    assert.equal(await readFile(join(root, ".agents/skills/diff/SKILL.md"), "utf8"), skillText("diff", "古い\n"));
    assert.equal(await lstat(join(root, ".agents/skills/fresh")).catch(() => undefined), undefined);
    assert.deepEqual(await importTempDirs(root), []);
  } finally {
    service.close();
  }
});

test("apply は決定 3 の表どおりに applied / skipped を返す", async () => {
  const root = makeRoot("apply");
  const service = createService(root);
  try {
    await mkdir(join(root, ".agents/skills/same"), { recursive: true });
    await writeFile(join(root, ".agents/skills/same/SKILL.md"), skillText("same"), "utf8");
    await mkdir(join(root, ".agents/skills/diff"), { recursive: true });
    await writeFile(join(root, ".agents/skills/diff/SKILL.md"), skillText("diff", "古い\n"), "utf8");

    const zip = buildZip([
      ...skillEntries("diff", { "SKILL.md": skillText("diff") }),
      ...skillEntries("fresh", { "SKILL.md": skillText("fresh") }),
      ...skillEntries("same", { "SKILL.md": skillText("same") }),
      ...skillEntries("broken", { "SKILL.md": "frontmatter が無い SKILL.md\n" }),
    ]);

    // replace に無い conflict は取り込まず、identical は書き込みを省略し、invalid は常にスキップする
    const first = await importArchive(service.app, zip);
    assert.equal(first.status, 200);
    assert.deepEqual(await readFile(join(root, ".agents/skills/diff/SKILL.md"), "utf8"), skillText("diff", "古い\n"));
    assert.equal(await readFile(join(root, ".agents/skills/fresh/SKILL.md"), "utf8"), skillText("fresh"));
    const skipped = first.body.skipped as { name: string; reason: string }[];
    assert.deepEqual(
      skipped.map((item) => item.name),
      ["diff", "same", "broken"],
    );
    assert.equal(skipped[0]?.reason, "同名のためインポートしない");
    assert.equal(skipped[1]?.reason, "内容が同一");
    assert.ok(skipped[2]?.reason && skipped[2].reason.length > 0);
    assert.deepEqual(first.body.applied, [
      {
        name: "fresh",
        relativePath: ".agents/skills/fresh/SKILL.md",
        fileVersion: sha256(skillText("fresh")),
        replaced: false,
      },
    ]);

    // 2 回目は fresh も identical。replace=diff のときだけ diff をフォルダごと置換する
    const second = await importArchive(service.app, zip, "?replace=diff&replace=diff");
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.applied, [
      {
        name: "diff",
        relativePath: ".agents/skills/diff/SKILL.md",
        fileVersion: sha256(skillText("diff")),
        replaced: true,
      },
    ]);
    assert.deepEqual(
      (second.body.skipped as { name: string }[]).map((item) => item.name),
      ["fresh", "same", "broken"],
    );
    assert.equal(await readFile(join(root, ".agents/skills/diff/SKILL.md"), "utf8"), skillText("diff"));
    assert.deepEqual(await importTempDirs(root), []);
  } finally {
    service.close();
  }
});

test("replace の名前が bundle または既存に無ければ無視する (何も作らず、何も消さない)", async () => {
  const root = makeRoot("replace-unknown");
  const service = createService(root);
  try {
    await mkdir(join(root, ".agents/skills/solo"), { recursive: true });
    await writeFile(join(root, ".agents/skills/solo/SKILL.md"), skillText("solo", "そのまま\n"), "utf8");

    const zip = buildZip(skillEntries("alpha", { "SKILL.md": skillText("alpha") }));
    const result = await importArchive(service.app, zip, "?replace=solo&replace=not-in-bundle");
    assert.equal(result.status, 200);
    assert.deepEqual(
      (result.body.applied as { name: string }[]).map((item) => item.name),
      ["alpha"],
    );
    // bundle に無い solo は置換されず、not-in-bundle は作られない
    assert.equal(await readFile(join(root, ".agents/skills/solo/SKILL.md"), "utf8"), skillText("solo", "そのまま\n"));
    assert.equal(await lstat(join(root, ".agents/skills/not-in-bundle")).catch(() => undefined), undefined);
  } finally {
    service.close();
  }
});

test("data descriptor なしの他ツール形式 (store / deflate / 日本語名 / 空ディレクトリ) を読める", async () => {
  const root = makeRoot("no-descriptor");
  const service = createService(root);
  try {
    // 既存 writer は常に data descriptor を付ける。他ツールの形式 (bit 3 なし、
    // ローカルヘッダに CRC / サイズを書く) も受ける。
    // Python の zipfile は空ディレクトリを deflate て書く (size 0 / compressedSize 2) ため、
    // その形式 (圧縮データ付きのディレクトリ) も展開して空と CRC 0 を確かめて受ける
    const emptyDeflate = deflateRawSync(Buffer.alloc(0));
    const zip = buildZip([
      { name: "alpha/" },
      {
        name: "alpha/sub/",
        compression: "deflate",
        compressedData: emptyDeflate,
        rawSize: 0,
        descriptor: false,
      },
      {
        name: "alpha/sub2/",
        compression: "deflate",
        compressedData: emptyDeflate,
        rawSize: 0,
      },
      { name: "alpha/SKILL.md", data: skillText("alpha"), descriptor: false, compression: "deflate" },
      { name: "alpha/refs/日本語.txt", data: "参照\n", descriptor: false, compression: "store" },
      // bit 11 が無くても ASCII 名は読む
      { name: "alpha/ascii.txt", data: "ascii\n", descriptor: false, utf8: false },
    ]);
    const planned = await importArchive(service.app, zip, "?dryRun=true");
    assert.equal(planned.status, 200);
    assert.deepEqual(planned.body.skills, [{ name: "alpha", status: "new" }]);

    const applied = await importArchive(service.app, zip);
    assert.equal(applied.status, 200);
    assert.equal(await readFile(join(root, ".agents/skills/alpha/SKILL.md"), "utf8"), skillText("alpha"));
    assert.equal(await readFile(join(root, ".agents/skills/alpha/refs/日本語.txt"), "utf8"), "参照\n");
    assert.equal(await readFile(join(root, ".agents/skills/alpha/ascii.txt"), "utf8"), "ascii\n");
    assert.ok((await lstat(join(root, ".agents/skills/alpha/sub"))).isDirectory());
    assert.ok((await lstat(join(root, ".agents/skills/alpha/sub2"))).isDirectory());
  } finally {
    service.close();
  }
});

test("フォルダ名と name が違うスキルは invalid になり、他のスキルは取り込まれる", async () => {
  const root = makeRoot("name-mismatch");
  const service = createService(root);
  try {
    const zip = buildZip([
      ...skillEntries("mismatch", { "SKILL.md": skillText("other") }),
      ...skillEntries("kept", { "SKILL.md": skillText("kept") }),
    ]);
    const result = await importArchive(service.app, zip);
    assert.equal(result.status, 200);
    assert.deepEqual(
      (result.body.applied as { name: string }[]).map((item) => item.name),
      ["kept"],
    );
    const skipped = result.body.skipped as { name: string; reason: string }[];
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.name, "mismatch");
    assert.match(skipped[0]?.reason ?? "", /フォルダ名/);
    assert.equal(await lstat(join(root, ".agents/skills/mismatch")).catch(() => undefined), undefined);
    assert.equal(await readFile(join(root, ".agents/skills/kept/SKILL.md"), "utf8"), skillText("kept"));
  } finally {
    service.close();
  }
});

test("staging の走査は ignore ファイル (.gitignore) を効かせる", async () => {
  const root = makeRoot("ignore");
  const service = createService(root);
  try {
    // `.gitignore` が SKILL.md を除外すれば、SDK はそのスキルを読まない
    const ignored = buildZip([
      ...skillEntries("alpha", { "SKILL.md": skillText("alpha"), ".gitignore": "SKILL.md\n" }),
    ]);
    const rejected = await importArchive(service.app, ignored, "?dryRun=true");
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.skills[0]?.status, "invalid");

    // 対照: 他のパターンなら同じ内容でも new になる
    const kept = buildZip([...skillEntries("alpha", { "SKILL.md": skillText("alpha"), ".gitignore": "drafts/\n" })]);
    const accepted = await importArchive(service.app, kept, "?dryRun=true");
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body.skills, [{ name: "alpha", status: "new" }]);
  } finally {
    service.close();
  }
});

test("SKILL.md が symlink の既存スキルは置換しない", { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON }, async () => {
  const root = makeRoot("symlink-skill-file");
  const service = createService(root);
  try {
    await mkdir(join(root, ".agents/skills/alpha"), { recursive: true });
    await writeFile(join(root, ".agents/skills/target.md"), skillText("alpha", "そのまま\n"), "utf8");
    symlinkSync(join(root, ".agents/skills/target.md"), join(root, ".agents/skills/alpha/SKILL.md"));

    const zip = buildZip(skillEntries("alpha", { "SKILL.md": skillText("alpha") }));
    const plan = await importArchive(service.app, zip, "?dryRun=true");
    assert.equal(plan.status, 200);
    assert.deepEqual(plan.body.skills, [{ name: "alpha", status: "conflict" }]);

    const applied = await importArchive(service.app, zip, "?replace=alpha");
    assert.equal(applied.status, 200);
    assert.deepEqual(applied.body.applied, []);
    assert.deepEqual(
      (applied.body.skipped as { name: string; reason: string }[]).map((item) => item.name),
      ["alpha"],
    );
    assert.match((applied.body.skipped as { reason: string }[])[0]?.reason ?? "", /シンボリックリンク/);
    // symlink も参照先の内容も変わらない
    assert.ok((await lstat(join(root, ".agents/skills/alpha/SKILL.md"))).isSymbolicLink());
    assert.equal(await readFile(join(root, ".agents/skills/target.md"), "utf8"), skillText("alpha", "そのまま\n"));
  } finally {
    service.close();
  }
});

test(
  "置き場の外へ解決する既存スキルは置換せず、同じ bundle の他のスキルは取り込む",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    const root = makeRoot("outside-symlink");
    const outside = makeRoot("outside-symlink-target");
    const service = createService(root);
    try {
      // SKILL.md がワークスペース外を指す既存スキルと、フォルダ自身が外を指す symlink の既存スキル
      await mkdir(join(root, ".agents/skills/alpha"), { recursive: true });
      await writeFile(join(outside, "skill.md"), skillText("alpha", "外の本文\n"), "utf8");
      symlinkSync(join(outside, "skill.md"), join(root, ".agents/skills/alpha/SKILL.md"));
      symlinkSync(outside, join(root, ".agents/skills/beta"));

      const zip = buildZip([
        ...skillEntries("alpha", { "SKILL.md": skillText("alpha") }),
        ...skillEntries("beta", { "SKILL.md": skillText("beta") }),
        ...skillEntries("other", { "SKILL.md": skillText("other") }),
      ]);
      // 解決できない同名 (alpha / beta) は conflict にし、new の other は通常どおり取り込む
      const plan = await importArchive(service.app, zip, "?dryRun=true");
      assert.equal(plan.status, 200, JSON.stringify(plan.body));
      assert.deepEqual(plan.body.skills, [
        { name: "alpha", status: "conflict" },
        { name: "beta", status: "conflict" },
        { name: "other", status: "new" },
      ]);

      const applied = await importArchive(service.app, zip, "?replace=alpha&replace=beta");
      assert.equal(applied.status, 200);
      assert.deepEqual(
        (applied.body.applied as { name: string }[]).map((item) => item.name),
        ["other"],
      );
      const skipped = applied.body.skipped as { name: string; reason: string }[];
      assert.deepEqual(
        skipped.map((item) => item.name),
        ["alpha", "beta"],
      );
      assert.match(skipped[0]?.reason ?? "", /シンボリックリンク/);
      assert.match(skipped[1]?.reason ?? "", /置き場の外/);
      // 置き場の外の実体と symlink は変わらない
      assert.equal(await readFile(join(outside, "skill.md"), "utf8"), skillText("alpha", "外の本文\n"));
      assert.ok((await lstat(join(root, ".agents/skills/beta"))).isSymbolicLink());
      assert.equal(await readFile(join(root, ".agents/skills/other/SKILL.md"), "utf8"), skillText("other"));
    } finally {
      service.close();
    }
  },
);

test("既存スキルの同一判定は上限で打ち切り、超過は conflict にする", async () => {
  const root = makeRoot("existing-limits");
  const service = createService(root, { maxArchiveEntries: 2 });
  try {
    // バンドルと同一のファイル + 空ディレクトリ。上限が無ければ identical になる形
    await mkdir(join(root, ".agents/skills/same/extra1"), { recursive: true });
    await mkdir(join(root, ".agents/skills/same/extra2"), { recursive: true });
    await writeFile(join(root, ".agents/skills/same/SKILL.md"), skillText("same"), "utf8");

    // バンドル (same/ + same/SKILL.md) は上限内、既存フォルダは 3 エントリで超過
    const zip = buildZip(skillEntries("same", { "SKILL.md": skillText("same") }));
    const plan = await importArchive(service.app, zip, "?dryRun=true");
    assert.equal(plan.status, 200);
    assert.deepEqual(plan.body.skills, [{ name: "same", status: "conflict" }]);

    const applied = await importArchive(service.app, zip);
    assert.equal(applied.status, 200);
    assert.deepEqual(applied.body.applied, []);
    assert.equal((applied.body.skipped as { reason: string }[])[0]?.reason, "同名のためインポートしない");
  } finally {
    service.close();
  }
});

test("構造不正は 400 / 413 で全体を断り、`.agents/skills` に何も書かない", async () => {
  const root = makeRoot("structure");
  const service = createService(root, { maxArchiveEntries: 50, maxArchiveBytes: 100_000 });
  const skillFile = (name: string): ZipFixtureEntry => ({ name: `${name}/SKILL.md`, data: skillText(name) });
  try {
    const cases: Array<[string, Buffer, number, RegExp]> = [
      [
        "zip slip (..)",
        buildZip([{ name: "alpha/../evil/SKILL.md", data: skillText("alpha") }]),
        400,
        /Invalid ZIP entry name/,
      ],
      ["絶対パス", buildZip([{ name: "/abs/SKILL.md", data: skillText("alpha") }]), 400, /Invalid ZIP entry name/],
      ["backslash", buildZip([{ name: "alpha\\SKILL.md", data: skillText("alpha") }]), 400, /Invalid ZIP entry name/],
      [
        "symlink エントリ",
        buildZip([{ name: "alpha/SKILL.md", data: skillText("alpha"), externalAttributes: (0o120777 << 16) >>> 0 }]),
        400,
        /Symbolic link/,
      ],
      ["重複名", buildZip([skillFile("alpha"), skillFile("alpha")]), 400, /Duplicate ZIP entry/],
      [
        ".git を含むパス",
        buildZip([skillFile("alpha"), { name: "alpha/.git/config", data: "x\n" }]),
        400,
        /Excluded from skill archives/,
      ],
      ["直下のファイル", buildZip([skillFile("alpha"), { name: "README.md", data: "x\n" }]), 400, /直下項目/],
      [
        "SKILL.md を持たないフォルダ",
        buildZip([
          { name: "beta/", data: "" },
          { name: "beta/notes.txt", data: "x\n" },
        ]),
        400,
        /SKILL.md を持たない/,
      ],
      [
        "hidden の直下フォルダ",
        buildZip([
          { name: ".hidden/", data: "" },
          { name: ".hidden/SKILL.md", data: skillText("hidden") },
        ]),
        400,
        /Hidden directories/,
      ],
      ["Zip64 の EOCD", buildZip([skillFile("alpha")], { zip64: true }), 400, /Zip64/],
      ["Zip64 locator", buildZip([skillFile("alpha")], { zip64Locator: true }), 400, /Zip64/],
      ["暗号化", buildZip([{ name: "alpha/SKILL.md", data: skillText("alpha"), encrypted: true }]), 400, /encrypted/],
      [
        "未対応の圧縮",
        buildZip([{ name: "alpha/SKILL.md", data: skillText("alpha"), method: 12 }]),
        400,
        /unsupported compression/,
      ],
      ["CRC 不一致", buildZip([{ name: "alpha/SKILL.md", data: skillText("alpha"), crcOverride: 0 }]), 400, /CRC-32/],
      [
        "bit 11 無しの非 ASCII 名",
        buildZip([skillFile("alpha"), { name: "alpha/日本語.md", data: "参照\n", utf8: false }]),
        400,
        /non-ASCII/,
      ],
      [
        "ローカルヘッダと中央の不一致",
        buildZip([{ name: "alpha/SKILL.md", data: skillText("alpha"), descriptor: false, localSizeOverride: 9999 }]),
        400,
        /local header/,
      ],
      [
        "data descriptor と中央の不一致",
        buildZip([{ name: "alpha/SKILL.md", data: skillText("alpha"), descriptorCrcOverride: 0 }]),
        400,
        /data descriptor/,
      ],
      [
        "ディレクトリの展開結果が空でない",
        buildZip([
          skillFile("alpha"),
          { name: "alpha/sub/", compression: "deflate", compressedData: deflateRawSync("x"), rawSize: 0 },
        ]),
        400,
        /expands beyond/,
      ],
      [
        "ディレクトリのサイズが 0 でない",
        buildZip([skillFile("alpha"), { name: "alpha/sub/", rawSize: 1, compressedData: deflateRawSync("x") }]),
        400,
        /directory entry has data/,
      ],
      [
        "ファイルとディレクトリの同名衝突",
        buildZip([
          skillFile("alpha"),
          { name: "alpha/foo", data: "file\n" },
          { name: "alpha/foo/bar", data: "nested\n" },
        ]),
        400,
        /cannot extract alpha\/foo\/bar/,
      ],
      [
        "サイズ不一致",
        buildZip([{ name: "alpha/SKILL.md", data: skillText("alpha"), sizeOverride: 9999 }]),
        400,
        /size/,
      ],
      ["切り詰め", buildZip([skillFile("alpha")], { truncate: 10 }), 400, /Invalid ZIP archive/],
      ["空の本文", Buffer.alloc(0), 400, /Invalid ZIP archive/],
    ];
    for (const [label, body, status, pattern] of cases) {
      const result = await importArchive(service.app, body);
      assert.equal(result.status, status, `${label}: ${JSON.stringify(result.body)}`);
      assert.match(result.body.error ?? "", pattern, label);
      await assertUntouched(root);
    }
  } finally {
    service.close();
  }

  // 上限超過は 413
  const entryLimitRoot = makeRoot("limit-entries");
  const entryLimitService = createService(entryLimitRoot, { maxArchiveEntries: 1 });
  try {
    const result = await importArchive(
      entryLimitService.app,
      buildZip([
        { name: "alpha/", data: "" },
        { name: "alpha/SKILL.md", data: skillText("alpha") },
      ]),
    );
    assert.equal(result.status, 413);
    assert.match(result.body.error ?? "", /too many entries/);
    await assertUntouched(entryLimitRoot);
  } finally {
    entryLimitService.close();
  }

  const byteLimitRoot = makeRoot("limit-bytes");
  const byteLimitService = createService(byteLimitRoot, { maxArchiveBytes: 10 });
  try {
    const result = await importArchive(byteLimitService.app, buildZip([skillFile("alpha")]));
    assert.equal(result.status, 413);
    assert.match(result.body.error ?? "", /too large/);
    await assertUntouched(byteLimitRoot);
  } finally {
    byteLimitService.close();
  }

  const bodyLimitRoot = makeRoot("limit-body");
  const bodyLimitService = createService(bodyLimitRoot, { maxUploadBytes: 16 });
  try {
    const result = await importArchive(bodyLimitService.app, buildZip([skillFile("alpha")]));
    assert.equal(result.status, 413);
    assert.match(result.body.error ?? "", /too large \(max 16 bytes\)/);
    await assertUntouched(bodyLimitRoot);
  } finally {
    bodyLimitService.close();
  }
});

test(
  "途中で失敗したら適用済みを戻し、一時ディレクトリを残さない",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    const root = makeRoot("rollback");
    const service = createService(root);
    try {
      // alpha -> beta の symlink により、alpha と beta の置換対象が同じ実フォルダ (beta) を指す。
      // alpha を適用した時点で beta の置換対象は消えるため、beta の適用は失敗し、alpha の適用が巻き戻る。
      await mkdir(join(root, ".agents/skills/beta"), { recursive: true });
      const originalBeta = skillText("beta", "元の本文\n");
      await writeFile(join(root, ".agents/skills/beta/SKILL.md"), originalBeta, "utf8");
      symlinkSync(join(root, ".agents/skills/beta"), join(root, ".agents/skills/alpha"));

      const zip = buildZip([
        ...skillEntries("alpha", { "SKILL.md": skillText("alpha") }),
        ...skillEntries("beta", { "SKILL.md": skillText("beta") }),
      ]);
      const result = await importArchive(service.app, zip, "?replace=alpha&replace=beta");
      assert.equal(result.status, 500);
      assert.equal(result.body.error, "スキルをインポートできませんでした");

      // 適用済みの alpha は消え、beta は元の内容へ戻る
      assert.equal(await readFile(join(root, ".agents/skills/beta/SKILL.md"), "utf8"), originalBeta);
      assert.deepEqual(await importTempDirs(root), []);
    } finally {
      service.close();
    }
  },
);

test("適用に失敗した応答本文には内部パスを載せない", { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON }, async () => {
  // What: 置換対象が別フォルダへの symlink のとき 2 件目の rename が失敗する形で、
  // 500 の本文が固定文言になり、staging / 置き場の絶対パスや OS メッセージを含まないことを確かめる
  const root = makeRoot("apply-error");
  const service = createService(root);
  try {
    await mkdir(join(root, ".agents/skills/beta"), { recursive: true });
    await writeFile(join(root, ".agents/skills/beta/SKILL.md"), skillText("beta"), "utf8");
    symlinkSync(join(root, ".agents/skills/beta"), join(root, ".agents/skills/alpha"));

    const zip = buildZip([
      ...skillEntries("alpha", { "SKILL.md": skillText("alpha") }),
      ...skillEntries("beta", { "SKILL.md": skillText("beta") }),
    ]);
    const result = await importArchive(service.app, zip, "?replace=alpha&replace=beta");
    assert.equal(result.status, 500);
    assertImportFailureBody(result.body.error, root);
  } finally {
    service.close();
  }
});

test("import の前提処理が失敗したときの応答本文に内部パスを載せない (.agents が通常ファイル)", async () => {
  // What: `.agents` が通常ファイルで一時置き場を作れないとき、本文が固定文言になり、
  // ワークスペースの絶対パスや OS メッセージ (mkdir / EEXIST) を含まないことを確かめる
  const root = makeRoot("prereq-file");
  const service = createService(root);
  try {
    await writeFile(join(root, ".agents"), "not a directory\n", "utf8");
    const zip = buildZip(skillEntries("alpha", { "SKILL.md": skillText("alpha") }));
    const result = await importArchive(service.app, zip);
    assert.equal(result.status, 400);
    assertImportFailureBody(result.body.error, root);
    // 既存のファイルは変わらない
    assert.equal(await readFile(join(root, ".agents"), "utf8"), "not a directory\n");
  } finally {
    service.close();
  }
});

test(
  "import の前提処理が失敗したときの応答本文に内部パスを載せない (.agents が外を指す symlink)",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    // What: `.agents` がワークスペース外を指す symlink のとき、本文が固定文言になり、
    // 外の絶対パスや OS メッセージを含まず、外側に何も作らないことを確かめる
    const root = makeRoot("prereq-symlink");
    const outside = makeRoot("prereq-symlink-target");
    const service = createService(root);
    try {
      symlinkSync(outside, join(root, ".agents"));
      const zip = buildZip(skillEntries("alpha", { "SKILL.md": skillText("alpha") }));
      const result = await importArchive(service.app, zip);
      assert.equal(result.status, 400);
      assertImportFailureBody(result.body.error, root);
      assert.deepEqual(await readdir(outside), []);
    } finally {
      service.close();
    }
  },
);

test(
  "`.agents/skills` が外を指す symlink でも応答本文に内部パスを載せない",
  { skip: !HAS_SYMLINK && SYMLINK_SKIP_REASON },
  async () => {
    // What: 置き場がワークスペース外を指す symlink のとき、plan の失敗が固定文言になり、
    // 外の絶対パスや置き場の内訳を含まず、symlink と外側が変わらないことを確かめる
    const root = makeRoot("skills-outside");
    const outside = makeRoot("skills-outside-target");
    const service = createService(root);
    try {
      await mkdir(join(root, ".agents"), { recursive: true });
      symlinkSync(outside, join(root, ".agents/skills"));
      const zip = buildZip(skillEntries("alpha", { "SKILL.md": skillText("alpha") }));
      for (const query of ["?dryRun=true", ""]) {
        const result = await importArchive(service.app, zip, query);
        assert.equal(result.status, 400, query);
        assertImportFailureBody(result.body.error, root);
      }
      assert.ok((await lstat(join(root, ".agents/skills"))).isSymbolicLink());
      assert.deepEqual(await readdir(outside), []);
    } finally {
      service.close();
    }
  },
);

test("展開時のアーカイブ open 失敗で応答本文に絶対パスを載せない", async () => {
  // What: アーカイブの一時ファイルを消した状態で展開すると、固定文言の 500 になり、
  // ワークスペースの絶対パス・`.import-`・ENOENT・open を含まないことを確かめる
  const root = makeRoot("extract-open");
  const archivePath = join(root, "archive.zip");
  try {
    await writeFile(archivePath, buildZip(skillEntries("alpha", { "SKILL.md": skillText("alpha") })));
    const archive = await readZipArchive(archivePath, { maxBytes: 100_000, maxEntries: 100 });
    const entry = archive.entries.find((candidate) => candidate.name === "alpha/SKILL.md");
    assert.ok(entry, "SKILL.md のエントリが無い");
    await rm(archivePath);

    await assert.rejects(
      extractZipEntry({
        archive: archivePath,
        entry,
        target: join(root, "out/SKILL.md"),
        dataLimit: archive.dataLimit,
      }),
      (error: unknown) => assertArchiveUnreadable(error, root),
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("中央ディレクトリ読み込みのアーカイブ open 失敗でも内部パスを載せない", async () => {
  // What: アーカイブの一時ファイルを消した状態で中央ディレクトリを読むと、固定文言の 500 になり、
  // ワークスペースの絶対パス・`.import-`・ENOENT・open を含まないことを確かめる
  const root = makeRoot("read-open");
  const archivePath = join(root, "archive.zip");
  try {
    await writeFile(archivePath, buildZip(skillEntries("alpha", { "SKILL.md": skillText("alpha") })));
    await rm(archivePath);
    await assert.rejects(readZipArchive(archivePath, { maxBytes: 100_000, maxEntries: 100 }), (error: unknown) =>
      assertArchiveUnreadable(error, root),
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("空の ZIP は受理し、全件 skip のときは `.agents/skills` を作らない", async () => {
  const root = makeRoot("empty");
  const service = createService(root);
  try {
    const empty = buildZip([]);
    const plan = await importArchive(service.app, empty, "?dryRun=true");
    assert.equal(plan.status, 200);
    assert.deepEqual(plan.body, { skills: [], entries: 0, bytes: 0 });

    const applied = await importArchive(service.app, empty);
    assert.equal(applied.status, 200);
    assert.deepEqual(applied.body, { applied: [], skipped: [], entries: 0, bytes: 0 });
    assert.equal(await lstat(join(root, ".agents/skills")).catch(() => undefined), undefined);
    assert.deepEqual(await importTempDirs(root), []);
  } finally {
    service.close();
  }
});

test("dryRun / replace の query は解釈できない値を 400 で断り、重複は畳む", async () => {
  const root = makeRoot("query");
  const service = createService(root);
  try {
    const zip = buildZip(skillEntries("alpha", { "SKILL.md": skillText("alpha") }));
    for (const query of ["?dryRun=1", "?dryRun=true&dryRun=true", "?dryRun=", "?replace=", "?replace=bad%2Fname"]) {
      const result = await importArchive(service.app, zip, query);
      assert.equal(result.status, 400, query);
      await assertUntouched(root);
    }
    const planned = await importArchive(service.app, zip, "?dryRun=true");
    assert.equal(planned.status, 200);
    assert.deepEqual(planned.body.skills, [{ name: "alpha", status: "new" }]);
    // 適用しないので何も作らない
    assert.equal(await lstat(join(root, ".agents/skills")).catch(() => undefined), undefined);
  } finally {
    service.close();
  }
});

test("認証なしは 401", async () => {
  const root = makeRoot("auth");
  const service = createService(root);
  try {
    const response = await service.app.request("/v1/skills/import", { method: "POST", body: buildZip([]) });
    assert.equal(response.status, 401);
    await assertUntouched(root);
  } finally {
    service.close();
  }
});
