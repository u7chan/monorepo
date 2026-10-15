// scripts/install-landlock.mjs の契約を検証する。
// dev の入口は python の実体を shebang に焼き込めない (空白で kernel が分割し、長さでも切り捨てられる) ため、
// 生成した入口を実際に shell で実行し、本体・引数・stdout・終了コードがどう渡るかを観測する。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LANDLOCK_WRAPPER_NAME } from "../src/sandbox/landlock";

const installer = await import(new URL("../../scripts/install-landlock.mjs", import.meta.url).href);
const installerPath = fileURLToPath(new URL("../../scripts/install-landlock.mjs", import.meta.url));
const source = new URL("../../scripts/landlock-exec.py", import.meta.url);

type Installed = { path: string; script: string; python: string | undefined };

/** 実行された argv を record へ書き、stdout と終了コードを指定できる python の stub */
async function writePythonStub({
  path,
  record,
  stdout = "",
  exitCode = 0,
}: {
  path: string;
  record: string;
  stdout?: string;
  exitCode?: number;
}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `#!/bin/sh
{ for arg in "$@"; do printf 'arg\\t%s\\n' "$arg"; done } > '${record}'
printf '%s\\n' '${stdout}'
exit ${exitCode}
`,
    { mode: 0o755 },
  );
}

async function recordedArgs(record: string): Promise<string[]> {
  return (await readFile(record, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(4));
}

test("入口と本体は探索側の名前で置き、本体はリポジトリの実体と同一", async () => {
  const base = await mkdtemp(join(tmpdir(), "u7agent-landlock-"));
  try {
    const dest = join(base, "install dir's");
    const python = join(base, "py dir's", "python3");
    const installed: Installed = await installer.installLandlockWrapper({ dest, python, log: () => {} });

    assert.equal(basename(installed.path), LANDLOCK_WRAPPER_NAME);
    assert.equal(installed.path, join(dest, LANDLOCK_WRAPPER_NAME));
    assert.equal(installed.script, join(dest, installer.LANDLOCK_SCRIPT_NAME));
    assert.equal(installed.python, python);
    assert.equal(await readFile(installed.script, "utf8"), await readFile(source, "utf8"));
    assert.ok((await stat(installed.path)).mode & 0o111, "入口には実行ビットが立っている");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("入口は特殊文字を含む実体から本体を呼び、引数と stdout をそのまま渡す", async () => {
  const base = await mkdtemp(join(tmpdir(), "u7agent-landlock-"));
  try {
    const python = join(base, "py dir's", "python3");
    const record = join(base, "record");
    await writePythonStub({ path: python, record, stdout: "123" });
    const installed: Installed = await installer.installLandlockWrapper({
      dest: join(base, "install dir's"),
      python,
      log: () => {},
    });

    const result = spawnSync(installed.path, ["-c", "echo hi"], { encoding: "utf8" });
    assert.equal(result.status, 0, `入口が失敗しました: ${result.stderr}`);
    assert.deepEqual(await recordedArgs(record), [installed.script, "-c", "echo hi"]);
    assert.equal(result.stdout, "123\n", "--abi の診断は stdout をそのまま読む");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("入口は本体の終了コードをそのまま返す", async () => {
  const base = await mkdtemp(join(tmpdir(), "u7agent-landlock-"));
  try {
    const python = join(base, "python3");
    await writePythonStub({ path: python, record: join(base, "record"), exitCode: 7 });
    const installed: Installed = await installer.installLandlockWrapper({
      dest: join(base, "dest"),
      python,
      log: () => {},
    });

    const result = spawnSync(installed.path, ["--abi"], { encoding: "utf8" });
    assert.equal(result.status, 7, "利用可否の判定に使う終了コードを潰さない");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("python3 の無い PATH で置いた入口は、実行時に PATH 上の python3 を使う", async () => {
  const base = await mkdtemp(join(tmpdir(), "u7agent-landlock-"));
  try {
    const home = join(base, "home dir");
    const emptyBin = join(base, "empty bin");
    const bin = join(base, "bin");
    const record = join(base, "record");
    await writePythonStub({ path: join(bin, "python3"), record });
    await mkdir(emptyBin, { recursive: true });

    // 単体実行 (`node scripts/install-landlock.mjs`)。probe は PATH に python3 が無い状態で走る
    const cli = spawnSync(process.execPath, [installerPath], {
      encoding: "utf8",
      env: { HOME: home, PATH: emptyBin },
    });
    assert.equal(cli.status, 0, `配置に失敗しました: ${cli.stderr}`);

    const wrapper = join(installer.devLandlockInstallDir(home), LANDLOCK_WRAPPER_NAME);
    const result = spawnSync(wrapper, ["--abi"], { encoding: "utf8", env: { PATH: `${bin}:${emptyBin}` } });
    assert.equal(result.status, 0, `入口が失敗しました: ${result.stderr}`);
    assert.deepEqual(await recordedArgs(record), [join(dirname(wrapper), installer.LANDLOCK_SCRIPT_NAME), "--abi"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
