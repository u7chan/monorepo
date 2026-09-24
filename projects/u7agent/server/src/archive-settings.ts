/**
 * アーカイブ除外名の設定ストア。DB の読み書き・検証・実効値の解決をここに閉じ、
 * health・download / check が同じ実効値を取るようにする（判定のずれを作らない）。
 * サンドボックスは設定を持たないため、実効値はリクエストごとに query で渡す（docs/sandbox-api.md）。
 */
import type { AppDb } from "./app-db";
import {
  ARCHIVE_EXCLUDE_MAX_NAME_LENGTH,
  ARCHIVE_EXCLUDE_MAX_NAMES,
  DEFAULT_ARCHIVE_EXCLUDE_NAMES,
  normalizeArchiveExcludeNames,
  resolveArchiveExcludeNames,
  validateArchiveExcludeNames,
} from "./archive-rules";
import { httpError, messageFor } from "./http";
import type { ArchiveSettingsResponse } from "./schema";

export interface ArchiveSettingsOptions {
  db: AppDb;
}

export function createArchiveSettings({ db }: ArchiveSettingsOptions) {
  /** 応答の共通形。excludeNames は常に実効値で、未設定と明示空は overridden で区別する */
  const responseOf = (stored: string[] | undefined): ArchiveSettingsResponse => ({
    excludeNames: resolveArchiveExcludeNames(stored),
    defaultExcludeNames: [...DEFAULT_ARCHIVE_EXCLUDE_NAMES],
    overridden: stored !== undefined,
    maxNames: ARCHIVE_EXCLUDE_MAX_NAMES,
    maxNameLength: ARCHIVE_EXCLUDE_MAX_NAME_LENGTH,
  });

  return {
    /** 保存行（未設定は undefined）。DB の失敗は 503 として投げる */
    read(): string[] | undefined {
      return db.readArchiveExcludeNames();
    },

    /**
     * health と download / check が使う実効値。用途は行の出し分けと走査なので、DB が使えないときだけ
     * 既定へ落として警告を出す（health を 500 にしない。空へ倒すと除外なしの ZIP を作れてしまう）。
     */
    effectiveNames(): string[] {
      try {
        return resolveArchiveExcludeNames(db.readArchiveExcludeNames());
      } catch (error) {
        console.warn(`[u7agent] アーカイブの除外名を読めません: ${messageFor(error)}`);
        return [...DEFAULT_ARCHIVE_EXCLUDE_NAMES];
      }
    },

    response(): ArchiveSettingsResponse {
      return responseOf(db.readArchiveExcludeNames());
    },

    /** 正規化して検証し、上書きとして保存する。不正は 400（画面は理由をそのまま出す） */
    save(names: readonly string[]): ArchiveSettingsResponse {
      const normalized = normalizeArchiveExcludeNames(names);
      const reason = validateArchiveExcludeNames(normalized);
      if (reason) throw httpError(400, reason);
      db.saveArchiveExcludeNames(normalized);
      return responseOf(normalized);
    },

    /** 保存行を消して未設定へ戻す（既定名を保存し直さない） */
    reset(): ArchiveSettingsResponse {
      db.resetArchiveExcludeNames();
      return responseOf(undefined);
    },
  };
}

export type ArchiveSettings = ReturnType<typeof createArchiveSettings>;
