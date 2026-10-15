/**
 * `run` の本体。作業領域の `.mjs` (任意コード) を import し、既定 export の関数へラッパーが作った
 * page / context を渡す。ドライバはこの module 側で解決するため、スクリプトは bare import では
 * playwright-core を解決できず、受け取れるのは引数だけになる (`chromium.launch()` は開かない)。
 * 起動と終了は shot / dom / check と同じ session に乗せ、呼び出しごとの single-shot 契約を変えない。
 */
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserContext, Page } from "playwright-core";
import type { BrowserSession } from "./session";

/** 実行できるスクリプト。`--import tsx` の解釈に依存しないよう、ESM と分かる拡張子だけを受け付ける */
export const SCRIPT_EXTENSION = ".mjs";

export interface RunEntryInput {
  page: Page;
  context: BrowserContext;
}

export type RunEntry = (input: RunEntryInput) => unknown;

/** 実行の帰結。期限による打ち切りは、スクリプトが例外で終わった場合とは別の終了コードにする */
export type RunOutcome = { status: "ok" } | { status: "failed"; error: Error } | { status: "interrupted" };

/** 実行できない名前をブラウザの起動前に落とす (引数の解析と読み込みの両方から呼ぶ) */
export function validateScriptName(name: string): string {
  if (name.length === 0) throw new Error("スクリプトのパスが空です");
  if (extname(name).toLowerCase() !== SCRIPT_EXTENSION) {
    throw new Error(`スクリプトは ${SCRIPT_EXTENSION} で指定してください: ${name}`);
  }
  return name;
}

/** スクリプトを読み込み、既定 export の関数を取り出す。読み込めないものは入力エラーとして投げる */
export async function loadRunEntry(file: string, cwd = process.cwd()): Promise<RunEntry> {
  const path = resolve(cwd, validateScriptName(file));
  const stats = await stat(path).catch(() => undefined);
  if (stats?.isFile() !== true) throw new Error(`スクリプトを読めません: ${file}`);
  const loaded = (await import(pathToFileURL(path).href)) as { default?: unknown };
  if (typeof loaded.default !== "function") {
    throw new Error(`スクリプトの既定 export が関数ではありません: ${file}`);
  }
  return loaded.default as RunEntry;
}

export interface RunScriptOptions {
  /** スクリプトの解決の基準。既定は呼び出し元の cwd (入口が chdir しないので、そのまま作業領域) */
  cwd?: string;
}

export async function runScript(
  session: BrowserSession,
  file: string,
  options: RunScriptOptions = {},
): Promise<RunOutcome> {
  const entry = await loadRunEntry(file, options.cwd);
  // 期限超過では session の shutdown がブラウザを閉じるが、任意コードはそれでも戻らないことがある。
  // 戻らない呼び出しが期限を過ぎて残らないよう close の完了と競合させ、例外と打ち切りを区別して返す。
  const running = Promise.resolve().then(() => entry({ page: session.page, context: session.context }));
  const outcome = await Promise.race([
    running.then(
      () => "ok" as const,
      (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
    ),
    session.closed.then(() => "closed" as const),
  ]);
  if (outcome === "ok") return { status: "ok" };
  // 閉じた結果の例外 (Target closed など) は、スクリプトの失敗ではなく打ち切りとして返す
  if (outcome === "closed" || session.timedOut) return { status: "interrupted" };
  return { status: "failed", error: outcome.error };
}
