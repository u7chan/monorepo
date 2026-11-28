/**
 * `node:ffi` で libc の関数を読む。FFI の無いビルドでは null を返し、呼び出し側は安全側へ倒す。
 * 警告は読み込みの間だけ止める。起動のたびに出ると、本当の警告が埋もれる。
 */
interface Libc {
  pidfdOpen: (pid: number) => number;
  pidfdSendSignal: (fd: number, signal: number) => number;
  flock: (fd: number, operation: number) => number;
  errno: () => number;
  /** dlopen の結果。閉じると関数が無効になるので、参照を保持する */
  handle: unknown;
}

let libc: Libc | null | undefined;
let loading: Promise<Libc | null> | undefined;

export async function loadLibc(): Promise<Libc | null> {
  if (libc !== undefined) return libc;
  if (process.platform !== "linux") return (libc = null);
  loading ??= (async () => {
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
        flock: { arguments: ["int32", "int32"], return: "int32" },
        __errno_location: { arguments: [], return: "pointer" },
      });
      const errnoPointer = handle.functions.__errno_location();
      return {
        pidfdOpen: (pid) => handle.functions.pidfd_open(pid, 0),
        pidfdSendSignal: (fd, signal) => handle.functions.pidfd_send_signal(fd, signal, null, 0),
        flock: (fd, operation) => handle.functions.flock(fd, operation),
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
