import { deleteProviderUsage, saveProviderSnapshot, type DatabaseHandle } from "../db";
import { ProviderError, type ProviderSnapshot } from "../providers/types";
import type { Sampler } from "../sampler";
import type { OpenCodeAuth, OpenCodeKeyState, StoredOpenCodeKey } from "./auth";

export type OpenCodeAuthState = OpenCodeKeyState;

export type OpenCodeSaveResult =
  | { ok: true; state: OpenCodeAuthState }
  | { ok: false; reason: "invalid_key" | "unavailable" };

export type OpenCodeApi = {
  auth: () => OpenCodeAuthState;
  save: (apiKey: string) => Promise<OpenCodeSaveResult>;
  clear: () => Promise<void>;
};

/** 1 KiB の body 制限に収まる上限。現実のキーはこれより十分短い。 */
const MAX_KEY_LENGTH = 512;

/** 改行や制御文字を Authorization ヘッダーへ通さない。空白入りはコピー時の混入として弾く。 */
export function normalizeApiKey(value: string): string | null {
  const key = value.trim();

  if (key === "" || key.length > MAX_KEY_LENGTH) {
    return null;
  }

  for (const char of key) {
    const code = char.codePointAt(0) ?? 0;

    if (code <= 0x20 || code === 0x7f) {
      return null;
    }
  }

  return key;
}

export function createOpenCodeApi(options: {
  auth: OpenCodeAuth;
  db: DatabaseHandle;
  sampler: Pick<Sampler, "exclusive">;
  fetchUsage: (apiKey: string) => Promise<ProviderSnapshot>;
}): OpenCodeApi {
  return {
    auth: () => options.auth.state(),
    async save(apiKey) {
      const key = normalizeApiKey(apiKey);

      if (key === null) {
        return { ok: false, reason: "invalid_key" };
      }

      let snapshot: ProviderSnapshot;

      try {
        snapshot = await options.fetchUsage(key);
      } catch (error) {
        // 通信断を「キーが違う」と出すと、正しいキーを入れ直し続けることになる。
        return {
          ok: false,
          reason: error instanceof ProviderError && error.code === "config" ? "invalid_key" : "unavailable",
        };
      }

      let savedAt: number | null = null;

      // 検証済みの snapshot も一緒に書く。直後の再取得が一時的に失敗しても、保存したキーの値が出る。
      await options.sampler.exclusive(() => {
        const previous = options.auth.read();

        options.auth.save(key);
        savedAt = options.auth.state().savedAt;

        try {
          saveProviderSnapshot(options.db, snapshot);
        } catch (error) {
          // DB に書けないなら、503 を返したのにキーだけ変わる状態を残さない。
          restoreQuietly(options.auth, previous);

          throw error;
        }
      });

      return { ok: true, state: { configured: true, savedAt } };
    },
    async clear() {
      // 直前の取得が古い snapshot を書き戻さないよう、削除は排他区間で行う。
      await options.sampler.exclusive(() => {
        const previous = options.auth.read();

        options.auth.clear();

        try {
          deleteProviderUsage(options.db, "opencode-go");
        } catch (error) {
          restoreQuietly(options.auth, previous);

          throw error;
        }
      });
    },
  };
}

/** 元の失敗を 503 として返すため、巻き戻し自体の失敗は握る。次の登録・解除で上書きできる。 */
function restoreQuietly(auth: OpenCodeAuth, stored: StoredOpenCodeKey | null): void {
  try {
    auth.restore(stored);
  } catch {
    // 何もしない。
  }
}
