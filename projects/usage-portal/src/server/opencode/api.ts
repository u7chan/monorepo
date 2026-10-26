import {
  MAX_OPENCODE_ACCOUNTS,
  isOpenCodeAccountIcon,
  normalizeAccountName,
  normalizeApiKey,
  type OpenCodeAccountIcon,
} from "../../shared/opencode-account";
import { deleteProviderUsage, saveProviderSnapshot, type DatabaseHandle } from "../db";
import { ProviderError, type ProviderSnapshot } from "../providers/types";
import type { Sampler } from "../sampler";
import { openCodeSourceId, type OpenCodeAccount, type OpenCodeAccountRecord, type OpenCodeAccounts } from "./accounts";

export type OpenCodeApiError =
  | "invalid_name"
  | "invalid_icon"
  | "invalid_key"
  | "invalid_request"
  | "not_found"
  | "limit_reached"
  | "unavailable";

export type OpenCodeApiResult<T> = { ok: true; value: T } | { ok: false; error: OpenCodeApiError };

/** body の生の値。検証はこの module が持つ（route は形だけを見る）。 */
export type OpenCodeInput = { name?: unknown; icon?: unknown; apiKey?: unknown };

export type OpenCodeApi = {
  list: () => OpenCodeAccount[];
  create: (input: OpenCodeInput) => Promise<OpenCodeApiResult<OpenCodeAccount>>;
  update: (id: string, input: OpenCodeInput) => Promise<OpenCodeApiResult<OpenCodeAccount>>;
  remove: (id: string) => Promise<OpenCodeApiResult<null>>;
};

class AccountMissingError extends Error {}

class AccountLimitError extends Error {}

