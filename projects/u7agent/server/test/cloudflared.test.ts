// 一時共有の起動基盤 (server/src/cloudflared.ts) の解決と起動の契約を検証する。
// 実プロセス・実ネットワークは使わない。偽の spawn と、子のメトリクス (loopback) の偽サーバーで動かす。
// 孤児の掃除は cloudflared-sweep.test.ts、/proc の観測は cloudflared-proc.test.ts で扱う。

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import test from "node:test";
import {
  CLOUDFLARED_IMAGE_DIR,
  CloudflaredLaunchError,
  cloudflaredDevDir,
  cloudflaredStatusLine,
  cloudflaredUnavailableMessage,
  killLiveCloudflared,
  resolveCloudflared,
  type CloudflaredUnavailableReason,
} from "../src/cloudflared";
import { isInsideRoot } from "../src/path-strings";
import { fixedLandlockWriteRoots, landlockWrapperDirs } from "../src/sandbox/landlock";
import { createHarness, isPending, sleep, waitFor, writeExecutable } from "./cloudflared-harness";
import {
  EMPTY_CONFIG_LINE,
  NETWORK_FAILURE_LOG,
  PROVISIONING_REJECTED_LOG,
  QUICK_TUNNEL_CREATED_LOG,
  QUICK_TUNNEL_HOSTNAME,
} from "./fixtures/cloudflared-output";

const installer = await import(new URL("../../scripts/install-cloudflared.mjs", import.meta.url).href);

