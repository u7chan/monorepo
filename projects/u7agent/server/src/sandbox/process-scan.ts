/**
 * 待受ソケットと所有プロセスの観測。serve の所有者照合 (起動の確認と停止対象の特定) に使う。
 * bash 実行は Landlock の ptrace 制限で他ドメインの `/proc/<pid>/fd` を読めない (自分の子孫は読める) ため、
 * この走査だけは制限の外にいる service 本体で行う。設計は docs/sandbox.md の serve の節を正とする。
 */
import { readFile, readdir, readlink } from "node:fs/promises";
import { processStartedAtMsOrUnknown, statFieldsOrUnknown } from "../proc-stat";
import type {
  SandboxListenerAddressScope,
  SandboxListenerPort,
  SandboxListenerProcess,
  SandboxListenerRangeScan,
  SandboxListenerScan,
} from "./protocol";

/** 1 回の祖先の探索でたどる親の上限。循環や壊れた /proc でも止まるようにする */
const MAX_ANCESTORS = 32;

/** `/proc/net/tcp{,6}` の LISTEN 行 1 件。`address` は parts[1] のアドレス部 (16 進) */
interface ListenEntry {
  port: number;
  inode: number;
  address: string;
}

/**
 * 16 進のアドレスを network order のバイト列にする。IPv4 は 32 bit、IPv6 は 32 bit ごとに
 * little-endian で並ぶため、8 桁ずつを逆順に読む。解釈できない長さ・文字は null。
 */
function addressBytes(hex: string): number[] | null {
  if (hex.length % 8 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes: number[] = [];
  for (let offset = 0; offset < hex.length; offset += 8) {
    const word = hex.slice(offset, offset + 8);
    for (let index = 6; index >= 0; index -= 2) bytes.push(Number.parseInt(word.slice(index, index + 2), 16));
  }
  return bytes;
}

/**
 * 待受アドレスの種別。v4-mapped は先頭 10 バイトが 0 で `ff ff` が続く形なので、IPv4 へ
 * 正規化してから判定する (同じ 127.0.0.1 でも tcp と tcp6 で表記が違うため)。
 */
export function listenAddressScope(hex: string): SandboxListenerAddressScope {
  const bytes = addressBytes(hex);
  if (!bytes) return "other";
  const v4Mapped =
    bytes.length === 16 && bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const normalized = v4Mapped ? bytes.slice(12) : bytes;
  if (normalized.length === 4) {
    if (normalized.every((byte) => byte === 0)) return "any";
    return normalized[0] === 127 ? "loopback" : "other";
  }
  if (normalized.length !== 16) return "other";
  if (normalized.every((byte) => byte === 0)) return "any";
  return normalized.slice(0, 15).every((byte) => byte === 0) && normalized[15] === 1 ? "loopback" : "other";
}

/**
 * `/proc/net/tcp` と `/proc/net/tcp6` を 1 度ずつ読み、`keep` を通るポートの LISTEN 行を返す。
 * 同じ inode は 1 件に畳み、inode の昇順に並べる。
 */
async function listenEntries(keep: (port: number) => boolean): Promise<ListenEntry[]> {
  const entries = new Map<number, ListenEntry>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const line of text.split("\n").slice(1)) {
      const parts = line.trim().split(/ +/);
      // st (parts[3]) が 0A = LISTEN の行だけを見る
      if (parts.length < 10 || parts[3] !== "0A") continue;
      const [address = "", portHex = ""] = (parts[1] || "").split(":");
      const port = Number.parseInt(portHex, 16);
      if (!Number.isInteger(port) || !keep(port)) continue;
      const inode = Number(parts[9]);
      if (Number.isInteger(inode) && inode > 0) entries.set(inode, { port, inode, address });
    }
  }
  return [...entries.values()].sort((a, b) => a.inode - b.inode);
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
 * 指定ポートの待受 inode・アドレス種別と、`scan` が true のときだけ所有プロセスを返す。
 * `scan` を省いた状態表示では重い fd 走査をせず、停止と起動の確認でだけ走査する。
 */
export async function scanListeners(port: number, options: { scan: boolean }): Promise<SandboxListenerScan> {
  const entries = await listenEntries((candidate) => candidate === port);
  const inodes = entries.map((entry) => entry.inode);
  const addressScopes = entries.map((entry) => listenAddressScope(entry.address));
  if (!options.scan || inodes.length === 0) return { inodes, addressScopes, listener: null };
  const wanted = inodes.map((inode) => `socket:[${inode}]`);
  const pid = await listenerPid(wanted);
  if (pid === null) return { inodes, addressScopes, listener: null };
  const listener: SandboxListenerProcess = {
    pid,
    startedAt: await processStartedAtMsOrUnknown(pid),
    inodes,
    ancestors: await ancestorsOf(pid),
  };
  return { inodes, addressScopes, listener };
}

/**
 * `from`..`to` の待受ポート一覧。待受の無いポートは返さず、fd 走査 (所有 PID の特定) もしないため、
 * 状態表示のポーリングに使える。
 */
export async function scanListenerRange(from: number, to: number): Promise<SandboxListenerRangeScan> {
  const entries = await listenEntries((port) => port >= from && port <= to);
  const ports = new Map<number, SandboxListenerPort>();
  for (const entry of entries) {
    const bucket = ports.get(entry.port) ?? { port: entry.port, inodes: [] };
    bucket.inodes.push(entry.inode);
    ports.set(entry.port, bucket);
  }
  return { ports: [...ports.values()].sort((a, b) => a.port - b.port) };
}
