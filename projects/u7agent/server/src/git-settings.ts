/**
 * 設定 → Git のグローバル identity。アプリ DB の 1 行だけを正とし、値の規則と INI の組み立ては
 * git-identity.ts を正とする。保存は自分のロックで直列化し、サンドボックスへは exec のたびに渡す
 * (保存は「次の bash から反映」で、既存の実行には遡及しない)。
 */
import type { GitSettingsRow } from "./app-db";
import { httpError } from "./http";
import { gitIdentityProblem, type GitIdentity } from "./git-identity";
import { MutationLock } from "./model-settings";
import type { GitSettingsMutationResponse, GitSettingsResponse, UpdateGitSettingsBody } from "./schema";

export const GIT_SETTINGS_NOT_STORED_MESSAGE = "Git の設定をアプリデータ（SQLite）へ保存できませんでした";

export interface GitSettingsDb {
  /** 行が無ければ undefined = 未設定 */
  readGitSettings(): GitSettingsRow | undefined;
  saveGitSettings(settings: GitSettingsRow): void;
  clearGitSettings(): void;
}

export type GitSettingsMutationOutcome =
  | { status: 200; response: GitSettingsMutationResponse }
  | { status: 400; error: string }
  | { status: 503; error: string };

function responseOf(row: GitSettingsRow | undefined): GitSettingsResponse {
  return row
    ? { userName: row.userName, userEmail: row.userEmail, configured: true }
    : { userName: null, userEmail: null, configured: false };
}

export class GitSettingsService {
  #db: GitSettingsDb;
  #lock = new MutationLock();

  constructor(options: { db: GitSettingsDb }) {
    this.#db = options.db;
  }

  /** GET。DB 障害は未設定に落とさず 503 として伝える (設定画面が気付ける経路を残す) */
  settings(): GitSettingsResponse {
    try {
      return responseOf(this.#db.readGitSettings());
    } catch {
      throw httpError(503, GIT_SETTINGS_NOT_STORED_MESSAGE);
    }
  }

  /** 両方必須。検証は DB を触る前に済ませ、400 で何も保存しない */
  put(input: UpdateGitSettingsBody): Promise<GitSettingsMutationOutcome> {
    const problem = gitIdentityProblem(input);
    if (problem) return Promise.resolve({ status: 400, error: problem });
    const identity: GitIdentity = { userName: input.userName.trim(), userEmail: input.userEmail.trim() };
    return this.#lock.run(async () => {
      try {
        this.#db.saveGitSettings(identity);
      } catch {
        return { status: 503 as const, error: GIT_SETTINGS_NOT_STORED_MESSAGE };
      }
      return { status: 200 as const, response: { ...responseOf(identity), state: "applied" as const } };
    });
  }

  /** 冪等。行が無くても 200 を返し、未設定へ戻す */
  clear(): Promise<GitSettingsMutationOutcome> {
    return this.#lock.run(async () => {
      try {
        this.#db.clearGitSettings();
      } catch {
        return { status: 503 as const, error: GIT_SETTINGS_NOT_STORED_MESSAGE };
      }
      return { status: 200 as const, response: { ...responseOf(undefined), state: "applied" as const } };
    });
  }

  /**
   * bash 実行ごとに読む。DB 障害は null (useConfigOnly だけ) に倒し、古い identity を使い回さない。
   * サンドボックスは null を「identity なし」として扱い、直前の値が残っている config を上書きする。
   */
  identityForExec(): GitIdentity | null {
    try {
      const row = this.#db.readGitSettings();
      if (!row) return null;
      // 手編集などで壊れた値はサンドボックスへ送らない (送ると gitConfig 付きの bash が全て 400 になる)
      return gitIdentityProblem(row) ? null : row;
    } catch {
      return null;
    }
  }
}
