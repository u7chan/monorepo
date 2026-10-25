import type { DatabaseHandle } from "../db";
import { deleteProviderUsage } from "../db";
import type { Sampler } from "../sampler";
import type { CodexAuth } from "./auth";
import type { CodexLoginService, CodexLoginState } from "./login";

export type CodexAuthState = { signedIn: boolean; login: CodexLoginState | null };

export type CodexApi = {
  auth: () => CodexAuthState;
  startLogin: () => Promise<void>;
  respond: (value: string) => void;
  cancelLogin: () => void;
  logout: () => Promise<void>;
};

export function createCodexApi(options: {
  auth: CodexAuth;
  login: CodexLoginService;
  db: DatabaseHandle;
  sampler: Pick<Sampler, "kick">;
}): CodexApi {
  return {
    auth() {
      return { signedIn: options.auth.signedIn(), login: options.login.state() };
    },
    startLogin: () => options.login.start(),
    respond: (value) => options.login.respond(value),
    cancelLogin: () => options.login.cancel(),
    async logout() {
      await options.auth.logout();
      // サインアウト後は前回の snapshot を出さない。残すと「サインイン済み」の数値が 5 分間見える。
      deleteProviderUsage(options.db, "codex");
      await options.sampler.kick();
    },
  };
}
