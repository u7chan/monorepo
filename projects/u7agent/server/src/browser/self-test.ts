/**
 * `--self-test` の本体。1 回の起動で次を確かめる。
 * - data: URL の DOM と PNG 生成
 * - ループバックの HTTP / WS の成功
 * - ループバック以外 (直接 / ループバックからの 302) の拒否
 * 302 は route が redirect 先で呼ばれない経路の検査に使う。route を外した状態でも拒否できることまで見る
 * (proxy と `<-loopback>` が実際の境界であるため)。PNG は呼び出しの一時領域へ出して消す。
 */
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { startLoopbackFixture } from "./fixture";
import { MAX_IMAGE_BYTES } from "./limits";
import type { BrowserSession } from "./session";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_URL = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!doctype html><html lang="ja"><body><div id="probe">data-url-ok</div></body></html>',
)}`;

/** 拒否を期待する宛先。RFC 5737 のドキュメント用アドレスと、link-local (メタデータサービス) を使う */
const EXTERNAL_HOST = "http://example.com/";
const EXTERNAL_IP = "http://192.0.2.1/";
const LINK_LOCAL = "http://169.254.169.254/";

/** 拒否を期待する通信の待ち時間。壊れていてもここで打ち切り、失敗として扱う */
const DENY_TIMEOUT_MS = 5000;

export interface SelfTestOptions {
  denyTimeoutMs?: number;
}

/** 到達できたかを返す。拒否はエラーでも timeout でも成立する */
async function reachable(page: Page, url: string, timeoutMs: number): Promise<boolean> {
  return page.goto(url, { timeout: timeoutMs }).then(
    () => true,
    () => false,
  );
}

async function evaluateWebSocket(page: Page, url: string, timeoutMs: number): Promise<string> {
  return page.evaluate(`new Promise((resolve) => {
    const socket = new WebSocket(${JSON.stringify(url)});
    socket.onopen = () => socket.send("ping");
    socket.onmessage = () => resolve("echoed");
    socket.onerror = () => resolve("error");
    socket.onclose = () => resolve("closed");
    setTimeout(() => resolve("timeout"), ${Number(timeoutMs)});
  })`);
}

/**
 * WebSocket を開いて echo を待つ。結果は "echoed" / "error" / "closed" / "timeout"。
 * 文字列で渡すのは、tsx の esbuild 変換が関数の名前保持のために注入するヘルパーが page 側に無いため。
 * 拒否された遷移の直後は Chromium が文書を差し替えている途中のことがあり、`evaluate` が「実行コンテキストが
 * 破棄された」で落ちる。判定は echo が返らないことなので、落ち着いてから 1 回だけ試し直す。
 */
export async function webSocketOutcome(page: Page, url: string, timeoutMs: number): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await evaluateWebSocket(page, url, timeoutMs);
    } catch (error) {
      const destroyed = (error as Error).message.includes("Execution context was destroyed");
      if (!destroyed || attempt > 0) throw error;
      await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => undefined);
    }
  }
}

function deniedTargets(session: BrowserSession, host: string): string[] {
  return session.denials.filter((target) => target.includes(host));
}

export async function runSelfTest(session: BrowserSession, options: SelfTestOptions = {}): Promise<string[]> {
  const denyTimeoutMs = options.denyTimeoutMs ?? DENY_TIMEOUT_MS;
  const checks: string[] = [];
  const fixture = await startLoopbackFixture({
    redirects: {
      "/redirect/external-host": EXTERNAL_HOST,
      "/redirect/external-ip": EXTERNAL_IP,
      "/redirect/link-local": LINK_LOCAL,
    },
  });
  try {
    const { page } = session;

    await page.goto(DATA_URL, { timeout: denyTimeoutMs });
    assert.equal(await page.locator("#probe").textContent(), "data-url-ok");
    checks.push("data: URL の DOM");

    const image = await page.screenshot();
    assert.ok(image.length > PNG_SIGNATURE.length, "PNG が空です");
    assert.ok(image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), "PNG の署名ではありません");
    assert.ok(image.length <= MAX_IMAGE_BYTES, `PNG が上限 (${MAX_IMAGE_BYTES} bytes) を超えています`);
    const imagePath = join(session.dirs.tmp, "self-test.png");
    await writeFile(imagePath, image);
    await rm(imagePath);
    checks.push(`PNG 生成 (${image.length} bytes)`);

    const response = await page.goto(fixture.origin, { timeout: denyTimeoutMs });
    assert.equal(response?.status(), 200);
    assert.equal(await page.locator("#probe").textContent(), "loopback-ok");
    checks.push("ループバックの HTTP");

    assert.equal(await webSocketOutcome(page, fixture.wsUrl, denyTimeoutMs), "echoed");
    checks.push("ループバックの WS");

    assert.equal(await reachable(page, EXTERNAL_IP, denyTimeoutMs), false, `${EXTERNAL_IP} へ到達できました`);
    assert.equal(
      await reachable(page, fixture.redirect("/redirect/link-local"), denyTimeoutMs),
      false,
      "link-local へ到達できました",
    );
    checks.push("ループバック以外と 302 先の拒否");

    assert.notEqual(await webSocketOutcome(page, "ws://192.0.2.1/ws", denyTimeoutMs), "echoed");
    checks.push("ループバック以外の WS の拒否");

    await session.context.unroute("**");
    for (const [path, target] of [
      ["/redirect/external-host", EXTERNAL_HOST],
      ["/redirect/external-ip", EXTERNAL_IP],
      ["/redirect/link-local", LINK_LOCAL],
    ] as const) {
      const host = new URL(target).host;
      const before = deniedTargets(session, host).length;
      // proxy の拒否は 403 の応答として返る (ブラウザはそれを描画するので goto は失敗しない)
      const response = await page.goto(fixture.redirect(path), { timeout: denyTimeoutMs }).catch(() => undefined);
      assert.equal(response?.status(), 403, `${target} の拒否応答がありません`);
      assert.ok(deniedTargets(session, host).length > before, `proxy を経由せず ${target} へ出ようとしました`);
    }
    checks.push("route 無しでも 302 先は proxy が拒否");
  } finally {
    await fixture.close();
  }
  return checks;
}
