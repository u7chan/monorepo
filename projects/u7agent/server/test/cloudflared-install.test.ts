// scripts/install-cloudflared.mjs の契約を検証する。実ネットワークも実プロセスも使わず、fetch・sha256 の表・
// バージョン確認を差し替える。取得した実体の sha256 を固定値と照合することが信頼の境界なので、不一致のとき
// 何も配置しないことを主に見る。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { processStartedAtMs } from "../src/proc-stat";

const installer = await import(new URL("../../scripts/install-cloudflared.mjs", import.meta.url).href);

const VERSION: string = installer.CLOUDFLARED_VERSION;
const BINARY = `#!/bin/sh\necho "cloudflared version ${VERSION} (built test)"\n`;
const digest = (content: string): string => createHash("sha256").update(content).digest("hex");
const CHECKSUMS = { x64: digest(BINARY), arm64: digest(BINARY) };
/** 実際の `--version` の代役。実プロセスを起こさず、置いた中身から判定する */
const verifyVersion = async (path: string): Promise<string> => {
  const text = await readFile(path, "utf8").catch(() => "");
  return text === BINARY ? `cloudflared version ${VERSION} (built test)` : "";
};

function stubFetch(body: string, status = 200) {
  const urls: string[] = [];
  const fetchImpl = async (url: string) => {
    urls.push(url);
    return new Response(status === 200 ? body : "", { status });
  };
  return { urls, fetchImpl };
}

async function withDest(run: (dest: string, base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "u7agent-cloudflared-install-"));
  try {
    await run(join(base, "libexec"), base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

/** テストの置き場は /tmp 配下なので、固定の書き込み先を外して「書けない場所」として扱う */
const base = (dest: string) => ({
  dest,
  arch: "x64" as const,
  platform: "linux" as const,
  checksums: CHECKSUMS,
  verifyVersion,
  writeRoots: [] as string[],
});

test("固定した版の asset を取得し、sha256 が合えば実行できる形で配置する", async () => {
  await withDest(async (dest) => {
    for (const [arch, asset] of [
      ["x64", "cloudflared-linux-amd64"],
      ["arm64", "cloudflared-linux-arm64"],
    ] as const) {
      const { urls, fetchImpl } = stubFetch(BINARY);
      const result = await installer.installCloudflared({ ...base(dest), fetchImpl, arch });
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
    await assert.rejects(installer.installCloudflared({ ...base(dest), fetchImpl }), /sha256 mismatch/);
    assert.deepEqual(await readdir(dest).catch(() => []), []);
  });
});

test("同じ版が配置済みなら取り直さず、中身が違えば取り直す", async () => {
  await withDest(async (dest) => {
    const first = stubFetch(BINARY);
    await installer.installCloudflared({ ...base(dest), fetchImpl: first.fetchImpl });

    const second = stubFetch(BINARY);
    const again = await installer.installCloudflared({ ...base(dest), fetchImpl: second.fetchImpl });
    assert.equal(again.installed, false);
    assert.deepEqual(second.urls, []);

    await writeFile(join(dest, "cloudflared"), "#!/bin/sh\necho replaced\n", { mode: 0o755 });
    const third = stubFetch(BINARY);
    const repaired = await installer.installCloudflared({ ...base(dest), fetchImpl: third.fetchImpl });
    assert.equal(repaired.installed, true);
    assert.equal(third.urls.length, 1);
    assert.equal(await readFile(join(dest, "cloudflared"), "utf8"), BINARY);
  });
});

test("取得の失敗・linux 以外・未対応のアーキテクチャ・配置先なしは、明示のエラーにする", async () => {
  await withDest(async (dest) => {
    await assert.rejects(
      installer.installCloudflared({ ...base(dest), fetchImpl: stubFetch("", 404).fetchImpl }),
      /HTTP 404/,
    );
    await assert.rejects(installer.installCloudflared({ ...base(dest), platform: "darwin" }), /unsupported platform/);
    await assert.rejects(installer.installCloudflared({ ...base(dest), arch: "ia32" }), /unsupported architecture/);
    await assert.rejects(installer.installCloudflared({ ...base(dest), dest: undefined }), /配置先/);
    assert.deepEqual(await readdir(dest).catch(() => []), []);
  });
});

test("固定の版と合わない既存の実体は、取り直しに失敗したら外し、既定の探索先に残さない", async () => {
  await withDest(async (dest) => {
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "cloudflared"), "#!/bin/sh\necho an older build\n", { mode: 0o755 });

    await assert.rejects(
      installer.installCloudflared({ ...base(dest), fetchImpl: stubFetch("", 503).fetchImpl }),
      /HTTP 503/,
    );
    assert.deepEqual(await readdir(dest), [], "検証に落ちた実体を、BFF が選べないようにする");
  });
});

test("動かない実体は、sha256 が合っていても公開しない", async () => {
  await withDest(async (dest) => {
    const broken = "#!/bin/sh\nexit 1\n";
    await assert.rejects(
      installer.installCloudflared({
        ...base(dest),
        fetchImpl: stubFetch(broken).fetchImpl,
        checksums: { x64: digest(broken), arm64: digest(broken) },
      }),
      /not runnable/,
    );
    assert.deepEqual(await readdir(dest), [], "探索先にも、書き込み途中の実体にも残らない");
  });
});

test("配置先がエージェントの書き込める場所なら、検証も取得もしない", async () => {
  await withDest(async (dest, root) => {
    const fetch = stubFetch(BINARY);
    await assert.rejects(
      installer.installCloudflared({ ...base(dest), fetchImpl: fetch.fetchImpl, writeRoots: [root] }),
      /エージェントの書き込める場所/,
    );
    assert.deepEqual(fetch.urls, []);
    assert.deepEqual(await readdir(dest).catch(() => []), []);
  });
});

test("配置先が書き込み先への symlink でも、実体で判定して拒否する", async () => {
  await withDest(async (dest, root) => {
    const writable = join(root, "writable");
    await mkdir(writable);
    await symlink(writable, dest);
    const fetch = stubFetch(BINARY);
    await assert.rejects(
      installer.installCloudflared({ ...base(dest), fetchImpl: fetch.fetchImpl, writeRoots: [writable] }),
      /エージェントの書き込める場所/,
    );
    assert.deepEqual(fetch.urls, []);
    assert.deepEqual(await readdir(writable), []);
  });
});

test("取得中に書き込み root の実体が配置先を含むよう変わったら、検証も公開もしない", async () => {
  await withDest(async (dest, root) => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    let verified = 0;
    const fetchImpl = async () => {
      await rm(workspace, { recursive: true, force: true });
      await symlink(root, workspace);
      return new Response(BINARY, { status: 200 });
    };
    await assert.rejects(
      installer.installCloudflared({
        ...base(dest),
        rootCwd: workspace,
        fetchImpl,
        verifyVersion: async () => {
          verified += 1;
          return `cloudflared version ${VERSION}`;
        },
      }),
      /エージェントの書き込める場所/,
    );
    assert.equal(verified, 0, "古い root の一覧で実行しない");
    assert.deepEqual(await readdir(dest), [], "一時ファイルも残さない");
  });
});

