/**
 * 共有の除外名の設定ストア。DB の読み書き・検証・実効値の解決をここに閉じ、プレビューと公開が同じ実効値を取る
 * ようにする（見えたものと上がるものをずらさない）。サンドボックスは設定を持たないため、実効値は要求ごとに渡す。
 */
import type { AppDb } from "./app-db";
import { httpError, messageFor } from "./http";
import {
  DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES,
  SHARED_CONTENT_EXCLUDE_MAX_NAME_LENGTH,
  SHARED_CONTENT_EXCLUDE_MAX_NAMES,
  normalizeSharedContentExcludeNames,
  resolveSharedContentExcludeNames,
  validateSharedContentExcludeNames,
} from "./shared-content-rules";
import type { SharedContentExclusionsResponse } from "./schema";

export interface SharedContentExclusionsOptions {
  db: AppDb;
}

export function createSharedContentExclusions({ db }: SharedContentExclusionsOptions) {
  /** 応答の共通形。excludeNames は常に実効値で、未設定と明示空は overridden で区別する */
  const responseOf = (stored: string[] | undefined): SharedContentExclusionsResponse => ({
    excludeNames: resolveSharedContentExcludeNames(stored),
    defaultExcludeNames: [...DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES],
    overridden: stored !== undefined,
    maxNames: SHARED_CONTENT_EXCLUDE_MAX_NAMES,
    maxNameLength: SHARED_CONTENT_EXCLUDE_MAX_NAME_LENGTH,
  });

  return {
    /** 保存行（未設定は undefined）。DB の失敗は 503 として投げる */
    read(): string[] | undefined {
      return db.readSharedContentExcludeNames();
    },

    /**
     * プレビューと公開が使う実効値。DB が使えないときだけ既定へ落として警告を出す
     * （空へ倒すと、利用者が除外したつもりの名前が公開対象へ戻る）。
     */
    effectiveNames(): string[] {
      try {
        return resolveSharedContentExcludeNames(db.readSharedContentExcludeNames());
      } catch (error) {
        console.warn(`[u7agent] 共有の除外名を読めません: ${messageFor(error)}`);
        return [...DEFAULT_SHARED_CONTENT_EXCLUDE_NAMES];
      }
    },

    response(): SharedContentExclusionsResponse {
      return responseOf(db.readSharedContentExcludeNames());
    },

    /** 正規化して検証し、上書きとして保存する。不正は 400（画面は理由をそのまま出す） */
    save(names: readonly string[]): SharedContentExclusionsResponse {
      const normalized = normalizeSharedContentExcludeNames(names);
      const reason = validateSharedContentExcludeNames(normalized);
      if (reason) throw httpError(400, reason);
      db.saveSharedContentExcludeNames(normalized);
      return responseOf(normalized);
    },

    /** 保存行を消して未設定へ戻す（既定名を保存し直さない） */
    reset(): SharedContentExclusionsResponse {
      db.resetSharedContentExcludeNames();
      return responseOf(undefined);
    },
  };
}

export type SharedContentExclusions = ReturnType<typeof createSharedContentExclusions>;
