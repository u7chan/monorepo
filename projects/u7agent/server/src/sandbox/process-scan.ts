/**
 * 待受ソケットと所有プロセスの観測。serve の所有者照合 (起動の確認と停止対象の特定) に使う。
 * bash 実行は Landlock の ptrace 制限で他ドメインの `/proc/<pid>/fd` を読めない (自分の子孫は読める) ため、
 * この走査だけは制限の外にいる service 本体で行う。設計は docs/sandbox.md の serve の節を正とする。
 */
import { readFile, readdir, readlink } from "node:fs/promises";
import { processStartedAtMsOrUnknown, statFieldsOrUnknown } from "../proc-stat";
import type { SandboxListenerProcess, SandboxListenerScan } from "./protocol";

/** 1 回の祖先の探索でたどる親の上限。循環や壊れた /proc でも止まるようにする */
const MAX_ANCESTORS = 32;

/** `/proc/net/tcp` の待受行から inode を取り出す。行末のローカルアドレスは 16 進のアドレス + ポート */
async function listenInodes(port: number): Promise<number[]> {
  const suffix = `:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const inodes = new Set<number>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const line of text.split("\n").slice(1)) {
      const parts = line.trim().split(/ +/);
      // st (parts[3]) が 0A = LISTEN の行だけを見る
      if (parts.length < 10 || parts[3] !== "0A") continue;
      if (!(parts[1] || "").endsWith(suffix)) continue;
      const inode = Number(parts[9]);
      if (Number.isInteger(inode) && inode > 0) inodes.add(inode);
    }
  }
  return [...inodes].sort((a, b) => a - b);
}

/** 自身から親をたどった PID (自身を含む)。読めないプロセスでは探索を打ち切る (観測済みの情報は返す) */
async function ancestorsOf(pid: number): Promise<number[]> {
  const chain: number[] = [];
  let current = pid;
  while (current > 1 && chain.length < MAX_ANCESTORS) {
    chain.push(current);
    const fields = await statFieldsOrUnknown(current);
    const parent = Number(fields?.[1]);
    current = Number.isInteger(parent) && parent > 0 ? parent : 0;
  }
  return chain;
}

/**
 * 待受 inode を持つプロセスの PID。readlink できないプロセス (他ユーザー・終了済み) は飛ばす。
 * `/proc/<pid>/fd` の読み取りは Landlock 適用プロセスでは EACCES になるため、この関数は service 本体でだけ呼ぶ。
 */
async function listenerPid(wanted: readonly string[]): Promise<number | null> {
  const entries = await readdir("/proc").catch(() => [] as string[]);
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const fdDir = `/proc/${entry}/fd`;
    const fds = await readdir(fdDir).catch(() => [] as string[]);
    for (const fd of fds) {
      const link = await readlink(`${fdDir}/${fd}`).catch(() => "");
      if (link && wanted.includes(link)) return Number(entry);
    }
  }
  return null;
}

/**
 * 指定ポートの待受 inode と、`scan` が true のときだけ所有プロセスを返す。
 * `scan` を省いた状態表示では重い fd 走査をせず、停止と起動の確認でだけ走査する。
 */
export async function scanListeners(port: number, options: { scan: boolean }): Promise<SandboxListenerScan> {
  const inodes = await listenInodes(port);
  if (!options.scan || inodes.length === 0) return { inodes, listener: null };
  const wanted = inodes.map((inode) => `socket:[${inode}]`);
  const pid = await listenerPid(wanted);
  if (pid === null) return { inodes, listener: null };
  const listener: SandboxListenerProcess = {
    pid,
    startedAt: await processStartedAtMsOrUnknown(pid),
    inodes,
    ancestors: await ancestorsOf(pid),
  };
  return { inodes, listener };
}
