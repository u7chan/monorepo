/**
 * SDK の loadSkillsFromDir を専用スレッドで走らせ、期限で打ち切るラッパー。
 * loadSkillsFromDir は子ディレクトリの symlink を辿るため、同じ実体へ複数の経路で到達する形
 * (自己参照する symlink が 2 本あるなど) では走査回数が指数的に増え、同期実行ではプロセスを塞ぐ。
 * 走査規則 (hidden / node_modules / ignore ファイル / 再帰 / frontmatter 検証) を二重実装しないため、
 * 規則は SDK のままにして実行だけを隔離し、期限切れは呼び出し側が「発見できなかった」として扱う。
 * worker はプロセスで 1 つを使い回す (起動と SDK の import に数百 ms 掛かるため)。期限切れや異常終了では
 * worker を捨て、次の要求で作り直す (docs/sandbox-api.md)。
 */
import type { LoadSkillsResult } from "@earendil-works/pi-coding-agent";
import { Worker } from "node:worker_threads";

/** 1 ディレクトリの走査期限。正常な `.agents/skills` の走査は数十 ms で終わる */
export const SKILLS_SCAN_TIMEOUT_MS = 2000;
/** worker の起動と SDK の import を待つ上限。走査の期限と分け、遅い環境の初回を落とさない */
const WORKER_STARTUP_TIMEOUT_MS = 10_000;

interface ScanMessage {
  /** worker の準備完了 (走査結果ではない) */
  type?: "ready";
  ok?: boolean;
  result?: LoadSkillsResult;
  error?: string;
}

interface ActiveWorker {
  worker: Worker;
  ready: Promise<void>;
}

/**
 * worker のコードは eval で渡す。SDK のモジュール解決は親 (tsx 実行) で済ませ、worker には URL だけ渡す
 * (worker 側で解決条件を再現しない)。返すのは loadSkillsFromDir の結果だけで、ファイルは変更しない。
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const post = (message) => parentPort.postMessage(message);
import(workerData.moduleUrl)
  .then(({ loadSkillsFromDir }) => {
    parentPort.on("message", (dir) => {
      try {
        post({ ok: true, result: loadSkillsFromDir({ dir, source: "u7agent" }) });
      } catch (error) {
        post({ ok: false, error: error && error.message ? error.message : String(error) });
      }
    });
    post({ type: "ready" });
  })
  .catch((error) => post({ ok: false, error: error && error.message ? error.message : String(error) }));
`;

const SDK_MODULE_URL = import.meta.resolve("@earendil-works/pi-coding-agent");

let active: ActiveWorker | undefined;
/** 走査を直列化する (worker は 1 つで、同時要求は順番に処理する) */
let queue: Promise<void> = Promise.resolve();

/** 期限切れは 504 として route から返す (BFF は発見失敗として扱う) */
export function skillsScanTimeoutError(dir: string, timeoutMs: number): Error & { statusCode: number } {
  return Object.assign(
    new Error(`スキルの走査が期限 (${timeoutMs}ms) を超えました (循環する symlink がある可能性があります): ${dir}`),
    { statusCode: 504 },
  );
}

export function scanSkillsWithDeadline(dir: string, timeoutMs = SKILLS_SCAN_TIMEOUT_MS): Promise<LoadSkillsResult> {
  const run = queue.then(() => scanOnce(dir, timeoutMs));
  // 失敗しても次の要求を止めない (queue は成功・失敗どちらでも進める)
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 起動時に worker を作っておく。初回のスキル一覧 / セッション作成で SDK の import 待ちを出さない。 */
export function warmSkillsScanner(): Promise<void> {
  return ensureWorker().ready;
}

async function scanOnce(dir: string, timeoutMs: number): Promise<LoadSkillsResult> {
  const current = ensureWorker();
  await current.ready;
  // ready を待つ間に worker が落ちて作り直されていたら、新しい worker でやり直す
  if (active !== current) return scanOnce(dir, timeoutMs);
  return runOnWorker(current, dir, timeoutMs);
}

function ensureWorker(): ActiveWorker {
  if (active) return active;
  // execArgv を継承しない (テスト実行時の --test などを worker へ持ち込まない)
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    execArgv: [],
    workerData: { moduleUrl: SDK_MODULE_URL },
  });
  // idle の worker がプロセスの寿命を延ばさない (テストの終了を妨げない)
  worker.unref();
  // 常設のハンドラ: 未処理の 'error' でプロセスを落とさず、idle のまま落ちても次の要求で作り直す
  worker.on("error", () => discardWorker(worker));
  worker.on("exit", () => discardWorker(worker));

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      discardWorker(worker);
      rejectReady(new Error("スキル走査スレッドの起動がタイムアウトしました"));
    }, WORKER_STARTUP_TIMEOUT_MS);
    const onMessage = (message: ScanMessage) => {
      if (message?.type === "ready") {
        clearTimeout(timer);
        worker.off("message", onMessage);
        resolveReady();
        return;
      }
      if (message?.ok === false) {
        clearTimeout(timer);
        worker.off("message", onMessage);
        rejectReady(new Error(message.error || "スキル走査スレッドを起動できませんでした"));
      }
    };
    worker.on("message", onMessage);
  });

  active = { worker, ready };
  return active;
}

function runOnWorker(current: ActiveWorker, dir: string, timeoutMs: number): Promise<LoadSkillsResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      current.worker.off("message", onMessage);
      current.worker.off("error", onError);
      current.worker.off("exit", onExit);
      action();
    };
    const onMessage = (message: ScanMessage) => {
      finish(() => {
        if (message?.ok && message.result) resolve(message.result);
        else reject(new Error(message?.error || "スキルの走査に失敗しました"));
      });
    };
    const onError = (error: Error) => {
      discardWorker(current.worker);
      finish(() => reject(error));
    };
    const onExit = (code: number) => {
      discardWorker(current.worker);
      finish(() => reject(new Error(`スキルの走査スレッドが終了しました (code ${code})`)));
    };
    const timer = setTimeout(() => {
      // 同期ループ中の worker も terminate で止まる。次の要求は新しい worker で走る
      discardWorker(current.worker);
      finish(() => reject(skillsScanTimeoutError(dir, timeoutMs)));
    }, timeoutMs);

    current.worker.on("message", onMessage);
    current.worker.on("error", onError);
    current.worker.on("exit", onExit);
    current.worker.postMessage(dir);
  });
}

/** worker を捨てる。走査中の要求は onExit / 期限のハンドラが reject する */
function discardWorker(worker: Worker): void {
  if (active?.worker !== worker) return;
  active = undefined;
  void worker.terminate().catch(() => {});
}
