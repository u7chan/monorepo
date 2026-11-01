import type { DatabaseHandle } from "../db";
import { deleteProviderState } from "../db";
import type { Sampler } from "../sampler";
import type { CodexAuth } from "./auth";
import type { CodexLoginService, CodexLoginState } from "./login";
import { codexSourceId } from "./source";

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
  sampler: Pick<Sampler, "exclusive">;
}): CodexApi {
  return {
    auth() {
      return { signedIn: options.auth.signedIn(), login: options.login.state() };
    },
    startLogin: () => options.login.start(),
    respond: (value) => options.login.respond(value),
    cancelLogin: () => options.login.cancel(),
    async logout() {
      // 進行中のサインインを止め、成功・失敗の表示も消す。残すとサインアウト後も開始ボタンが出ない。
      options.login.cancel();
      // 資格情報を消すと accountId が読めなくなるため、履歴のキーを先に決める。
      const sourceId = codexSourceId(options.auth.accountId());

      await options.auth.logout();

      // サインアウト後は前回の snapshot を出さない。sample は残し、同じアカウントで戻ったときに
      // 推移を続けられるようにする。先に始まっていた取得が書き戻さないよう、削除は
      // sampler の排他区間で行い、その後に取り直す（取り直しは未接続の error だけを書く）。
      await options.sampler.exclusive(() => deleteProviderState(options.db, sourceId));
    },
  };
}
