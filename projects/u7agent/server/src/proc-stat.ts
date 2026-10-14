/**
 * `/proc` からプロセスの素性を読む。PID の再利用を起動時刻で見分ける判定に使う。
 * 「終了済み」と「不明」を呼び出し側が区別できるようにする: プロセスが居ない (ENOENT) ときだけ
 * undefined を返し、EACCES / EMFILE などの読み取り失敗は投げる。読めないことを「居ない」と
 * 取り違えると、生存中の呼び出しの置き場を回収してしまう。
 */
import { readFile } from "node:fs/promises";

/** `/proc/<pid>/stat` の 1 行。comm は括弧を含み得るので、最後の `)` 以降だけをフィールドへ割る */
export async function statFields(pid: number): Promise<string[] | undefined> {
  let text: string;
  try {
    text = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return text.slice(text.lastIndexOf(")") + 2).split(" ");
}

/** 起動時刻 (epoch ms)。プロセスが居なければ undefined、居るが判定できなければ 0 */
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

/**
 * 起動時刻を「不明は 0」へ畳んだ形。プロセスの消滅と読み取り失敗を区別せず、観測の前例
 * (server/src/sandbox/process-scan.ts) と同じ扱いにする。
 */
export async function processStartedAtMsOrUnknown(pid: number): Promise<number> {
  return (await processStartedAtMs(pid).catch(() => undefined)) ?? 0;
}

/**
 * 読み取り失敗を「不明」へ畳んだ形。待受の観測 (server/src/sandbox/process-scan.ts) は
 * 読めないプロセスの情報を欠いたまま残りを返す契約なので、例外を投げない方を選ぶ。
 */
export async function statFieldsOrUnknown(pid: number): Promise<string[] | undefined> {
  return statFields(pid).catch(() => undefined);
}