async function resolveTree() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "u7agent-cloudflared-resolve-")));
  const dirs = {
    binDir: join(base, "bin"),
    writable: join(base, "agent-writable"),
    workspace: join(base, "workspace"),
    store: join(base, "store"),
  };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  const options = (explicit: string | undefined, extra: Record<string, unknown> = {}) => ({
    env: explicit ? { PI_CLOUDFLARED_PATH: explicit } : {},
    sessionStoreDir: dirs.store,
    rootCwd: dirs.workspace,
    platform: "linux" as NodeJS.Platform,
    // 既定の書き込み先には /tmp が入り、テストの置き場もその配下にあるため、差し替える
    writeRoots: [dirs.writable],
    trustedDirs: [] as string[],
    ...extra,
  });
  return { base, ...dirs, options, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function unavailable(reason: CloudflaredUnavailableReason) {
  return { available: false, reason };
}

test("PI_CLOUDFLARED_PATH は最優先で、symlink は実体のパスを返す", async () => {
  const t = await resolveTree();
  try {
    const real = join(t.binDir, "real-cloudflared");
    await writeExecutable(real);
    const link = join(t.binDir, "link");
    await symlink(real, link);
    const imageDir = join(t.base, "image");
    await writeExecutable(join(imageDir, "cloudflared"));

    assert.deepEqual(resolveCloudflared(t.options(link, { trustedDirs: [imageDir] })), {
      available: true,
      binary: real,
      stateDir: join(t.store, "tunnel"),
    });
  } finally {
    await t.cleanup();
  }
});

test("PI_CLOUDFLARED_PATH が使えないときは、既定の置き場へ落とさず利用不可にする", async () => {
  const t = await resolveTree();
  try {
    const imageDir = join(t.base, "image");
    await writeExecutable(join(imageDir, "cloudflared"));
    const notExecutable = join(t.binDir, "plain-file");
    await writeExecutable(notExecutable);
    await chmod(notExecutable, 0o644);

    for (const explicit of [join(t.binDir, "missing"), "cloudflared", "./cloudflared", t.binDir, notExecutable]) {
      assert.deepEqual(
        resolveCloudflared(t.options(explicit, { trustedDirs: [imageDir] })),
        unavailable("binary_missing"),
        explicit,
      );
    }
  } finally {
    await t.cleanup();
  }
});

test("PATH は探さない", async () => {
  const t = await resolveTree();
  try {
    await writeExecutable(join(t.binDir, "cloudflared"));
    const env = { PATH: t.binDir };
    assert.deepEqual(resolveCloudflared({ ...t.options(undefined), env }), unavailable("binary_missing"));
  } finally {
    await t.cleanup();
  }
});

test("既定の置き場は先頭から探し、置き場の外を指す symlink は使わない", async () => {
  const t = await resolveTree();
  try {
    const imageDir = join(t.base, "image");
    const devDir = join(t.base, "dev");
    await mkdir(imageDir, { recursive: true });
    await writeExecutable(join(devDir, "cloudflared"));
    const found = resolveCloudflared(t.options(undefined, { trustedDirs: [imageDir, devDir] }));
    assert.deepEqual(found, {
      available: true,
      binary: join(devDir, "cloudflared"),
      stateDir: join(t.store, "tunnel"),
    });

    await writeExecutable(join(t.binDir, "elsewhere"));
    await rm(join(devDir, "cloudflared"));
    await symlink(join(t.binDir, "elsewhere"), join(devDir, "cloudflared"));
    assert.deepEqual(
      resolveCloudflared(t.options(undefined, { trustedDirs: [imageDir, devDir] })),
      unavailable("binary_missing"),
    );
  } finally {
    await t.cleanup();
  }
});

test("バイナリの実体が書き込み先かワークスペースの root の配下なら利用不可で、symlink で外から入れても実体で判定する", async () => {
  const t = await resolveTree();
  try {
    const inWritable = join(t.writable, "cloudflared");
    const inWorkspace = join(t.workspace, "tools", "cloudflared");
    await writeExecutable(inWritable);
    await writeExecutable(inWorkspace);
    const viaLink = join(t.binDir, "innocent-name");
    await symlink(inWritable, viaLink);

    for (const path of [inWritable, inWorkspace, viaLink]) {
      assert.deepEqual(resolveCloudflared(t.options(path)), unavailable("binary_in_write_root"), path);
    }
  } finally {
    await t.cleanup();
  }
});

test("既定の書き込み先には /tmp が入る", async () => {
  const dir = await mkdtemp("/tmp/u7agent-cloudflared-default-");
  try {
    await writeExecutable(join(dir, "cloudflared"));
    const result = resolveCloudflared({
      env: { PI_CLOUDFLARED_PATH: join(dir, "cloudflared") },
      sessionStoreDir: dir,
      rootCwd: "/nonexistent-workspace",
      home: dir,
    });
    assert.deepEqual(result, unavailable("binary_in_write_root"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("会話ストアが無い構成は利用不可", async () => {
  const t = await resolveTree();
  try {
    const binary = join(t.binDir, "cloudflared");
    await writeExecutable(binary);
    for (const store of [null, undefined, "", join(t.base, "no-such-store")]) {
      assert.deepEqual(
        resolveCloudflared({ ...t.options(binary), sessionStoreDir: store }),
        unavailable("store_missing"),
        String(store),
      );
    }
  } finally {
    await t.cleanup();
  }
});

test("置き場 (tunnel/) とその親の実体が書き込み先かワークスペースの root の配下なら利用不可で、symlink でも実体で判定する", async () => {
  const t = await resolveTree();
  try {
    const binary = join(t.binDir, "cloudflared");
    await writeExecutable(binary);

    const planted = await mkdtemp(join(t.writable, "planted-"));
    await symlink(planted, join(t.store, "tunnel"));
    assert.deepEqual(resolveCloudflared(t.options(binary)), unavailable("store_in_write_root"));
    await rm(join(t.store, "tunnel"));

    const inWorkspace = join(t.workspace, "store");
    const inWritable = join(t.writable, "store");
    for (const store of [inWorkspace, inWritable]) {
      await mkdir(store, { recursive: true });
      assert.deepEqual(
        resolveCloudflared({ ...t.options(binary), sessionStoreDir: store }),
        unavailable("store_in_write_root"),
        store,
      );
    }
  } finally {
    await t.cleanup();
  }
});

test("linux 以外は利用不可。ただし PI_CLOUDFLARED_PATH で指せば使える", async () => {
  const t = await resolveTree();
  try {
    const binary = join(t.binDir, "cloudflared");
    await writeExecutable(binary);
    assert.deepEqual(
      resolveCloudflared({ ...t.options(undefined), platform: "darwin" }),
      unavailable("unsupported_platform"),
    );
    assert.equal(resolveCloudflared({ ...t.options(binary), platform: "darwin" }).available, true);
    // 設定に渡す /dev/null が Unix の前提なので、Windows は指定しても使わない
    assert.deepEqual(
      resolveCloudflared({ ...t.options(binary), platform: "win32" }),
      unavailable("unsupported_platform"),
    );
  } finally {
    await t.cleanup();
  }
});

test("dev の置き場とイメージの置き場は、エージェントの書き込み先の外にあり、エージェントの PATH にも入らない", () => {
  const home = "/home/node";
  const devDir = cloudflaredDevDir(home);
  for (const target of [devDir, CLOUDFLARED_IMAGE_DIR]) {
    for (const root of fixedLandlockWriteRoots(home)) {
      assert.equal(isInsideRoot(root.path, target, sep), false, `${target} in ${root.path}`);
    }
    for (const dir of landlockWrapperDirs(home)) assert.notEqual(target, dir);
  }
});

test("dev の置き場は配布スクリプトの配置先と同じ", () => {
  for (const home of ["/home/node", "/root"]) {
    assert.equal(installer.devCloudflaredInstallDir(home), cloudflaredDevDir(home));
  }
});

test("起動ログの 1 行と利用不可の説明に、パスや生の出力は入らない", () => {
  assert.equal(
    cloudflaredStatusLine({ available: true, binary: "/opt/x/cloudflared", stateDir: "/var/x/tunnel" }),
    "tunnel: available",
  );
  assert.equal(
    cloudflaredStatusLine({ available: false, reason: "binary_in_write_root" }),
    "tunnel: unavailable (binary_in_write_root)",
  );
  const reasons: CloudflaredUnavailableReason[] = [
    "unsupported_platform",
    "binary_missing",
    "binary_in_write_root",
    "store_missing",
    "store_in_write_root",
    "store_unusable",
  ];
  for (const reason of reasons) assert.match(cloudflaredUnavailableMessage(reason), /\S/);
});

test("launch はハンドルをすぐ返し、/ready が 200 になるまで URL を解決しない", async () => {
  const h = await createHarness();
  try {
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: QUICK_TUNNEL_HOSTNAME });
    h.metrics.readyStatus = 503;
    const handle = h.launch();
    assert.equal(h.calls.length, 0, "spawn は launch の中では呼ばない");
    await waitFor(() => h.calls.length === 1, "spawn");

    assert.equal(await isPending(handle.ready), true, "/quicktunnel に URL が出ても、接続が無いうちは待つ");
    h.metrics.readyStatus = 200;
    assert.deepEqual(await handle.ready, { url: `https://${QUICK_TUNNEL_HOSTNAME}` });
  } finally {
    await h.dispose();
  }
});

test("scheme が付いた hostname も https の URL にする", async () => {
  const h = await createHarness();
  try {
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: `https://${QUICK_TUNNEL_HOSTNAME}/` });
    h.metrics.readyStatus = 200;
    assert.deepEqual(await h.launch().ready, { url: `https://${QUICK_TUNNEL_HOSTNAME}` });
  } finally {
    await h.dispose();
  }
});

test("起動の引数と env は固定で、BFF の env は子へ渡らない", async () => {
  const h = await createHarness(
    {},
    {
      PI_SANDBOX_TOKEN: "shared-token",
      ANTHROPIC_API_KEY: "sk-secret",
      U7AGENT_SECRET_MASTER_KEY: "1:master",
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://192.0.2.1:3128",
      SSL_CERT_FILE: "/etc/ssl/certs/ca.pem",
    },
  );
  try {
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: QUICK_TUNNEL_HOSTNAME });
    h.metrics.readyStatus = 200;
    await h.launch(41_234).ready;

    const [call] = h.calls;
    assert.ok(call);
    assert.equal(call.command, h.realBinary);
    assert.deepEqual(call.args, [
      "tunnel",
      "--no-autoupdate",
      "--config",
      "/dev/null",
      "--metrics",
      `127.0.0.1:${call.metricsPort}`,
      "--grace-period",
      "5s",
      "--url",
      "http://127.0.0.1:41234",
    ]);
    assert.ok(call.metricsPort > 0);
    assert.deepEqual(call.env, { HOME: call.cwd, NO_AUTOUPDATE: "true", SSL_CERT_FILE: "/etc/ssl/certs/ca.pem" });
    assert.equal(dirname(call.cwd), h.stateDir, "HOME は会話ストア配下の置き場に作る");
    assert.match(basename(call.cwd), /^home-4317-[0-9a-f]{8}$/);
    assert.equal((await stat(call.cwd)).mode & 0o777, 0o700);
  } finally {
    await h.dispose();
  }
});

