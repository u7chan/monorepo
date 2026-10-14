/**
 * single-shot のブラウザ起動。呼び出しごとに一時領域・deny-all proxy・ブラウザを持ち、
 * 呼び出しをまたいで状態を持たない。終了処理は正常 / 例外 / 期限超過のどれでも同じ経路を通る。
 * 例外で終わる場合も起動の途中で後始末してから投げ、残骸を次の呼び出しへ残さない。
 */
import { rm } from "node:fs/promises";
// Playwright はモジュールの読み込み時に同梱先を確定するため、playwright-core より先に読む (import の順序が効く)
import "./environment";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { acquireConcurrencySlot, type ConcurrencySlot } from "./concurrency";
import { CALL_DEADLINE_MS, VIEWPORT } from "./limits";
import { browserArguments, installReachPolicy } from "./policy";
import { startDenyAllProxy, type DenyAllProxy } from "./proxy";
import { cleanupStaleCallDirs, createCallDirs, type CallDirs } from "./temp";

export class CallDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(`期限 (${deadlineMs} ms) を超えたため中断しました`);
    this.name = "CallDeadlineError";
  }
}

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  dirs: CallDirs;
  /** proxy が拒否した宛先。proxy を経由して拒否されたことを確かめるために見る */
  readonly denials: readonly string[];
  readonly timedOut: boolean;
  close(): Promise<void>;
}

export interface OpenBrowserSessionOptions {
  deadlineMs?: number;
  viewport?: { width: number; height: number };
  log?: (message: string) => void;
}

/**
 * 起動から終了までを 1 つの関数に閉じる。期限は起動中の処理も覆い、超過したら起動の完了を待ってから閉じる
 * (起動中に閉じるとブラウザが孤児になり、削除済みの一時領域を掴み続ける)。
 */
export async function openBrowserSession(options: OpenBrowserSessionOptions = {}): Promise<BrowserSession> {
  const deadlineMs = options.deadlineMs ?? CALL_DEADLINE_MS;
  const log = options.log ?? (() => {});
  const viewport = options.viewport ?? VIEWPORT;

  const denials: string[] = [];
  let dirs: CallDirs | undefined;
  let slot: ConcurrencySlot | undefined;
  let proxy: DenyAllProxy | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let launching: Promise<Browser> | undefined;
  let timedOut = false;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    const failures: unknown[] = [];
    await (launching ?? Promise.resolve()).catch(() => undefined);
    if (context) await context.close().catch((error: unknown) => failures.push(error));
    if (browser) await browser.close().catch((error: unknown) => failures.push(error));
    if (proxy) await proxy.close().catch((error: unknown) => failures.push(error));
    if (dirs) await rm(dirs.root, { recursive: true, force: true }).catch((error: unknown) => failures.push(error));
    if (slot) await slot.release().catch((error: unknown) => failures.push(error));
    for (const failure of failures) log(`後始末に失敗しました: ${(failure as Error).message}`);
  };

  try {
    // 自分の起動時刻を読めない (/proc が無い) ときに、掃除で他人の領域を消さないよう自分の領域を先に作る
    dirs = await createCallDirs();
    // Playwright は profile を os.tmpdir() 配下へ作るため、起動前に TMPDIR を差し替える
    process.env.HOME = dirs.home;
    process.env.TMPDIR = dirs.tmp;
    const stale = await cleanupStaleCallDirs({ log });
    if (stale.length > 0) log(`終了済みの一時領域を回収しました (${stale.length} 件)`);
    // 上限に達していたらブラウザを起動せずに落とす (資源の入場制御)
    slot = await acquireConcurrencySlot({ log });
    proxy = await startDenyAllProxy({ onDeny: (target) => denials.push(target) });
    timer = setTimeout(() => {
      timedOut = true;
      log(`期限 (${deadlineMs} ms) を超えたため中断します`);
      void shutdown();
    }, deadlineMs);
    timer.unref();

    launching = chromium.launch({ headless: true, args: browserArguments(proxy.server), timeout: deadlineMs });
    browser = await launching;
    launching = undefined;
    context = await browser.newContext({ viewport, serviceWorkers: "block" });
    await installReachPolicy(context);
    if (timedOut) throw new CallDeadlineError(deadlineMs);
    const page = await context.newPage();
    return {
      context,
      page,
      dirs,
      denials,
      get timedOut() {
        return timedOut;
      },
      close: shutdown,
    };
  } catch (error) {
    await shutdown();
    throw timedOut && !(error instanceof CallDeadlineError) ? new CallDeadlineError(deadlineMs) : error;
  }
}
