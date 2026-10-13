/**
 * OAuth サインイン (SIWC) が Pi へ渡す installation 固有の UUID。SDK はログインのたびに同じ
 * `urn:uuid:<id>` を agent host ID として送る契約なので、`auth.json` と同じ agent dir 配下へ保存して
 * プロセスを再起動しても同じ値を返す。値は秘密情報ではないが、他人と共有される ID なので 0600 で置く。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { messageFor } from "./http";

/** 相対の保存先 (`<agentDir>/u7agent/device-id`)。session store と同じく agent dir 配下に併置する */
export const DEVICE_ID_PATH = "u7agent/device-id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeviceIdStore {
  /**
   * 保存値を返す。無い / 壊れているときは新規に作って保存し、書けないときもこのプロセスでは同じ値を返し続ける
   * (再起動で別の ID になる方がログインできないよりましなので、失敗では投げない)。
   */
  getOrCreate(): string;
}

export function createDeviceIdStore(path: string, log: (message: string) => void = () => {}): DeviceIdStore {
  let known: string | null = null;
  return {
    getOrCreate(): string {
      if (known) return known;
      const stored = readDeviceId(path, log);
      known = stored ?? randomUUID();
      // 壊れたファイルはここで上書きする。読み取れた値はそのまま使う (書き直さない)
      if (!stored) writeDeviceId(path, known, log);
      return known;
    },
  };
}

function readDeviceId(path: string, log: (message: string) => void): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch (error) {
    // 初回はファイルが無いのが正常。それ以外の失敗だけを記録する (どちらも新規作成へ進む)
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`device id read failed: ${messageFor(error)}`);
    return null;
  }
  if (UUID_PATTERN.test(text)) return text;
  // SDK は UUID 以外を拒否してログインを止めるため、壊れた値は作り直す
  log("device id file is invalid; a new id is generated");
  return null;
}

function writeDeviceId(path: string, value: string, log: (message: string) => void): void {
  const temporary = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // rename で置き換える (別プロセスが同じファイルを読んでいる最中に空の内容を見せないため)
    writeFileSync(temporary, `${value}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    log(`device id write failed: ${messageFor(error)}`);
    // 後始末で落ちない (親がディレクトリでない、などで rm も失敗し得る)
    try {
      rmSync(temporary, { force: true });
    } catch {
      // 消せない一時ファイルは残るだけで、値はこのプロセスのメモリに保つ
    }
  }
}