test("originPort が不正なら同期で投げ、子は起こさない", async () => {
  const h = await createHarness();
  try {
    for (const originPort of [0, 65_536, 1.5, Number.NaN, -1]) {
      assert.throws(() => h.launcher.launch({ originPort }), RangeError, String(originPort));
    }
    assert.equal(h.calls.length, 0);
  } finally {
    await h.dispose();
  }
});

test("メトリクスから URL が取れないときだけ、起動ログの URL を使う", async () => {
  const h = await createHarness();
  try {
    h.behavior.onSpawn = (call) => call.child.writeLog(QUICK_TUNNEL_CREATED_LOG);
    h.metrics.quickTunnelBody = null;
    h.metrics.readyStatus = 200;
    assert.deepEqual(await h.launch().ready, { url: `https://${QUICK_TUNNEL_HOSTNAME}` });
  } finally {
    await h.dispose();
  }
});

test("メトリクスの hostname が優先され、ログの URL と食い違っても採らない", async () => {
  const h = await createHarness();
  try {
    h.behavior.onSpawn = (call) => call.child.writeLog(QUICK_TUNNEL_CREATED_LOG);
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: "metrics-wins.trycloudflare.com" });
    h.metrics.readyStatus = 200;
    assert.deepEqual(await h.launch().ready, { url: "https://metrics-wins.trycloudflare.com" });
  } finally {
    await h.dispose();
  }
});