export function createOpenCodeApi(options: {
  accounts: OpenCodeAccounts;
  db: DatabaseHandle;
  sampler: Pick<Sampler, "exclusive">;
  fetchUsage: (apiKey: string) => Promise<ProviderSnapshot>;
}): OpenCodeApi {
  async function verifyKey(
    apiKey: string,
  ): Promise<{ ok: true; snapshot: ProviderSnapshot } | { ok: false; error: OpenCodeApiError }> {
    try {
      return { ok: true, snapshot: await options.fetchUsage(apiKey) };
    } catch (error) {
      // 通信断を「キーが違う」と出すと、正しいキーを入れ直し続けることになる。
      return {
        ok: false,
        error: error instanceof ProviderError && error.code === "config" ? "invalid_key" : "unavailable",
      };
    }
  }

  return {
    list: () => options.accounts.list(),
    async create(input) {
      if (typeof input.name !== "string" || typeof input.icon !== "string" || typeof input.apiKey !== "string") {
        return { ok: false, error: "invalid_request" };
      }

      const name = normalizeAccountName(input.name);

      if (name === null) {
        return { ok: false, error: "invalid_name" };
      }

      if (!isOpenCodeAccountIcon(input.icon)) {
        return { ok: false, error: "invalid_icon" };
      }

      const apiKey = normalizeApiKey(input.apiKey);

      if (apiKey === null) {
        return { ok: false, error: "invalid_key" };
      }

      const icon: OpenCodeAccountIcon = input.icon;
      // 上流の検証は排他区間の外で行う。待っている間に他の要求を止めない。
      const verified = await verifyKey(apiKey);

      if (!verified.ok) {
        return verified;
      }

      const created: { account: OpenCodeAccount | null } = { account: null };

      try {
        // 上限と重複の判定は区間の内側でやり直す。検証中に増えたアカウントを数え落とさない。
        await options.sampler.exclusive(() => {
          if (options.accounts.list().length >= MAX_OPENCODE_ACCOUNTS) {
            throw new AccountLimitError();
          }

          const previous = options.accounts.read();

          try {
            const account = options.accounts.create({ name, icon, apiKey });

            created.account = account;
            saveProviderSnapshot(options.db, openCodeSourceId(account.id), verified.snapshot);
          } catch (error) {
            // DB に書けないなら、503 を返したのにアカウントだけ増える状態を残さない。
            restoreQuietly(options.accounts, previous);

            throw error;
          }
        });
      } catch (error) {
        return { ok: false, error: error instanceof AccountLimitError ? "limit_reached" : "unavailable" };
      }

      return created.account ? { ok: true, value: created.account } : { ok: false, error: "unavailable" };
    },
    async update(id, input) {
      const provided = (["name", "icon", "apiKey"] as const).filter((key) => input[key] !== undefined);

      if (provided.length === 0 || provided.some((key) => typeof input[key] !== "string")) {
        return { ok: false, error: "invalid_request" };
      }

      let name: string | null = null;

      if (input.name !== undefined) {
        name = normalizeAccountName(input.name as string);

        if (name === null) {
          return { ok: false, error: "invalid_name" };
        }
      }

      let icon: OpenCodeAccountIcon | null = null;

      if (input.icon !== undefined) {
        if (!isOpenCodeAccountIcon(input.icon)) {
          return { ok: false, error: "invalid_icon" };
        }

        icon = input.icon;
      }

      let apiKey: string | null = null;

      if (input.apiKey !== undefined) {
        apiKey = normalizeApiKey(input.apiKey as string);

        // 未変更のときクライアントは apiKey を送らない。空の送信は入力ミスとして弾く。
        if (apiKey === null) {
          return { ok: false, error: "invalid_key" };
        }
      }

      // 未知 id は上流を叩く前に返す。キー検証の結果を先に返すと、存在しない id でも
      // 400 / 503 になり、承認済みの「未知 id は PUT も 404」から外れる。
      if (options.accounts.get(id) === null) {
        return { ok: false, error: "not_found" };
      }

      let snapshot: ProviderSnapshot | null = null;

      if (apiKey !== null) {
        const verified = await verifyKey(apiKey);

        if (!verified.ok) {
          return verified;
        }

        snapshot = verified.snapshot;
      }

      const updated: { account: OpenCodeAccount | null } = { account: null };

      try {
        await options.sampler.exclusive(
          () => {
            const previous = options.accounts.read();

            try {
              // 検証待ちの間に他が消したアカウントを、古い snapshot で復活させない。
              const account = options.accounts.update(id, {
                ...(name === null ? {} : { name }),
                ...(icon === null ? {} : { icon }),
                ...(apiKey === null ? {} : { apiKey }),
              });

              if (account === null) {
                throw new AccountMissingError();
              }

              updated.account = account;

              if (snapshot !== null) {
                saveProviderSnapshot(options.db, openCodeSourceId(id), snapshot);
              }
            } catch (error) {
              restoreQuietly(options.accounts, previous);

              throw error;
            }
          },
          // 名前とアイコンだけの更新では上流も取り直さない（表示名の変更で全 source を叩かない）。
          { refresh: snapshot !== null },
        );
      } catch (error) {
        return { ok: false, error: error instanceof AccountMissingError ? "not_found" : "unavailable" };
      }

      return updated.account ? { ok: true, value: updated.account } : { ok: false, error: "unavailable" };
    },
    async remove(id) {
      const removed = { done: false };

      try {
        await options.sampler.exclusive(() => {
          const previous = options.accounts.read();

          try {
            if (!options.accounts.remove(id)) {
              throw new AccountMissingError();
            }

            removed.done = true;
            deleteProviderUsage(options.db, openCodeSourceId(id));
          } catch (error) {
            restoreQuietly(options.accounts, previous);

            throw error;
          }
        });
      } catch (error) {
        return { ok: false, error: error instanceof AccountMissingError ? "not_found" : "unavailable" };
      }

      return { ok: true, value: null };
    },
  };
}

/** 元の失敗を 503 として返すため、巻き戻し自体の失敗は握る。次の書き込みで上書きできる。 */
function restoreQuietly(accounts: OpenCodeAccounts, previous: readonly OpenCodeAccountRecord[] | null): void {
  try {
    accounts.restore(previous);
  } catch {
    // 何もしない。
  }
}
