/**
 * `check` の本体。遷移の前から購読し、console.error / uncaught exception / HTTP 4xx・5xx /
 * requestfailed / 遷移そのものの失敗を**別分類**で集める。`goto` は 404 / 500 で throw しないため、
 * load の成功をアプリの検証成功と同一視しない (失敗が 1 件でもあれば検証失敗として返す)。
 * 収集は件数・文字数・出力バイト数の上限で止める (無制限にすると会話のコンテキストを食う)。
 */
import type { ConsoleMessage, Page, Request, Response } from "playwright-core";
import { EXIT_OK, EXIT_VALIDATION_FAILED } from "./exit-codes";
import {
  CHECK_SETTLE_MS,
  MAX_CHECK_ITEMS,
  MAX_CHECK_OUTPUT_BYTES,
  MAX_CHECK_TEXT_CHARS,
  READY_TIMEOUT_MS,
} from "./limits";
import { navigate } from "./navigation";
import { capLines, truncateToBytes } from "./outputs";
import type { BrowserSession } from "./session";

export type CheckCategory = "navigation" | "ready" | "pageerror" | "console" | "http" | "requestfailed";

export interface CheckItem {
  category: CheckCategory;
  text: string;
  /** 同じ内容の繰り返し。件数ではなく「何回出たか」を潰さずに出力を短くする */
  count: number;
  /** favicon などの警告。失敗ではないため終了コードには影響しない */
  warning: boolean;
}

export interface CheckReport {
  url: string;
  items: CheckItem[];
  /** 件数の上限に達して打ち切ったか */
  truncated: boolean;
  failures: number;
  warnings: number;
  durationMs: number;
}

export interface CheckRecorder {
  record(category: CheckCategory, text: string, options?: { warning?: boolean }): void;
  report(input: { url: string; durationMs: number }): CheckReport;
}

export interface CheckRecorderOptions {
  maxItems?: number;
  maxTextChars?: number;
  log?: (message: string) => void;
}

export function createCheckRecorder(options: CheckRecorderOptions = {}): CheckRecorder {
  const maxItems = options.maxItems ?? MAX_CHECK_ITEMS;
  const maxTextChars = options.maxTextChars ?? MAX_CHECK_TEXT_CHARS;
  const log = options.log ?? (() => {});
  const items: CheckItem[] = [];
  const byText = new Map<string, CheckItem>();
  let truncated = false;

  return {
    record: (category, text, recordOptions = {}) => {
      const trimmed = truncateToBytes(text, maxTextChars).text;
      const key = `${category}\u0000${trimmed}`;
      const existing = byText.get(key);
      if (existing) {
        existing.count += 1;
        return;
      }
      if (items.length >= maxItems) {
        if (!truncated) {
          truncated = true;
          log(`収集の上限 (${maxItems} 件) に達したため、以降の項目を打ち切りました`);
        }
        return;
      }
      const item: CheckItem = { category, text: trimmed, count: 1, warning: recordOptions.warning ?? false };
      byText.set(key, item);
      items.push(item);
    },
    report: ({ url, durationMs }) => ({
      url,
      items,
      truncated,
      failures: items.filter((item) => !item.warning).length,
      warnings: items.filter((item) => item.warning).length,
      durationMs,
    }),
  };
}

/**
 * アイコンの 404 はアプリの失敗ではないので警告にする。headless のブラウザは favicon を要求しないが、
 * 明示的に読み込むページはある (`apple-touch-icon` などの表記も同じ扱いにする)。
 */
const ICON_FILE_NAME = /^(?:favicon\.(?:ico|svg|png|webp)|apple-touch-icon(?:-\d+x\d+)?\.(?:png|jpg|jpeg|webp))$/;

export function isIconUrl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return ICON_FILE_NAME.test(pathname.split("/").pop()?.toLowerCase() ?? "");
}

/**
 * Chromium が出す「リソースの読み込みに失敗した」console.error は、http / requestfailed と同じ事象の
 * 写しなので落とす (1 つの失敗を 2 回数えない)。
 */
export function isBrowserConsoleNoise(text: string): boolean {
  return text.startsWith("Failed to load resource");
}

/** proxy が拒否した宛先か。redirect 先など、route を経由しない通信の拒否を見分ける */
export function isDeniedByProxy(denials: readonly string[], url: string): boolean {
  if (denials.length === 0) return false;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  return denials.some((denied) => denied.includes(host));
}

function describePageError(error: Error): string {
  const lines = (error.stack ?? "").split("\n");
  const head = lines[0]?.trim() || `${error.name}: ${error.message}`;
  const frame = lines.find((line) => line.trim().startsWith("at "));
  return frame ? `${head} (${frame.trim().slice(3)})` : head;
}

