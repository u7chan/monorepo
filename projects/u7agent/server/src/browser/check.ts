/**
 * `check` の本体。遷移の前から購読し、console.error / uncaught exception / HTTP 4xx・5xx /
 * requestfailed / 遷移そのものの失敗を**別分類**で集める。`goto` は 404 / 500 で throw しないため、
 * load の成功をアプリの検証成功と同一視しない (失敗が 1 件でもあれば検証失敗として返す)。
 * 収集は件数・文字数・出力バイト数の上限で止める (無制限にすると会話のコンテキストを食う)。
 * 詳細を捨てた後も失敗 / 警告は数え続け、収集が完走していない (期限切れ) 場合はレポートを返さない。
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
  /** アイコンの 404 だけを警告にした項目。失敗ではないため終了コードには影響しない */
  warning: boolean;
}

export interface CheckReport {
  url: string;
  /** 保持した詳細。上限に達した分は含まれない (成否は failures / warnings で数える) */
  items: CheckItem[];
  /** 詳細の上限に達して打ち切ったか。打ち切っても件数は failures / warnings へ数える */
  truncated: boolean;
  /** 記録した失敗の件数 (詳細を保持しなかった分も含む)。成否判定はこの値だけで行う */
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
  // 詳細は上限で捨てるが、成否は捨てた分も数える (上限後の失敗が検証成功にならないようにする)
  let failures = 0;
  let warnings = 0;
  let truncated = false;

  return {
    record: (category, text, recordOptions = {}) => {
      if (recordOptions.warning ?? false) warnings += 1;
      else failures += 1;
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
          log(`収集の上限 (${maxItems} 件) に達したため、以降の詳細を打ち切りました`);
        }
        return;
      }
      const item: CheckItem = { category, text: trimmed, count: 1, warning: recordOptions.warning ?? false };
      byText.set(key, item);
      items.push(item);
    },
    report: ({ url, durationMs }) => ({ url, items, truncated, failures, warnings, durationMs }),
  };
}

/**
 * アイコンの URL か。判定は URL の名前だけで行い、警告にするかは `isWarningHttpResponse` が状態込みで決める。
 * headless のブラウザは favicon を要求しないが、明示的に読み込むページはある。
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
 * 警告にするのはアイコンの 404 だけ。同じアイコンの 500 や通信失敗はアプリの失敗として扱う
 * (アイコンの有無だけが原因の失敗と、アプリが壊れている失敗を混ぜない)。
 */
export function isWarningHttpResponse(status: number, url: string): boolean {
  return status === 404 && isIconUrl(url);
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

/** 要約の URL を切ったときの目印と末尾の改行。URL の許容量をこの分だけ狭くする */
const SUMMARY_TRAILING_BYTES = 4;

export function formatCheckReport(report: CheckReport): string {
  const lines = report.items.map((item) => {
    const level = item.warning ? "警告" : "失敗";
    const repeat = item.count > 1 ? ` x${item.count}` : "";
    return `[${level}] ${item.category}${repeat}: ${item.text}`;
  });
  if (report.truncated) lines.push("... 詳細の上限に達したため以降の詳細は省略しました (件数には含みます)");
  const verdict = report.failures > 0 ? "検証失敗" : "検証成功";
  const prefix = `check: ${verdict} (失敗 ${report.failures} 件 / 警告 ${report.warnings} 件, ${report.durationMs} ms) `;
  // URL は利用者が指定する値で長さの上限が無い。要約ごと出力の上限へ収める (末尾の ... で切ったことを示す)
  const allowance = Math.max(0, MAX_CHECK_OUTPUT_BYTES - Buffer.byteLength(prefix, "utf8") - SUMMARY_TRAILING_BYTES);
  const { text, truncated } = truncateToBytes(report.url, allowance);
  const summary = `${prefix}${truncated ? `${text}...` : text}`;
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
  /** proxy が拒否した宛先は navigation の失敗として記録する (http / requestfailed へは数えない) */
  const recordDenied = (target: string): boolean => {
    if (!isDeniedByProxy(session.denials, target)) return false;
    recorder.record("navigation", `ループバック以外へは通信しません: ${target}`);
    return true;
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
    const target = response.url();
    if (recordDenied(target)) return;
    recorder.record("http", describeResponse(response), { warning: isWarningHttpResponse(response.status(), target) });
  };
  const onRequestFailed = (request: Request): void => {
    const target = request.url();
    if (recordDenied(target)) return;
    recorder.record("requestfailed", describeRequestFailure(request));
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
        const selector = options.readySelector;
        await session.page.waitForSelector(selector, { timeout: readyTimeoutMs }).catch((error: Error) => {
          // selector の書き間違いは待ち外れと区別する (原因が違うと直し方も違う)
          const timedOut = error.message.includes("Timeout");
          const reason = timedOut ? `${readyTimeoutMs} ms` : (error.message.split("\n")[0] ?? "");
          recorder.record(
            "ready",
            timedOut
              ? `ready selector が現れません: ${selector} (${reason})`
              : `ready selector を待てません: ${selector} (${reason})`,
          );
        });
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
  // 期限でブラウザが閉じた場合は収集が完走していない。検証結果ではなく起動・入力エラーとして返す
  // (呼び出し元の CLI が終了コード 2 へ振り分ける)
  if (session.timedOut) throw new Error("呼び出しの期限を超えたため検証を完了できませんでした");
  return recorder.report({ url, durationMs: Date.now() - startedAt });
}
