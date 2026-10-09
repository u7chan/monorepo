/**
 * bash の子プロセスへ適用する Landlock の補助。許可 root と権利を環境変数でラッパー (`u7agent-landlock`) へ渡し、
 * ラッパーが PR_SET_NO_NEW_PRIVS → landlock_restrict_self → exec する。ここはラッパーの解決と診断だけを担う。
 * ラッパーの同梱先と権利セットの設計は docs/sandbox.md を正とする。
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SandboxLandlockStatus } from "./protocol";
import { resolveTrustedExecutable, runtimeProbeEnv, RUNTIME_PROBE_PATH_DIRS } from "./runtime-info";

/** ラッパーのファイル名。イメージは `/usr/local/bin`、dev は `$HOME/.local/libexec/u7agent` に置く */
export const LANDLOCK_WRAPPER_NAME = "u7agent-landlock";

/** ABI 3 (Linux 6.2) 未満は truncate を制限できないため、実行しない */
export const LANDLOCK_MIN_ABI = 3;

/** ラッパーの `--abi` 診断の期限 */
export const LANDLOCK_PROBE_TIMEOUT_MS = 2000;

/** 無ければ作ってよい root。エージェントの bash と BFF 内部実行が共有する基準集合の 1 件 */
export interface LandlockWriteRoot {
  path: string;
  create?: boolean;
}

/**
 * ラッパーの探索先。PATH は使わず固定パスだけを見る (許可 root の外に置き、実体を realpath で確認する)。
 * dev は `pnpm dev` がラッパーを配置する。
 */
export function landlockWrapperDirs(home = homedir()): string[] {
  return ["/usr/local/bin", join(home, ".local", "libexec", "u7agent")];
}

/** 信頼ディレクトリで解決したラッパーの実パス。無ければ undefined (bash は実行しない)。 */
export function resolveLandlockWrapper(dirs = landlockWrapperDirs()): string | undefined {
  return resolveTrustedExecutable(LANDLOCK_WRAPPER_NAME, dirs);
}

/**
 * `/tmp` とホーム配下のキャッシュ、デバイスファイル。ワークスペースに依らず全実行で許可する。
 * `2>/dev/null` と `mktemp` / パッケージマネージャーのキャッシュを塞がないためで、`$HOME` 全体は許可しない。
 */
export function fixedLandlockWriteRoots(home = homedir()): LandlockWriteRoot[] {
  return [
    { path: "/tmp" },
    { path: join(home, ".cache"), create: true },
    { path: join(home, ".npm"), create: true },
    { path: join(home, ".local", "share", "pnpm"), create: true },
    { path: "/dev/null" },
    { path: "/dev/shm" },
  ];
}

/**
 * ラッパーへ渡す制御変数。作業フォルダの環境変数 (`U7AGENT_*` は注入不可) より後に重ねて上書きさせない。
 * 値は JSON で渡す (パスに改行や空白があっても壊れない)。
 */
export function landlockRulesEnv(input: {
  shell: string;
  roots: readonly LandlockWriteRoot[];
}): Record<string, string> {
  return {
    U7AGENT_LANDLOCK_SHELL: input.shell,
    U7AGENT_LANDLOCK_RULES: JSON.stringify(
      input.roots.map((root) => ({ path: root.path, create: root.create === true })),
    ),
    U7AGENT_LANDLOCK_MIN_ABI: String(LANDLOCK_MIN_ABI),
  };
}

function unavailable(
  reason: NonNullable<SandboxLandlockStatus["reason"]>,
  abi: number | null = null,
): SandboxLandlockStatus {
  return { state: "unavailable", abi, minAbi: LANDLOCK_MIN_ABI, reason };
}

/**
 * ラッパーの `--abi` を実行して診断する。カーネルが対応しないときはラッパーが `0` を返し、
 * 実行に失敗したとき (期限超過・異常終了・契約外の出力) は利用不可として扱う。
 */
export function probeLandlockStatus(wrapper: string | undefined): Promise<SandboxLandlockStatus> {
  if (!wrapper) return Promise.resolve(unavailable("wrapper_missing"));
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const finish = (status: SandboxLandlockStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    const child = spawn(wrapper, ["--abi"], {
      env: runtimeProbeEnv(RUNTIME_PROBE_PATH_DIRS),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(unavailable("probe_failed"));
    }, LANDLOCK_PROBE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", () => {});
    child.on("error", () => finish(unavailable("probe_failed")));
    child.on("close", (code) => {
      if (code !== 0) return finish(unavailable("probe_failed"));
      const abi = Number.parseInt(stdout.trim(), 10);
      if (!Number.isInteger(abi) || abi < 0) return finish(unavailable("probe_failed"));
      if (abi === 0) return finish(unavailable("unsupported"));
      if (abi < LANDLOCK_MIN_ABI) return finish(unavailable("abi_unsupported", abi));
      return finish({ state: "enabled", abi, minAbi: LANDLOCK_MIN_ABI });
    });
  });
}

/** bash を実行できない理由の分類を、モデルと利用者へ出す 1 行の説明にする。生の出力は含めない */
export function landlockUnavailableMessage(status: SandboxLandlockStatus): string {
  switch (status.reason) {
    case "wrapper_missing":
      return "Landlock のラッパーが見つかりません (イメージの /usr/local/bin/u7agent-landlock、dev は pnpm dev が配置)";
    case "unsupported":
      return "このカーネルは Landlock に対応していません (Linux 6.2 以上が必要です)";
    case "abi_unsupported":
      return `Landlock ABI ${status.abi ?? "不明"} は ${status.minAbi} 未満です (Linux 6.2 以上が必要です)`;
    default:
      return "Landlock の診断に失敗しました (設定 → ランタイム の接続状態を確認してください)";
  }
}