test("免責文のリンクや作成 API の URL は、公開 URL として拾わない", async () => {
  const h = await createHarness({ deadlineMs: 250 });
  try {
    h.behavior.onSpawn = (call) => {
      // 作成は失敗していないが、URL の表も出ていない出力。api. と免責文のリンクだけがある
      call.child.writeLog(
        [
          EMPTY_CONFIG_LINE,
          "INF terms: https://www.cloudflare.com/website-terms/ and https://developers.cloudflare.com/cloudflare-one/connections/connect-apps",
          "INF retry: https://api.trycloudflare.com/tunnel",
          "",
        ].join("\n"),
      );
    };
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: "api.trycloudflare.com" });
    h.metrics.readyStatus = 200;
    await assert.rejects(
      h.launch().ready,
      (error: unknown) => error instanceof CloudflaredLaunchError && error.kind === "timeout",
    );
  } finally {
    await h.dispose();
  }
});

test("メトリクスの hostname が trycloudflare.com 以外なら採らない", async () => {
  const h = await createHarness({ deadlineMs: 250 });
  try {
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: "evil.example.com" });
    h.metrics.readyStatus = 200;
    await assert.rejects(
      h.launch().ready,
      (error: unknown) => error instanceof CloudflaredLaunchError && error.kind === "timeout",
    );
  } finally {
    await h.dispose();
  }
});

test("空の設定を読んだ Error 行は失敗にしない", async () => {
  const h = await createHarness();
  try {
    h.behavior.onSpawn = (call) => call.child.writeLog(`${EMPTY_CONFIG_LINE}\n`);
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: QUICK_TUNNEL_HOSTNAME });
    h.metrics.readyStatus = 200;
    assert.deepEqual(await h.launch().ready, { url: `https://${QUICK_TUNNEL_HOSTNAME}` });
  } finally {
    await h.dispose();
  }
});

