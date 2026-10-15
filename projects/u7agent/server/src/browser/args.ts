/**
 * CLI の引数。サブコマンドを 1 つの型へ畳み、資源上限の案内もここに置く。
 * 実行できない引数は undefined (サブコマンドが無い) か例外 (不正) で、入口が使い方を出して終了する。
 */
import { EXIT_ERROR, EXIT_OK, EXIT_VALIDATION_FAILED } from "./exit-codes";
import {
  CALL_DEADLINE_MS,
  MAX_CONCURRENT_CALLS,
  MAX_DOM_BYTES,
  MAX_IMAGE_BYTES,
  MAX_OUTPUTS,
  MAX_VIEWPORT_DIMENSION,
  NAVIGATION_TIMEOUT_MS,
  parseDeadlineMs,
  parsePositiveInt,
  READY_TIMEOUT_MS,
  VIEWPORT,
} from "./limits";
import { OUTPUT_EXTENSION, validateOutputName } from "./outputs";
import { SCRIPT_EXTENSION, validateScriptName } from "./run";

export interface SelfTestOptions {
  kind: "self-test";
  deadlineMs: number;
}

export interface ShotCliOptions {
  kind: "shot";
  url: string;
  out: string;
  viewport: { width: number; height: number };
  fullPage: boolean;
  waitForSelector?: string;
  waitForTimeoutMs?: number;
  deadlineMs: number;
}

export interface DomCliOptions {
  kind: "dom";
  url: string;
  deadlineMs: number;
}

export interface CheckCliOptions {
  kind: "check";
  url: string;
  waitForSelector?: string;
  deadlineMs: number;
}

export interface RunCliOptions {
  kind: "run";
  file: string;
  deadlineMs: number;
}

export type CliOptions = SelfTestOptions | ShotCliOptions | DomCliOptions | CheckCliOptions | RunCliOptions;

export const USAGE = `u7agent-browser — サンドボックス内のヘッドレスブラウザ

使い方:
  u7agent-browser shot <url> <out${OUTPUT_EXTENSION}> [--width <px>] [--height <px>] [--full-page]
                   [--wait-for-selector <selector>] [--wait-for-timeout <ms>]
                   スクリーンショットを保存し、実際に保存した cwd 相対パスを stdout へ出す
  u7agent-browser dom <url>
                   レンダリング後の HTML を stdout へ出す (上限 ${Math.round(MAX_DOM_BYTES / 1024)} KiB で切り詰め)
  u7agent-browser check <url> [--wait-for-selector <selector>]
                   console.error / uncaught exception / HTTP 4xx・5xx / requestfailed / 遷移や ready selector の
                   失敗を別分類で収集し、失敗があれば終了コード ${EXIT_VALIDATION_FAILED} で返す
  u7agent-browser run <file${SCRIPT_EXTENSION}> [--deadline-ms <ms>]
                   スクリプトの既定 export の関数へ page / context を渡して実行する (任意コード)
  u7agent-browser --self-test [--deadline-ms <ms>]
                   同梱物と外部到達ポリシーを検証する (イメージの probe 用)
  u7agent-browser --help

保存 (shot):
  既存のファイルは上書きせず、<name>-1${OUTPUT_EXTENSION} のように連番を付ける。親ディレクトリは作る。
  保存できるのは ${OUTPUT_EXTENSION} だけ。--full-page はページ全体を撮る。
  既定の viewport は ${VIEWPORT.width}x${VIEWPORT.height} で、スマホ幅は --width 375 --height 667 のように指定する。

終了コード:
  ${EXIT_OK} 正常 / ${EXIT_VALIDATION_FAILED} 検証失敗 (check の失敗、--self-test の失敗、run のスクリプトの例外) /
  ${EXIT_ERROR} 起動・入力エラー (引数、ループバック以外の URL、スクリプトを読み込めない、ブラウザ起動、期限超過)

実行 (run):
  スクリプトは ${SCRIPT_EXTENSION} で、既定 export の関数が { page, context } を 1 つ受け取る。
    export default async ({ page }) => { await page.goto("http://127.0.0.1:8080/"); }
  ドライバはラッパー側で解決するため、スクリプトから bare import では解決できない (chromium.launch は開かない)。
  外部到達のポリシーは既定で適用されるが、run は任意コードなので解除できる (境界の実効性は標準経路に限る)。
  スクリプトの stdout / stderr はそのまま出る。期限超過ではブラウザと一時領域を回収して終了する。

資源上限:
  期限 ${CALL_DEADLINE_MS} ms / viewport ${VIEWPORT.width}x${VIEWPORT.height} / 成果物 ${MAX_OUTPUTS} 件 /
  画像 ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MiB / 同時実行 ${MAX_CONCURRENT_CALLS} 件 /
  遷移の待ち ${NAVIGATION_TIMEOUT_MS} ms / selector の待ち ${READY_TIMEOUT_MS} ms
  (同時実行の上限に達したら実行せずに終了する。呼び出しごとに独立したプロセスと一時領域を持つ)

外部到達:
  ループバック (127.0.0.1 / localhost / [::1]) 以外へは通信しない。data: URL は対象外。

起動引数:
  --no-sandbox / --disable-gpu / --disable-dev-shm-usage / --disable-breakpad / --hide-scrollbars を常に付ける。
  HOME は呼び出しごとの一時領域へ置き、--user-data-dir は Playwright に任せる。
`;

const BOOLEAN_FLAGS = ["--full-page"] as const;

