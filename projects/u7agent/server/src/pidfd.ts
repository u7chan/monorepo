/**
 * 照合したプロセスへ、pid の再利用を跨がずに signal を送る。
 * 数値の pid は照合と送信の間に別のプロセスを指し得るので、Linux の pidfd を掴んでから送る。
 * 掴めない環境 (Linux 以外、node:ffi の無いビルド) では参照を返さず、呼び出し側は送らない。
 */
import { closeSync } from "node:fs";
import { constants } from "node:os";

export type SignalOutcome = "sent" | "gone" | "denied";

export interface ProcessRef {
  /** 掴んだプロセスへ送る。そのプロセスが終わっていれば gone、送れなければ denied */
  send(signal: NodeJS.Signals): SignalOutcome;
  close(): void;
}

interface Libc {
  pidfdOpen: (pid: number) => number;
  pidfdSendSignal: (fd: number, signal: number) => number;
  errno: () => number;
  /** dlopen の結果。閉じると関数が無効になるので、参照を保持する */
  handle: unknown;
}

const ESRCH = 3;

let libc: Libc | null | undefined;
let loading: Promise<Libc | null> | undefined;

async function loadLibc(): Promise<Libc | null> {
  if (libc !== undefined) return libc;
  if (process.platform !== "linux") return (libc = null);
  loading ??= (async () => {
    // 起動のたびに出る experimental の警告で、本当の警告が埋もれる。読み込みの間だけ止め、直後に戻す
    const emitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      if (String(warning).includes("FFI is an experimental feature")) return;
      (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      const ffi = await import("node:ffi");
      const handle = ffi.dlopen("libc.so.6", {
        pidfd_open: { arguments: ["int32", "uint32"], return: "int32" },
        pidfd_send_signal: { arguments: ["int32", "int32", "pointer", "uint32"], return: "int32" },
        __errno_location: { arguments: [], return: "pointer" },
      });
      const errnoPointer = handle.functions.__errno_location();
      return {
        pidfdOpen: (pid) => handle.functions.pidfd_open(pid, 0),
        pidfdSendSignal: (fd, signal) => handle.functions.pidfd_send_signal(fd, signal, null, 0),
        errno: () => ffi.getInt32(errnoPointer),
        handle,
      } satisfies Libc;
    } catch {
      // FFI の無いビルド。数値の pid へ落とすと、照合の直後に再利用された相手へ送り得る
      return null;
    } finally {
      process.emitWarning = emitWarning;
    }
  })();
  libc = await loading;
  return libc;
}

/** `/proc` で照合したあとに開く。ここで開いた参照は、あとで pid が再利用されても元のプロセスを指す */
export async function openProcessRef(pid: number): Promise<ProcessRef | undefined> {
  const lib = await loadLibc();
  if (!lib) return undefined;
  const fd = lib.pidfdOpen(pid);
  if (fd < 0) return undefined;
  let closed = false;
  return {
    send(signal) {
      const number = constants.signals[signal];
      if (number === undefined) return "denied";
      if (lib.pidfdSendSignal(fd, number) === 0) return "sent";
      return lib.errno() === ESRCH ? "gone" : "denied";
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } catch {
        // 既に閉じている。掴んだプロセスの後片付けはこれ以上無い
      }
    },
  };
}