test("起動の失敗は分類つきで reject し、固定の文言に生の出力を載せない", async () => {
  const cases: Array<{ name: string; log: string; code: number; kind: string }> = [
    { name: "作成の 429", log: PROVISIONING_REJECTED_LOG, code: 1, kind: "rejected" },
    { name: "作成 API へ届かない", log: NETWORK_FAILURE_LOG, code: 1, kind: "network" },
    { name: "未知の文言", log: `${QUICK_TUNNEL_HOSTNAME} something unexpected\n`, code: 2, kind: "exited" },
  ];
  for (const { name, log, code, kind } of cases) {
    const h = await createHarness();
    try {
      h.behavior.onSpawn = (call) => {
        call.child.writeLog(log);
        void call.child.exit(code);
      };
      const handle = h.launch();
      const error = await handle.ready.then(
        () => undefined,
        (reason: unknown) => reason,
      );
      assert.ok(error instanceof CloudflaredLaunchError, name);
      assert.equal(error.kind, kind, name);
      assert.doesNotMatch(
        error.message,
        /trycloudflare|status 429|network is unreachable/,
        `${name}: メッセージは固定`,
      );
      assert.doesNotMatch(
        error.outputTail,
        new RegExp(QUICK_TUNNEL_HOSTNAME.split(".")[0] ?? ""),
        `${name}: 末尾はマスク済み`,
      );
      // 失敗の応答を片付けの待ちで遅らせないため、reject は片付けの完了より先。完了は stop() で待てる
      await handle.stop();
      assert.deepEqual(await readdir(h.stateDir), [], `${name}: 失敗した起動の HOME と記録は残らない`);
    } finally {
      await h.dispose();
    }
  }
});

test("期限内に ready にならなければ、子を止めて timeout にする", async () => {
  const h = await createHarness({ deadlineMs: 250 });
  try {
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: QUICK_TUNNEL_HOSTNAME });
    h.metrics.readyStatus = 503;
    const handle = h.launch();
    await assert.rejects(
      handle.ready,
      (error: unknown) => error instanceof CloudflaredLaunchError && error.kind === "timeout",
    );
    await handle.stop();
    assert.deepEqual(h.calls[0]?.child.signals, ["SIGTERM"]);
    assert.deepEqual(await readdir(h.stateDir), []);
  } finally {
    await h.dispose();
  }
});

test("spawn 自体の失敗とバイナリ無しは unavailable で、後者は子を起こさない", async () => {
  const failing = await createHarness();
  try {
    failing.behavior.spawnError = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    await assert.rejects(
      failing.launch().ready,
      (error: unknown) => error instanceof CloudflaredLaunchError && error.kind === "unavailable",
    );
  } finally {
    await failing.dispose();
  }

  const missing = await createHarness({ env: { PI_CLOUDFLARED_PATH: "/nonexistent/cloudflared" } });
  try {
    const error = await missing.launch().ready.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof CloudflaredLaunchError);
    assert.equal(error.kind, "unavailable");
    assert.equal(error.unavailableReason, "binary_missing");
    assert.equal(missing.calls.length, 0);
  } finally {
    await missing.dispose();
  }
});

test("起動のたびに利用可否を確かめ直し、置き場が書き込み先へ入れ替わっていれば起動しない", async () => {
  const h = await createHarness();
  try {
    await mkdir(h.stateDir, { recursive: true });
    await rm(h.stateDir, { recursive: true });
    const planted = join(h.writableRoot, "planted");
    await mkdir(planted, { recursive: true });
    await symlink(planted, h.stateDir);

    const error = await h.launch().ready.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof CloudflaredLaunchError);
    assert.equal(error.kind, "unavailable");
    assert.equal(error.unavailableReason, "store_in_write_root");
    assert.equal(h.calls.length, 0);
    assert.deepEqual(await readdir(planted), []);
  } finally {
    await h.dispose();
  }
});

test("起動中の stop() は起動を中断し、子と専用 HOME と記録を片付ける", async () => {
  const h = await createHarness();
  try {
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: QUICK_TUNNEL_HOSTNAME });
    h.metrics.readyStatus = 503;
    const handle = h.launch();
    await waitFor(() => h.calls.length === 1, "spawn");
    await waitFor(async () => (await readdir(h.stateDir)).length === 2, "HOME と記録");

    await handle.stop();
    await assert.rejects(
      handle.ready,
      (error: unknown) => error instanceof CloudflaredLaunchError && error.kind === "aborted",
    );
    assert.deepEqual(h.calls[0]?.child.signals, ["SIGTERM"]);
    assert.deepEqual(await readdir(h.stateDir), []);
    assert.equal(await isPending(handle.exited), true, "自分で止めた終了は exited に出さない");
  } finally {
    await h.dispose();
  }
});

