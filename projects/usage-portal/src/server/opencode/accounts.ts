import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isOpenCodeAccountIcon, type OpenCodeAccountIcon } from "../../shared/opencode-account";

export const OPENCODE_ACCOUNTS_FILE = "opencode-accounts.json";
const FILE_VERSION = 1;

/** ファイルに残る形。`apiKey` はここから外へ出さない。 */
export type OpenCodeAccountRecord = {
  id: string;
  name: string;
  icon: OpenCodeAccountIcon;
  apiKey: string;
  savedAt: number;
};

export type OpenCodeAccount = Omit<OpenCodeAccountRecord, "apiKey">;

export type OpenCodeAccounts = {
  list: () => OpenCodeAccount[];
  get: (id: string) => OpenCodeAccount | null;
  create: (input: { name: string; icon: OpenCodeAccountIcon; apiKey: string }) => OpenCodeAccount;
  update: (id: string, patch: { name?: string; icon?: OpenCodeAccountIcon; apiKey?: string }) => OpenCodeAccount | null;
  remove: (id: string) => boolean;
  apiKey: (id: string) => string | null;
  /** DB の更新に失敗したとき、ファイルを操作前の配列へ戻すために使う。 */
  read: () => OpenCodeAccountRecord[] | null;
  restore: (records: readonly OpenCodeAccountRecord[] | null) => void;
};

/** アカウントの正はこの 1 ファイル。配列の順がそのまま画面の並びになる。 */
export function openCodeSourceId(accountId: string): string {
  return `opencode-go:${accountId}`;
}

/**
 * キーは秘密なので、Codex の `auth.json` と同じ `CREDENTIAL_DIR` に置く。
 * `DATA_DIR` は履歴のバックアップ対象で、秘密を混ぜたくない。
 */
export function createOpenCodeAccounts(options: {
  credentialDir: string;
  now?: () => number;
  log?: (message: string) => void;
}): OpenCodeAccounts {
  const path = join(options.credentialDir, OPENCODE_ACCOUNTS_FILE);
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(`[usage-portal] ${message}`));
  // 壊れたファイルは読むたびに 0 件になる。sampler の周期ごとに同じ警告を出さない。
  let warnedInvalidFile = false;

  function readOrEmpty(): OpenCodeAccountRecord[] {
    const records = readRecords(path);

    if (records === null) {
      if (!warnedInvalidFile && existsSync(path)) {
        warnedInvalidFile = true;
        log("opencode-accounts.json を読めないため、アカウント 0 件として扱います");
      }

      return [];
    }

    warnedInvalidFile = false;

    return records;
  }

  function write(records: readonly OpenCodeAccountRecord[]): void {
    writeRecords(path, records);
    warnedInvalidFile = false;
  }

  function list(): OpenCodeAccount[] {
    return readOrEmpty().map(toPublic);
  }

  return {
    list,
    get(id) {
      const record = readOrEmpty().find((candidate) => candidate.id === id);

      return record ? toPublic(record) : null;
    },
    create(input) {
      const records = readOrEmpty();
      const id = uniqueId(records);
      const record: OpenCodeAccountRecord = { id, ...input, savedAt: now() };

      write([...records, record]);

      return toPublic(record);
    },
    update(id, patch) {
      const records = readOrEmpty();
      const index = records.findIndex((candidate) => candidate.id === id);

      if (index === -1) {
        return null;
      }

      const current = records[index] as OpenCodeAccountRecord;
      const next: OpenCodeAccountRecord = { ...current, ...patch, savedAt: now() };
      const updated = records.map((record, position) => (position === index ? next : record));

      write(updated);

      return toPublic(next);
    },
    remove(id) {
      const records = readOrEmpty();
      const remaining = records.filter((record) => record.id !== id);

      if (remaining.length === records.length) {
        return false;
      }

      write(remaining);

      return true;
    },
    apiKey(id) {
      return readOrEmpty().find((record) => record.id === id)?.apiKey ?? null;
    },
    read() {
      return existsSync(path) ? readOrEmpty() : null;
    },
    restore(records) {
      if (records === null) {
        rmSync(path, { force: true });

        return;
      }

      write(records);
    },
  };
}

function toPublic(record: OpenCodeAccountRecord): OpenCodeAccount {
  return { id: record.id, name: record.name, icon: record.icon, savedAt: record.savedAt };
}

function uniqueId(records: readonly OpenCodeAccountRecord[]): string {
  for (;;) {
    const id = randomUUID();

    if (!records.some((record) => record.id === id)) {
      return id;
    }
  }
}

/** 壊れた JSON・未知の version・読めない要素は「0 件」として扱い、内容はログにも出さない。 */
function readRecords(path: string): OpenCodeAccountRecord[] | null {
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const { version, accounts } = parsed as Record<string, unknown>;

    if (version !== FILE_VERSION || !Array.isArray(accounts)) {
      return null;
    }

    const records = accounts.map(readRecord).filter((record) => record !== null);

    return records.length === accounts.length ? records : null;
  } catch {
    return null;
  }
}

function readRecord(value: unknown): OpenCodeAccountRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const { id, name, icon, apiKey, savedAt } = value as Record<string, unknown>;

  if (
    typeof id !== "string" ||
    id === "" ||
    typeof name !== "string" ||
    name === "" ||
    !isOpenCodeAccountIcon(icon) ||
    typeof apiKey !== "string" ||
    apiKey === "" ||
    typeof savedAt !== "number" ||
    !Number.isFinite(savedAt)
  ) {
    return null;
  }

  return { id, name, icon, apiKey, savedAt };
}

/**
 * 一時ファイルに書いてから rename する。直接上書きすると、書き込み途中の JSON を
 * sampler が読んだ瞬間にアカウントが消えたように見える。
 */
function writeRecords(path: string, records: readonly OpenCodeAccountRecord[]): void {
  const dir = dirname(path);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const temp = `${path}.tmp`;

  writeFileSync(temp, JSON.stringify({ version: FILE_VERSION, accounts: records }), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
