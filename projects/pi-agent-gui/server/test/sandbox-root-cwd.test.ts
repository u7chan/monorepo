// 作業領域の準備失敗を、生のスタックではなく再現手順つきの案内として返すことを検証する。
// (Docker の既定 /workspace は契約のまま維持し、ホスト実行だけを案内の対象にする)
import assert from "node:assert/strict";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareRootCwd } from "../src/sandbox/root-cwd";

// root は書込み権限の無いディレクトリにも書けるため、権限の検証は非 root のときだけ行う
const IS_ROOT = process.getuid?.() === 0;

const tempDir = (): string => mkdtempSync(join(tmpdir(), "pi-sbx-root-"));

test("creates a missing working directory", async () => {
  const dir = tempDir();
  const target = join(dir, "workspace");
  try {
    assert.deepEqual(await prepareRootCwd(target), { ok: true, path: target });
    assert.ok(existsSync(target));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("accepts an existing writable directory", async () => {
  const dir = tempDir();
  const target = join(dir, "workspace");
  try {
    await mkdir(target);
    assert.deepEqual(await prepareRootCwd(target), { ok: true, path: target });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports a file in the way of the working directory", async () => {
  const dir = tempDir();
  const target = join(dir, "workspace");
  try {
    await writeFile(target, "not a directory");
    const result = await prepareRootCwd(target);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.message.includes(target), result.message);
    assert.match(result.message, /PI_SANDBOX_CWD/);
    assert.match(result.message, /PI_APP_CWD/);
    // 生のスタックではなく、パスとエラーコードだけを出す
    assert.match(result.message, /\(E(NOTDIR|EXIST|ISDIR)\)/);
    assert.doesNotMatch(result.message, /Error:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "reports a directory that is not writable",
  { skip: IS_ROOT && "root can write into a read-only directory" },
  async () => {
    const dir = tempDir();
    const target = join(dir, "workspace");
    try {
      await mkdir(target);
      await chmod(target, 0o500);
      const result = await prepareRootCwd(target);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.ok(result.message.includes(target), result.message);
      assert.match(result.message, /\(EACCES\)/);
    } finally {
      await chmod(target, 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  },
);
