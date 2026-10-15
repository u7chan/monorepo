/**
 * u7agent-browser の入口。サンドボックスの bash から単発で呼ばれ、実装は同じディレクトリへ置く。
 * 呼び出し元の cwd が成果物の保存先の基準になるため、このプロセスと入口のシェルは chdir しない。
 * 終了コードは exit-codes.ts の 3 値に固定する (呼び出し元が検証失敗と起動失敗を区別できるようにする)。
 */
import { parseArgs, USAGE, type CliOptions } from "./args";
import { checkExitCode, formatCheckReport, runCheck } from "./check";
import { runDom } from "./dom";
import { EXIT_ERROR, EXIT_OK, EXIT_VALIDATION_FAILED } from "./exit-codes";
import { MAX_DOM_BYTES } from "./limits";
import { runScript } from "./run";
import { runSelfTest } from "./self-test";
import { openBrowserSession, type BrowserSession } from "./session";
import { runShot } from "./shot";

/** 診断は stderr へ出す (stdout は呼び出し元が読む結果だけにする) */
function log(message: string): void {
  process.stderr.write(`u7agent-browser: ${message}\n`);
}

/**
 * セッションを開いて本体を走らせる。本体の失敗 (検証失敗・期限超過・書き込み失敗) だけをここで畳み、
 * セッションの起動失敗 (ブラウザ不在・同時実行の上限・/proc 不可) はそのまま投げる。
 */
async function withSession(
  options: CliOptions,
  failureCode: number,
  body: (session: BrowserSession) => Promise<number>,
): Promise<number> {
  const session = await openBrowserSession({
    deadlineMs: options.deadlineMs,
    ...(options.kind === "shot" ? { viewport: options.viewport } : {}),
    log,
  });
  try {
    return await body(session);
  } catch (error) {
    log(session.timedOut ? `期限 (${options.deadlineMs} ms) を超えました` : (error as Error).message);
    return failureCode;
  } finally {
    await session.close();
  }
}

/**
 * 期限超過での終了。スクリプトは任意コードなので、ブラウザを閉じてもタイマーなどを掴んだまま動き続け得る
 * (`process.exitCode` を立てるだけではプロセスが残る)。回収 (shutdown は冪等で、close はその完了を待つ) は
 * 済んでいるため、ここでプロセスを終える。
 */
async function interruptRun(session: BrowserSession, deadlineMs: number): Promise<never> {
  log(`期限 (${deadlineMs} ms) を超えました`);
  await session.close();
  process.exit(EXIT_ERROR);
}

function runCommand(options: CliOptions): Promise<number> {
  // self-test の失敗は probe の失敗 (検証失敗)、サブコマンドの失敗は起動・入力エラーとして返す
  return withSession(options, options.kind === "self-test" ? EXIT_VALIDATION_FAILED : EXIT_ERROR, async (session) => {
    switch (options.kind) {
      case "self-test": {
        const checks = await runSelfTest(session);
        for (const check of checks) process.stdout.write(`ok: ${check}\n`);
        process.stdout.write(`u7agent-browser: self-test ok (${checks.length} checks)\n`);
        return EXIT_OK;
      }
      case "shot": {
        const saved = await runShot(session, options.url, options.out, {
          fullPage: options.fullPage,
          waitForSelector: options.waitForSelector,
          waitForTimeoutMs: options.waitForTimeoutMs,
        });
        process.stdout.write(`${saved.path}\n`);
        return EXIT_OK;
      }
      case "dom": {
        const result = await runDom(session, options.url);
        process.stdout.write(result.html.endsWith("\n") ? result.html : `${result.html}\n`);
        if (result.truncated) log(`dom が上限 (${MAX_DOM_BYTES} bytes) を超えたため切り詰めました`);
        return EXIT_OK;
      }
      case "check": {
        const report = await runCheck(session, options.url, { readySelector: options.waitForSelector, log });
        process.stdout.write(formatCheckReport(report));
        return checkExitCode(report);
      }
      case "run": {
        const outcome = await runScript(session, options.file);
        if (outcome.status === "ok") return EXIT_OK;
        if (outcome.status === "interrupted") return interruptRun(session, options.deadlineMs);
        log(`スクリプトが失敗しました: ${outcome.error.message}`);
        return EXIT_VALIDATION_FAILED;
      }
    }
  });
}

async function run(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  let options: CliOptions | undefined;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log((error as Error).message);
    process.stderr.write(USAGE);
    return EXIT_ERROR;
  }
  if (!options) {
    process.stderr.write(USAGE);
    return EXIT_ERROR;
  }
  return runCommand(options).catch((error: unknown) => {
    log((error as Error).message);
    return EXIT_ERROR;
  });
}

process.exitCode = await run(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`u7agent-browser: ${(error as Error).message}\n`);
  return EXIT_ERROR;
});
