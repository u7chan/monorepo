/**
 * 照合したプロセスへ、pid の再利用を跨がずに signal を送る。
 * 数値の pid は照合と送信の間に別のプロセスを指し得るので、Linux の pidfd を掴んでから送る。
 * 掴めない環境 (Linux 以外、node:ffi の無いビルド) では参照を返さず、呼び出し側は送らない。
 */
import { closeSync } from "node:fs";
import { constants } from "node:os";
import { loadLibc } from "./libc";

export type SignalOutcome = "sent" | "gone" | "denied";

export interface ProcessRef {
  /** 掴んだプロセスへ送る。そのプロセスが終わっていれば gone、送れなければ denied */
  send(signal: NodeJS.Signals): SignalOutcome;
  close(): void;
}

const ESRCH = 3;

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