/** URL として解釈できない値は、ブラウザを起動する前に落とす */
function parseUrl(value: string): string {
  try {
    new URL(value);
  } catch {
    throw new Error(`URL を解釈できません: ${value}`);
  }
  return value;
}

function parseDimension(value: string, flag: string): number {
  const parsed = parsePositiveInt(value, flag);
  if (parsed > MAX_VIEWPORT_DIMENSION) {
    throw new Error(`${flag}は 1〜${MAX_VIEWPORT_DIMENSION} の整数 (px) で指定してください: ${value}`);
  }
  return parsed;
}

function parseSelector(value: string, flag: string): string {
  if (value.trim().length === 0) throw new Error(`${flag} が空です`);
  return value;
}

interface ParsedFields {
  deadlineMs: number;
  positionals: string[];
  flags: Map<string, string>;
  booleans: Set<string>;
}

/**
 * `--flag value` と位置引数へ割る。許可するフラグはコマンドごとに渡す (dom に --width を黙って無視させない)。
 * 位置引数の個数はコマンド側で確かめる。
 */
function parseFields(rest: readonly string[], allowed: readonly string[]): ParsedFields {
  const fields: ParsedFields = {
    deadlineMs: CALL_DEADLINE_MS,
    positionals: [],
    flags: new Map(),
    booleans: new Set(),
  };
  const args = [...rest];
  while (args.length > 0) {
    const arg = args.shift() as string;
    if (!allowed.includes(arg)) {
      if (arg.startsWith("-")) throw new Error(`未対応の引数です: ${arg}`);
      fields.positionals.push(arg);
      continue;
    }
    if ((BOOLEAN_FLAGS as readonly string[]).includes(arg)) {
      fields.booleans.add(arg);
      continue;
    }
    const value = args.shift();
    if (value === undefined) throw new Error(`${arg} の値がありません`);
    fields.flags.set(arg, value);
  }
  const deadline = fields.flags.get("--deadline-ms");
  fields.deadlineMs = deadline === undefined ? CALL_DEADLINE_MS : parseDeadlineMs(deadline);
  return fields;
}

export function parseArgs(argv: readonly string[]): CliOptions | undefined {
  const rest = [...argv];
  const command = rest.shift();
  if (command === undefined) return undefined;
  // `--help` は入口が parseArgs より先に処理する。サブコマンドが無い場合は使い方を出して終了する
  if (command.startsWith("-") && command !== "--self-test") return undefined;

  const deadlineFlag = "--deadline-ms";
  const expectPositionals = (fields: ParsedFields, count: number, usage: string): void => {
    if (fields.positionals.length !== count) throw new Error(`使い方: ${usage}`);
  };

  switch (command) {
    case "--self-test": {
      const fields = parseFields(rest, [deadlineFlag]);
      expectPositionals(fields, 0, "u7agent-browser --self-test [--deadline-ms <ms>]");
      return { kind: "self-test", deadlineMs: fields.deadlineMs };
    }
    case "shot": {
      const flags = [
        deadlineFlag,
        "--width",
        "--height",
        "--full-page",
        "--wait-for-selector",
        "--wait-for-timeout",
      ] as const;
      const fields = parseFields(rest, flags);
      expectPositionals(
        fields,
        2,
        "u7agent-browser shot <url> <out.png> [--width <px>] [--height <px>] [--full-page] [--wait-for-selector <selector>] [--wait-for-timeout <ms>]",
      );
      const width = fields.flags.get("--width");
      const height = fields.flags.get("--height");
      const waitForSelector = fields.flags.get("--wait-for-selector");
      const waitForTimeout = fields.flags.get("--wait-for-timeout");
      return {
        kind: "shot",
        url: parseUrl(fields.positionals[0] as string),
        out: validateOutputName(fields.positionals[1] as string),
        viewport: {
          width: width === undefined ? VIEWPORT.width : parseDimension(width, "--width"),
          height: height === undefined ? VIEWPORT.height : parseDimension(height, "--height"),
        },
        fullPage: fields.booleans.has("--full-page"),
        ...(waitForSelector === undefined
          ? {}
          : { waitForSelector: parseSelector(waitForSelector, "--wait-for-selector") }),
        ...(waitForTimeout === undefined
          ? {}
          : { waitForTimeoutMs: parsePositiveInt(waitForTimeout, "--wait-for-timeout ") }),
        deadlineMs: fields.deadlineMs,
      };
    }
    case "dom": {
      const fields = parseFields(rest, [deadlineFlag]);
      expectPositionals(fields, 1, "u7agent-browser dom <url>");
      return { kind: "dom", url: parseUrl(fields.positionals[0] as string), deadlineMs: fields.deadlineMs };
    }
    case "check": {
      const fields = parseFields(rest, [deadlineFlag, "--wait-for-selector"]);
      expectPositionals(fields, 1, "u7agent-browser check <url> [--wait-for-selector <selector>]");
      const waitForSelector = fields.flags.get("--wait-for-selector");
      return {
        kind: "check",
        url: parseUrl(fields.positionals[0] as string),
        ...(waitForSelector === undefined
          ? {}
          : { waitForSelector: parseSelector(waitForSelector, "--wait-for-selector") }),
        deadlineMs: fields.deadlineMs,
      };
    }
    case "run": {
      const fields = parseFields(rest, [deadlineFlag]);
      expectPositionals(fields, 1, `u7agent-browser run <file${SCRIPT_EXTENSION}> [--deadline-ms <ms>]`);
      return { kind: "run", file: validateScriptName(fields.positionals[0] as string), deadlineMs: fields.deadlineMs };
    }
    default:
      throw new Error(`未対応のサブコマンドです: ${command}`);
  }
}
