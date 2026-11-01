import { join } from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { CredentialSynchronizationError, ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { ProviderError } from "../providers/types";
import { createDeviceIdStore } from "./device-id";

export const CODEX_PROVIDER_ID = "openai-codex";
export const CODEX_AGENT_NAME = "usage-portal";
export const CODEX_AUTH_FILE = "auth.json";
export const CODEX_DEVICE_ID_FILE = "device-id";

/** access token が切れる直前に refresh させる。取得の直後に 401 になる往復を減らす。 */
const MIN_OAUTH_VALIDITY_MS = 15 * 60 * 1000;

export type CodexCredential = { accessToken: string; accountId: string };

export type CodexAuth = {
  signedIn: () => boolean;
  /** 履歴のキーにだけ使う。応答・DB の snapshot・ログには出さない。 */
  accountId: () => string | null;
  credential: () => Promise<CodexCredential>;
  login: (interaction: AuthInteraction) => Promise<void>;
  logout: () => Promise<void>;
};

/**
 * Pi SDK を資格情報の読み取り・更新・サインインにだけ使う。
 * `modelsPath: null` と `refreshOnCreate: false` で model catalog のネットワーク更新も保存もしない。
 */
export function createCodexAuth(options: { credentialDir: string; log?: (message: string) => void }): CodexAuth {
  const authPath = join(options.credentialDir, CODEX_AUTH_FILE);
  const deviceIds = createDeviceIdStore(join(options.credentialDir, CODEX_DEVICE_ID_FILE), options.log);
  let runtime: Promise<ModelRuntime> | null = null;

  function readAccountId(): string | null {
    try {
      const stored = readStoredCredential(CODEX_PROVIDER_ID, authPath);

      return stored?.type === "oauth" && typeof stored.accountId === "string" && stored.accountId !== ""
        ? stored.accountId
        : null;
    } catch {
      return null;
    }
  }

  function getRuntime(): Promise<ModelRuntime> {
    runtime ??= ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false }).catch((error) => {
      // 失敗を握り続けると、直る状態になってもプロセスを再起動するまで戻らない。
      runtime = null;

      throw error;
    });

    return runtime;
  }

  return {
    signedIn() {
      try {
        return readStoredCredential(CODEX_PROVIDER_ID, authPath)?.type === "oauth";
      } catch {
        return false;
      }
    },
    accountId: readAccountId,
    async credential() {
      let auth: Awaited<ReturnType<ModelRuntime["getAuth"]>>;

      try {
        auth = await (await getRuntime()).getAuth(CODEX_PROVIDER_ID, { minOAuthValidityMs: MIN_OAUTH_VALIDITY_MS });
      } catch {
        // SDK の例外文には token や URL が混ざり得る。分類だけを残し、文言は固定へ寄せる。
        throw new ProviderError("reauth_required", "Codex の再サインインが必要です");
      }

      const accessToken = auth?.auth.apiKey;

      if (!accessToken) {
        throw new ProviderError("not_connected", "Codex にサインインしていません");
      }

      const accountId = readAccountId();

      if (!accountId) {
        throw new ProviderError("reauth_required", "Codex の再サインインが必要です");
      }

      return { accessToken, accountId };
    },
    async login(interaction) {
      const modelRuntime = await getRuntime();

      await settleCredentialOperation("login", () =>
        modelRuntime.login(CODEX_PROVIDER_ID, "oauth", interaction, {
          getDeviceId: () => deviceIds.getOrCreate(),
          agentName: CODEX_AGENT_NAME,
        }),
      );
    },
    async logout() {
      const modelRuntime = await getRuntime();

      await settleCredentialOperation("logout", () => modelRuntime.logout(CODEX_PROVIDER_ID));
    },
  };
}

/**
 * SDK は `auth.json` への保存後に snapshot の同期だけ失敗しても CSE を投げる。
 * provider と操作が一致する CSE だけを「保存済み」として成功に倒す（credential は返さない）。
 */
async function settleCredentialOperation(operation: "login" | "logout", run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (
      error instanceof CredentialSynchronizationError &&
      error.providerId === CODEX_PROVIDER_ID &&
      error.operation === operation
    ) {
      return;
    }

    throw error;
  }
}
