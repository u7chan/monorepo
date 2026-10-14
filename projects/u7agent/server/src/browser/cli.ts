/**
 * u7agent-browser の入口。サンドボックスの bash から単発で呼ばれ、実装は同じディレクトリへ置く。
 * 呼び出し元の cwd が成果物の保存先の基準になるため、このプロセスと入口のシェルは chdir しない。
 */
import { parseArgs, USAGE, type CliOptions } from "./args";
import { runSelfTest } from "./self-test";
import { openBrowserSession } from "./session";

/** 診断は stderr へ出す (stdout は呼び出し元が読む結果だけにする) */
function log(message: string): void {
  process.stderr.write(`u7agent-browser: ${message}\n`);
}

async function run(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  let options: CliOptions | undefined;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log((error as Error).message);
    process.stderr.write(USAGE);
    return 2;
  }
  if (!options) {
    process.stderr.write(USAGE);
    return 2;
  }

  const session = await openBrowserSession({ deadlineMs: options.deadlineMs, log });
  try {
    const checks = await runSelfTest(session);
    for (const check of checks) process.stdout.write(`ok: ${check}\n`);
    process.stdout.write(`u7agent-browser: self-test ok (${checks.length} checks)\n`);
    return 0;
  } catch (error) {
    if (session.timedOut) log(`期限 (${options.deadlineMs} ms) を超えました`);
    else log((error as Error).message);
    return 1;
  } finally {
    await session.close();
  }
}

process.exitCode = await run(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`u7agent-browser: ${(error as Error).message}\n`);
  return 1;
});
