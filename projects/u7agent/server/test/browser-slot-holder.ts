// 同時実行の入場制御をプロセスをまたいで検証するためのホルダー (テストからのみ起動する)。
// 引数: <slot の置き場> <上限> <保持 ms>。/proc は使わず、自分の pid と起動時刻で枠を取る。
import { acquireConcurrencySlot, ConcurrencyLimitError } from "../src/browser/concurrency";

const [root, limit, holdMs] = process.argv.slice(2);
if (!root || !limit) throw new Error("usage: browser-slot-holder.ts <root> <limit> <hold-ms>");
try {
  const slot = await acquireConcurrencySlot({ root, limit: Number(limit) });
  process.stdout.write("acquired\n");
  await new Promise((done) => setTimeout(done, Number(holdMs)));
  await slot.release();
  process.stdout.write("released\n");
} catch (error) {
  if (error instanceof ConcurrencyLimitError) {
    process.stdout.write("limit\n");
  } else {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
