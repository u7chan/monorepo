/**
 * `/proc` からプロセスの素性を読む。PID の再利用を起動時刻で見分ける判定に使う。
 * 「終了済み」と「不明」を呼び出し側が区別できるよう、プロセスが居なければ undefined、
 * 居るが判定できないときは 0 を返す。
 */
import { readFile } from "node:fs/promises";

/** `/proc/<pid>/stat` の 1 行。comm は括弧を含み得るので、最後の `)` 以降だけをフィールドへ割る */
export async function statFields(pid: number): Promise<string[] | undefined> {
  const text = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
  if (!text) return undefined;
  return text.slice(text.lastIndexOf(")") + 2).split(" ");
}

/** プロセスの起動時刻 (epoch ms)。プロセスが居なければ undefined、判定できなければ 0 */
export async function processStartedAtMs(pid: number): Promise<number | undefined> {
  const fields = await statFields(pid);
  if (!fields) return undefined;
  const startTicks = Number(fields[19]);
  if (!Number.isFinite(startTicks)) return 0;
  const bootText = await readFile("/proc/stat", "utf8").catch(() => "");
  const bootSeconds = Number(/btime ([0-9]+)/.exec(bootText)?.[1]);
  if (!Number.isFinite(bootSeconds)) return 0;
  // USER_HZ は 100 固定 (カーネルの設定で変えられる値ではない)
  return bootSeconds * 1000 + Math.round(startTicks * 10);
}