function describeConsoleMessage(message: ConsoleMessage): string {
  const location = message.location();
  const where = location.url ? ` @ ${location.url}:${location.lineNumber + 1}:${location.columnNumber + 1}` : "";
  return `${message.text()}${where}`;
}

function describeResponse(response: Response): string {
  const statusText = response.statusText() ? ` ${response.statusText()}` : "";
  return `${response.request().method()} ${response.url()} → ${response.status()}${statusText}`;
}

function describeRequestFailure(request: Request): string {
  return `${request.method()} ${request.url()} 失敗 (${request.failure()?.errorText ?? "原因不明"})`;
}

export function formatCheckReport(report: CheckReport): string {
  const lines = report.items.map((item) => {
    const level = item.warning ? "警告" : "失敗";
    const repeat = item.count > 1 ? ` x${item.count}` : "";
    return `[${level}] ${item.category}${repeat}: ${item.text}`;
  });
  if (report.truncated) lines.push("... 件数の上限に達したため残りを省略しました");
  const verdict = report.failures > 0 ? "検証失敗" : "検証成功";
  const summary = `check: ${verdict} (失敗 ${report.failures} / 警告 ${report.warnings}, ${report.durationMs} ms) ${report.url}`;
  return `${capLines(lines, summary, MAX_CHECK_OUTPUT_BYTES)}\n`;
}

export function checkExitCode(report: CheckReport): number {
  return report.failures > 0 ? EXIT_VALIDATION_FAILED : EXIT_OK;
}

/** 遷移の後始末の待ち時間。ずっと応答しない相手でもここで諦める */
const RESET_TIMEOUT_MS = 5_000;

export interface CheckOptions {
  /** SPA の描画完了を待つ selector。現れなければ検証失敗 (ready) として扱う */
  readySelector?: string;
  settleMs?: number;
  navigationTimeoutMs?: number;
  readyTimeoutMs?: number;
  maxItems?: number;
  log?: (message: string) => void;
}

export async function runCheck(session: BrowserSession, url: string, options: CheckOptions = {}): Promise<CheckReport> {
  const recorder = createCheckRecorder({ maxItems: options.maxItems, log: options.log });
  const startedAt = Date.now();
  const denied = (target: string) => isDeniedByProxy(session.denials, target);
  const recordResource = (category: "http" | "requestfailed", text: string, target: string): void => {
    if (denied(target)) {
      recorder.record("navigation", `ループバック以外へは通信しません: ${target}`);
      return;
    }
    recorder.record(category, text, { warning: isIconUrl(target) });
  };
  const onPageError = (error: Error): void => recorder.record("pageerror", describePageError(error));
  const watched = new Set<Page>();
  const watchPage = (page: Page): void => {
    page.on("pageerror", onPageError);
    watched.add(page);
  };
  const onConsole = (message: ConsoleMessage): void => {
    if (message.type() !== "error" || isBrowserConsoleNoise(message.text())) return;
    recorder.record("console", describeConsoleMessage(message));
  };
  const onResponse = (response: Response): void => {
    if (response.status() < 400) return;
    recordResource("http", describeResponse(response), response.url());
  };
  const onRequestFailed = (request: Request): void => {
    recordResource("requestfailed", describeRequestFailure(request), request.url());
  };

  watchPage(session.page);
  // pageerror は context には無いので、popup を掴むために context の page イベントでも張る
  session.context.on("page", watchPage);
  session.context.on("console", onConsole);
  session.context.on("response", onResponse);
  session.context.on("requestfailed", onRequestFailed);
  try {
    let navigated = true;
    try {
      await navigate(session.page, url, { timeoutMs: options.navigationTimeoutMs });
    } catch (error) {
      navigated = false;
      recorder.record("navigation", (error as Error).message);
      // 応答しない遷移を残すと、同じ session を使い続ける呼び出し (self-test) の route 操作が止まる。
      // about:blank で置き換えるとブラウザ側の待ちが解ける (page.stop() では解けない)。
      await session.page.goto("about:blank", { timeout: RESET_TIMEOUT_MS }).catch(() => undefined);
    }
    // 文書が入っていない状態で待っても意味がないため、遷移に失敗したら ready / settle へ進まない
    if (navigated) {
      if (options.readySelector) {
        const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
        await session.page
          .waitForSelector(options.readySelector, { timeout: readyTimeoutMs })
          .catch(() =>
            recorder.record("ready", `ready selector が現れません: ${options.readySelector} (${readyTimeoutMs} ms)`),
          );
      }
      await session.page.waitForTimeout(options.settleMs ?? CHECK_SETTLE_MS).catch(() => undefined);
    }
  } finally {
    session.context.off("page", watchPage);
    session.context.off("console", onConsole);
    session.context.off("response", onResponse);
    session.context.off("requestfailed", onRequestFailed);
    for (const page of watched) page.off("pageerror", onPageError);
  }
  return recorder.report({ url, durationMs: Date.now() - startedAt });
}
