// 枠の引き継ぎの途中で落ちた呼び出しを再現するためのホルダー (テストからのみ起動する)。
// 引数: <slot の置き場> <終了済み所有者の pid>。その所有者の生存確認で自分を SIGKILL する。
import { acquireConcurrencySlot } from "../src/browser/concurrency";
import { processStartedAtMs } from "../src/proc-stat";

const [root, endedPid] = process.argv.slice(2);
if (!root || !endedPid) throw new Error("usage: browser-slot-kill.ts <root> <ended-pid>");
await acquireConcurrencySlot({
  root,
  readStartedAt: async (pid) => {
    if (pid === Number(endedPid)) process.kill(process.pid, "SIGKILL");
    return processStartedAtMs(pid);
  },
});
process.stdout.write("admitted\n");