test("ロックの持ち主が生きているあいだは待ち、持ち主が居なければ外して取る", async () => {
  await withDest(async (dest) => {
    await mkdir(dest, { recursive: true });
    const lock = join(dest, ".install.lock");
    const mine = { pid: process.pid, startedAtMs: (await processStartedAtMs(process.pid)) ?? 0 };
    await writeFile(lock, JSON.stringify(mine));
    const waiting = stubFetch(BINARY);
    await assert.rejects(
      installer.installCloudflared({
        ...base(dest),
        fetchImpl: waiting.fetchImpl,
        lockWaitMs: 100,
        lockPollMs: 10,
      }),
      /ロックを取れません/,
    );
    assert.deepEqual(waiting.urls, [], "持ち主が生きているあいだは取得しない");

    await writeFile(lock, JSON.stringify({ pid: 2 ** 22, startedAtMs: 1 }));
    const taking = stubFetch(BINARY);
    const result = await installer.installCloudflared({
      ...base(dest),
      fetchImpl: taking.fetchImpl,
      lockWaitMs: 1000,
      lockPollMs: 10,
    });
    assert.equal(result.installed, true, "持ち主が居なければ外して取る");
    assert.deepEqual(await readdir(dest), ["cloudflared"]);
  });
});

test("並行して配置しても、検証と公開は重ならず、片方の失敗がもう片方の公開を消さない", async () => {
  await withDest(async (dest) => {
    let active = 0;
    let maxActive = 0;
    let arrived = 0;
    let releaseBoth: () => void = () => {};
    const both = new Promise<void>((resolveBoth) => {
      releaseBoth = resolveBoth;
    });
    const tracked = (body: string, status: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      arrived += 1;
      if (arrived === 2) releaseBoth();
      // ロックが無ければ 2 本がここで重なる。ロックがあれば 1 本目だけが待つ
      await Promise.race([both, new Promise((done) => setTimeout(done, 200))]);
      active -= 1;
      return new Response(status === 200 ? body : "", { status });
    };

    const results = await Promise.allSettled([
      installer.installCloudflared({ ...base(dest), fetchImpl: tracked("", 503) }),
      installer.installCloudflared({ ...base(dest), fetchImpl: tracked(BINARY, 200) }),
    ]);
    assert.ok(results.some((result) => result.status === "fulfilled"));
    assert.equal(maxActive, 1, "検証と公開を直列にする");
    assert.equal(await readFile(join(dest, "cloudflared"), "utf8"), BINARY, "成功した側の公開を残す");
    assert.deepEqual(await readdir(dest), ["cloudflared"], "ロックを残さない");
  });
});

test("固定する sha256 は linux の amd64 / arm64 の 2 つで、版は日付形式", () => {
  assert.deepEqual(Object.keys(installer.CLOUDFLARED_SHA256).sort(), ["arm64", "x64"]);
  for (const sha of Object.values<string>(installer.CLOUDFLARED_SHA256)) assert.match(sha, /^[0-9a-f]{64}$/);
  assert.match(VERSION, /^\d{4}\.\d{1,2}\.\d+$/);
});