test("子を起こす前の stop() は、子を起こさず中断する", async () => {
  const h = await createHarness();
  try {
    const handle = h.launch();
    await handle.stop();
    await assert.rejects(
      handle.ready,
      (error: unknown) => error instanceof CloudflaredLaunchError && error.kind === "aborted",
    );
    assert.equal(h.calls.length, 0);
    assert.deepEqual(await readdir(h.stateDir).catch(() => []), []);
  } finally {
    await h.dispose();
  }
});

test("stop() は SIGTERM のあと猶予で SIGKILL し、何度呼んでも冪等", async () => {
  const h = await createHarness({ stopGraceMs: 80 });
  try {
    h.behavior.ignoreSigterm = true;
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: QUICK_TUNNEL_HOSTNAME });
    h.metrics.readyStatus = 200;
    const handle = h.launch();
    await handle.ready;

    const first = handle.stop();
    const second = handle.stop();
    await Promise.all([first, second]);
    await handle.stop();
    assert.deepEqual(h.calls[0]?.child.signals, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(await readdir(h.stateDir), []);
    assert.equal(await isPending(handle.exited), true);
  } finally {
    await h.dispose();
  }
});

test("子がすでに終わっていれば、stop() は何も送らない", async () => {
  const h = await createHarness();
  try {
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: QUICK_TUNNEL_HOSTNAME });
    h.metrics.readyStatus = 200;
    const handle = h.launch();
    await handle.ready;
    const child = h.calls[0]?.child;
    assert.ok(child);
    await child.exit(1);
    await handle.exited;
    await handle.stop();
    assert.deepEqual(child.signals, []);
  } finally {
    await h.dispose();
  }
});

test("ready の後の予期しない終了は exited で、終了コードとマスク済みの stderr の末尾を通知する", async () => {
  const h = await createHarness();
  try {
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: QUICK_TUNNEL_HOSTNAME });
    h.metrics.readyStatus = 200;
    const handle = h.launch();
    await handle.ready;
    const child = h.calls[0]?.child;
    assert.ok(child);
    child.writeLog(`ERR lost connection to https://${QUICK_TUNNEL_HOSTNAME} (api.trycloudflare.com is fine)\n`);
    await child.exit(1);

    const exit = await handle.exited;
    assert.equal(exit.code, 1);
    assert.equal(exit.signal, null);
    assert.match(exit.stderrTail, /<random>\.trycloudflare\.com/);
    assert.match(exit.stderrTail, /api\.trycloudflare\.com/, "作成 API の名前は診断に要るので残す");
    assert.doesNotMatch(exit.stderrTail, new RegExp(QUICK_TUNNEL_HOSTNAME.split(".")[0] ?? ""));
    await handle.stop();
    assert.deepEqual(await readdir(h.stateDir), [], "終了した子の HOME と記録も消える");
  } finally {
    await h.dispose();
  }
});

