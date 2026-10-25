import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeviceIdStore = {
  /** 保存値を返す。無い / 壊れているときは作って保存し、書けなくても同じ値を使い続ける。 */
  getOrCreate: () => string;
};

/**
 * SiWC が Pi へ渡す installation 固有の UUID。再起動で変わると同じ端末として扱われないため永続化する。
 * 秘密ではないが、他の利用者と共有される ID なので 0600 で置く。
 */
export function createDeviceIdStore(path: string, log: (message: string) => void = () => {}): DeviceIdStore {
  let known: string | null = null;

  return {
    getOrCreate() {
      if (known) {
        return known;
      }

      const stored = readDeviceId(path, log);
      const value = stored ?? randomUUID();

      known = value;

      if (!stored) {
        writeDeviceId(path, value, log);
      }

      return value;
    },
  };
}

function readDeviceId(path: string, log: (message: string) => void): string | null {
  let text: string;

  try {
    text = readFileSync(path, "utf8").trim();
  } catch (error) {
    // 初回はファイルが無いのが正常。他の失敗だけを残す（どちらも作り直しへ進む）。
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log("device id read failed");
    }

    return null;
  }

  if (UUID_PATTERN.test(text)) {
    return text;
  }

  log("device id file is invalid; a new id is generated");

  return null;
}

function writeDeviceId(path: string, value: string, log: (message: string) => void): void {
  const temporary = `${path}.tmp`;

  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // rename で置き換える。読み手に空のファイルを見せないため。
    writeFileSync(temporary, `${value}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    log("device id write failed");

    try {
      rmSync(temporary, { force: true });
    } catch {
      // 消せない一時ファイルは残るだけ。値はこのプロセスのメモリに保つ。
    }
  }
}
