// scripts/install-cloudflared.mjs の契約を検証する。実ネットワークは使わず、fetch と sha256 の表を差し替える。
// 取得した実体の sha256 を固定値と照合することが信頼の境界なので、不一致のとき何も配置しないことを主に見る。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const installer = await import(new URL("../../scripts/install-cloudflared.mjs", import.meta.url).href);

const VERSION: string = installer.CLOUDFLARED_VERSION;
const BINARY = `#!/bin/sh\necho "cloudflared version ${VERSION} (built test)"\n`;
const digest = (content: string): string => createHash("sha256").update(content).digest("hex");
const CHECKSUMS = { x64: digest(BINARY), arm64: digest(BINARY) };

function stubFetch(body: string, status = 200) {
  const urls: string[] = [];
  const fetchImpl = async (url: string) => {
    urls.push(url);
    return new Response(status === 200 ? body : "", { status });
  };
  return { urls, fetchImpl };
}

async function withDest(run: (dest: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "u7agent-cloudflared-install-"));
  try {
    await run(join(base, "libexec"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test("固定した版の asset を取得し、sha256 が合えば実行できる形で配置する", async () => {
  await withDest(async (dest) => {
    for (const [arch, asset] of [
      ["x64", "cloudflared-linux-amd64"],
      ["arm64", "cloudflared-linux-arm64"],
    ] as const) {
      const { urls, fetchImpl } = stubFetch(BINARY);
      const result = await installer.installCloudflared({
        dest,
        fetchImpl,
        arch,
        platform: "linux",
        checksums: CHECKSUMS,
      });
      assert.deepEqual(urls, [`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${asset}`]);
      assert.deepEqual(result, { path: join(dest, "cloudflared"), installed: true });
      assert.equal((await stat(result.path)).mode & 0o777, 0o755);
      assert.equal(await readFile(result.path, "utf8"), BINARY);
      assert.deepEqual(await readdir(dest), ["cloudflared"], "書き込み途中の実体を残さない");
      await rm(dest, { recursive: true });
    }
  });
});

test("sha256 が合わなければ何も配置しない", async () => {
  await withDest(async (dest) => {
    const { fetchImpl } = stubFetch(`${BINARY}# tampered\n`);
    await assert.rejects(
      installer.installCloudflared({ dest, fetchImpl, arch: "x64", platform: "linux", checksums: CHECKSUMS }),
      /sha256 mismatch/,
    );
    assert.deepEqual(await readdir(dest).catch(() => []), []);
  });
});

test("同じ版が配置済みなら取り直さず、中身が違えば取り直す", async () => {
  await withDest(async (dest) => {
    const options = { dest, arch: "x64", platform: "linux", checksums: CHECKSUMS };
    const first = stubFetch(BINARY);
    await installer.installCloudflared({ ...options, fetchImpl: first.fetchImpl });

    const second = stubFetch(BINARY);
    const again = await installer.installCloudflared({ ...options, fetchImpl: second.fetchImpl });
    assert.equal(again.installed, false);
    assert.deepEqual(second.urls, []);

    await writeFile(join(dest, "cloudflared"), "#!/bin/sh\necho replaced\n", { mode: 0o755 });
    const third = stubFetch(BINARY);
    const repaired = await installer.installCloudflared({ ...options, fetchImpl: third.fetchImpl });
    assert.equal(repaired.installed, true);
    assert.equal(third.urls.length, 1);
    assert.equal(await readFile(join(dest, "cloudflared"), "utf8"), BINARY);
  });
});

test("取得の失敗・linux 以外・未対応のアーキテクチャ・配置先なしは、明示のエラーにする", async () => {
  await withDest(async (dest) => {
    const base = { dest, arch: "x64", platform: "linux", checksums: CHECKSUMS };
    await assert.rejects(
      installer.installCloudflared({ ...base, fetchImpl: stubFetch("", 404).fetchImpl }),
      /HTTP 404/,
    );
    await assert.rejects(installer.installCloudflared({ ...base, platform: "darwin" }), /unsupported platform/);
    await assert.rejects(installer.installCloudflared({ ...base, arch: "ia32" }), /unsupported architecture/);
    await assert.rejects(installer.installCloudflared({ ...base, dest: undefined }), /配置先/);
    assert.deepEqual(await readdir(dest).catch(() => []), []);
  });
});

test("固定する sha256 は linux の amd64 / arm64 の 2 つで、版は日付形式", () => {
  assert.deepEqual(Object.keys(installer.CLOUDFLARED_SHA256).sort(), ["arm64", "x64"]);
  for (const sha of Object.values<string>(installer.CLOUDFLARED_SHA256)) assert.match(sha, /^[0-9a-f]{64}$/);
  assert.match(VERSION, /^\d{4}\.\d{1,2}\.\d+$/);
});