test("記録は起動ごとに別で、ファイル名に待受ポートを含み、子の素性を書く", async () => {
  const first = await createHarness();
  const second = await createHarness({ instancePort: 4320 });
  try {
    for (const h of [first, second]) {
      h.metrics.quickTunnelBody = JSON.stringify({ hostname: QUICK_TUNNEL_HOSTNAME });
      h.metrics.readyStatus = 200;
      await h.launch().ready;
    }
    const names = async (h: typeof first) => (await readdir(h.stateDir)).sort();
    const [firstNames, secondNames] = [await names(first), await names(second)];
    assert.match(firstNames[1] ?? "", /^pid-4317-[0-9a-f]{8}\.json$/);
    assert.match(secondNames[1] ?? "", /^pid-4320-[0-9a-f]{8}\.json$/);

    const call = first.calls[0];
    assert.ok(call);
    const record = JSON.parse(await readFile(join(first.stateDir, firstNames[1] ?? ""), "utf8"));
    assert.equal(record.version, 1);
    assert.equal(record.owner.pid, process.pid);
    assert.equal(record.home, basename(call.cwd));
    assert.equal(record.child.pid, call.child.pid);
    assert.equal(record.child.exe, first.realBinary);
    assert.deepEqual(record.child.argv, [call.command, ...call.args]);
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test("killLiveCloudflared は生きている子を即座に殺し、専用 HOME と記録を消す", async () => {
  const h = await createHarness();
  try {
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: QUICK_TUNNEL_HOSTNAME });
    h.metrics.readyStatus = 200;
    const handle = h.launch();
    await handle.ready;
    assert.equal((await readdir(h.stateDir)).length, 2);

    killLiveCloudflared();
    assert.deepEqual(h.calls[0]?.child.signals, ["SIGKILL"]);
    assert.deepEqual(await readdir(h.stateDir), []);
    await handle.stop();
  } finally {
    await h.dispose();
  }
});

test("起動に失敗しても、呼び出し側が ready を待たなければ unhandled rejection にならない", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  const h = await createHarness({ env: { PI_CLOUDFLARED_PATH: "/nonexistent/cloudflared" } });
  try {
    const handle = h.launch();
    await handle.stop();
    await new Promise((done) => setTimeout(done, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await h.dispose();
  }
});

test("共通スキルの root が作業領域の外を指す symlink でも、その実体の配下は書き込み先として扱う", async () => {
  const t = await resolveTree();
  try {
    const elsewhere = join(t.base, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await mkdir(join(t.workspace, ".agents"), { recursive: true });
    await symlink(elsewhere, join(t.workspace, ".agents", "skills"));
    const inside = join(elsewhere, "bin", "cloudflared");
    await writeExecutable(inside);
    const outside = join(t.binDir, "cloudflared");
    await writeExecutable(outside);
    const store = join(elsewhere, "store");
    await mkdir(store);

    assert.deepEqual(resolveCloudflared(t.options(inside)), unavailable("binary_in_write_root"));
    assert.deepEqual(
      resolveCloudflared({ ...t.options(outside), sessionStoreDir: store }),
      unavailable("store_in_write_root"),
    );
    assert.equal(resolveCloudflared(t.options(outside)).available, true, "外にあるものは使える");
  } finally {
    await t.cleanup();
  }
});

test("置き場 (tunnel/) がディレクトリでない・外を指す symlink なら、利用可と言わない", async () => {
  const t = await resolveTree();
  try {
    const binary = join(t.binDir, "cloudflared");
    await writeExecutable(binary);

    await writeFile(join(t.store, "tunnel"), "not a directory");
    assert.deepEqual(resolveCloudflared(t.options(binary)), unavailable("store_unusable"));
    await rm(join(t.store, "tunnel"));

    // 書き込み先ではない別の場所へ出る symlink。chmod と掃除が、置き場の外へ及ぶ
    const elsewhere = join(t.base, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(t.store, "tunnel"));
    assert.deepEqual(resolveCloudflared(t.options(binary)), unavailable("store_unusable"));
  } finally {
    await t.cleanup();
  }
});

/** 子のメトリクスの応答を保留する (応答を待っている間に起きる停止・終了・期限を試す) */
function holdResponses(h: Awaited<ReturnType<typeof createHarness>>): () => void {
  let release: () => void = () => {};
  h.metrics.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.metrics.quickTunnelBody = JSON.stringify({ hostname: QUICK_TUNNEL_HOSTNAME });
  h.metrics.readyStatus = 200;
  return release;
}

test("応答を待っている間に stop() しても、ready は成功にならない", async () => {
  const h = await createHarness();
  try {
    const release = holdResponses(h);
    const handle = h.launch();
    await waitFor(() => h.calls.length === 1, "spawn");
    await sleep(60);
    const stopping = handle.stop();
    release();
    await assert.rejects(
      handle.ready,
      (error: unknown) => error instanceof CloudflaredLaunchError && error.kind === "aborted",
    );
    await stopping;
  } finally {
    await h.dispose();
  }
});

test("応答を待っている間に子が終わっても、ready は成功にならない", async () => {
  const h = await createHarness();
  try {
    const release = holdResponses(h);
    const handle = h.launch();
    await waitFor(() => h.calls.length === 1, "spawn");
    await sleep(60);
    await h.calls[0]?.child.exit(1);
    release();
    await assert.rejects(
      handle.ready,
      (error: unknown) => error instanceof CloudflaredLaunchError && error.kind === "exited",
    );
  } finally {
    await h.dispose();
  }
});

test("応答を待っている間に期限を過ぎたら、応答を待たずに timeout にする", async () => {
  const h = await createHarness({ deadlineMs: 150 });
  try {
    const release = holdResponses(h);
    const handle = h.launch();
    const settled = await Promise.race([
      handle.ready.then(
        () => "resolved",
        (error: unknown) => (error instanceof CloudflaredLaunchError ? error.kind : "other"),
      ),
      sleep(1000).then(() => "still waiting"),
    ]);
    assert.equal(settled, "timeout", "保留された応答の解放を待たない");
    release();
  } finally {
    await h.dispose();
  }
});

test("待受が子のものと確かめられないうちは、応答があっても ready にしない", async () => {
  const h = await createHarness();
  try {
    h.behavior.listenerOwner = "no";
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: "someone-else.trycloudflare.com" });
    h.metrics.readyStatus = 200;
    const handle = h.launch();
    await waitFor(() => h.calls.length === 1, "spawn");
    assert.equal(await isPending(handle.ready, 200), true, "別のプロセスの待受の応答を採らない");

    h.behavior.listenerOwner = "yes";
    assert.deepEqual(await handle.ready, { url: "https://someone-else.trycloudflare.com" });
  } finally {
    await h.dispose();
  }
});

test("待受の所有を確かめられない環境 (/proc が無い) では、応答をそのまま採る", async () => {
  const h = await createHarness();
  try {
    h.behavior.listenerOwner = "unknown";
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: QUICK_TUNNEL_HOSTNAME });
    h.metrics.readyStatus = 200;
    assert.deepEqual(await h.launch().ready, { url: `https://${QUICK_TUNNEL_HOSTNAME}` });
  } finally {
    await h.dispose();
  }
});

test("/quicktunnel が 200 でない応答は、本文が正しくても採らない", async () => {
  const h = await createHarness({ deadlineMs: 250 });
  try {
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: QUICK_TUNNEL_HOSTNAME });
    h.metrics.quickTunnelStatus = 404;
    h.metrics.readyStatus = 200;
    await assert.rejects(
      h.launch().ready,
      (error: unknown) => error instanceof CloudflaredLaunchError && error.kind === "timeout",
    );
  } finally {
    await h.dispose();
  }
});

test("子を止められなかったときは、記録と専用 HOME を残し、子が終わったときに消す", async () => {
  const h = await createHarness({ stopGraceMs: 40, killWaitMs: 40 });
  try {
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: QUICK_TUNNEL_HOSTNAME });
    h.metrics.readyStatus = 200;
    const handle = h.launch();
    await handle.ready;
    const child = h.calls[0]?.child;
    assert.ok(child);

    h.behavior.killDenied = true;
    await handle.stop();
    assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal((await readdir(h.stateDir)).length, 2, "止められなかった子の記録は、次の掃除のために残す");

    killLiveCloudflared();
    assert.equal((await readdir(h.stateDir)).length, 2, "終了時の最終手段も、送れなかった子の記録は消さない");

    await child.exit(0);
    await waitFor(async () => (await readdir(h.stateDir)).length === 0, "子が終わったあとの片付け");
  } finally {
    await h.dispose();
  }
});

test("子の close の通知の最中に stop() を呼んでも、exited は通知しない", async () => {
  const h = await createHarness();
  try {
    h.metrics.quickTunnelBody = JSON.stringify({ hostname: QUICK_TUNNEL_HOSTNAME });
    h.metrics.readyStatus = 200;
    const handle = h.launch();
    await handle.ready;
    const child = h.calls[0]?.child;
    assert.ok(child);

    // 本体の close の処理のあとに、利用者の停止が同じ通知の中で入る
    child.once("close", () => void handle.stop());
    await child.exit(1);
    await handle.stop();
    assert.equal(await isPending(handle.exited), true);
  } finally {
    await h.dispose();
  }
});
