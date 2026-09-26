import { createPiBff } from "./agent";
import type { PiBff } from "./agent";
import { AppDb } from "./app-db";
import { createAgentCatalog } from "./agents";
import type { AgentCatalog } from "./agents";
import { createArchiveSettings } from "./archive-settings";
import type { ArchiveSettings } from "./archive-settings";
import { BUILTIN_SKILLS } from "./builtin-skills";
import { messageFor } from "./http";
import { NotificationService } from "./notifications";
import { ProjectStore } from "./projects";
import { createSandboxToolClientFromEnv } from "./sandbox/client";
import type { SandboxRuntimeDiagnostics, SandboxWorkspaceClient } from "./sandbox/client";
import { SessionStore } from "./sessions";
import { prepareSessionStore, resolveSessionStoreDir } from "./session-store";

export type CreateBffAppOptions = {
  cwd?: string;
  /** null を渡すとランタイム構築をスキップする (テスト用) */
  pi?: PiBff | null;
  /** 未指定なら env から生成し、null なら未設定として 503 を返す */
  workspace?: SandboxWorkspaceClient | null;
  /**
   * 診断専用クライアント。未指定なら env から生成したサンドボックスクライアントを再利用する
   * (workspace を差し替えたテストでは null。既存の workspace スタブへ診断メソッドを要求しない)。
   */
  runtimeDiagnostics?: SandboxRuntimeDiagnostics | null;
  clientDistDir?: string;
  /** 会話ストアの絶対パス。null で永続化なし。未指定は PI_SESSION_STORE → 既定 (<agentDir>/u7agent/sessions) */
  sessionStoreDir?: string | null;
  /** 通知送信のテスト用。省略時は globalThis.fetch */
  notificationFetch?: typeof fetch;
};

export type SessionStoreStatus = {
  /** null は永続化なし */
  path: string | null;
  ok: boolean;
  error?: string;
};

export type BffContext = {
  cwd: string;
  pi: PiBff | null;
  initError: string | undefined;
  catalog: AgentCatalog;
  projects: ProjectStore;
  store: SessionStore;
  workspace: SandboxWorkspaceClient | null;
  /** 実行環境の診断。workspace とは別に注入でき、null なら not_configured を返す */
  runtimeDiagnostics: SandboxRuntimeDiagnostics | null;
  sessionStore: SessionStoreStatus;
  /** アプリデータ (プロジェクト / カタログ) の DB。status() を health へ出す */
  appDb: AppDb;
  /** Discord 通知。ラン完了時の送信と設定 API の両方から使う */
  notifications: NotificationService;
  /** アーカイブの除外名。health と download / check が同じ実効値を取る */
  archiveSettings: ArchiveSettings;
};

export async function createBffContext(opts: CreateBffAppOptions = {}): Promise<BffContext> {
  const cwd = opts.cwd ?? process.cwd();
  let pi: PiBff | null = opts.pi ?? null;
  let initError: string | undefined;
  if (opts.pi === undefined) {
    try {
      pi = await createPiBff({ cwd });
    } catch (error) {
      initError = messageFor(error);
      console.error(`[u7agent] Pi runtime unavailable: ${initError}`);
    }
  }

  // 会話ストアはサンドボックスと共有しない。設定ミス (ワークスペース内の指定) は永続化なしに落とし、
  // health で理由を見せてセッション作成だけを 503 で止める。
  let sessionStore: SessionStoreStatus = { path: null, ok: true };
  let sessionStoreError: string | undefined;
  let storeDir: string | null = null;
  try {
    storeDir = opts.sessionStoreDir !== undefined ? opts.sessionStoreDir : resolveSessionStoreDir({ rootCwd: cwd });
  } catch (error) {
    sessionStoreError = messageFor(error);
    console.error(`[u7agent] session store unavailable: ${sessionStoreError}`);
  }
  if (storeDir) sessionStore = { path: storeDir, ok: true };
  else if (sessionStoreError) sessionStore = { path: null, ok: false, error: sessionStoreError };

  // アプリデータの DB は会話ストアと同じディレクトリへ併置するため、先にディレクトリを用意する。
  // パス解決に失敗しているときはメモリ DB へ逃がさず、DB も使えない状態にする。
  if (storeDir) {
    try {
      await prepareSessionStore(storeDir);
    } catch (error) {
      sessionStoreError = messageFor(error);
      sessionStore = { path: storeDir, ok: false, error: sessionStoreError };
      console.error(`[u7agent] session store unavailable: ${sessionStoreError}`);
    }
  }
  const appDb = sessionStoreError
    ? AppDb.unavailable({ storeDir, error: sessionStoreError })
    : AppDb.open({ storeDir });

  // 組み込みスキルはサンドボックスに依らず起動時に読み込み済みなので、カタログの応答へそのまま載せる
  const catalog = createAgentCatalog({
    builtinSkills: BUILTIN_SKILLS.map((skill) => ({ name: skill.name, description: skill.description })),
    db: appDb,
  });
  const projects = new ProjectStore(appDb);
  // 通知はセッションと同じ secret masker を使い、本文とエラーから秘密値を落とす
  const notifications = new NotificationService({
    db: appDb,
    masker: pi?.secretMasker,
    fetchImpl: opts.notificationFetch,
  });
  // アーカイブの除外名は設定ストアが唯一の決定点で、サンドボックスへはリクエストごとに渡す
  const archiveSettings = createArchiveSettings({ db: appDb });
  // 作業領域の操作はモデルランタイムとは独立に生成する (APIキー未設定で ready: false でもツリーは開けるように)
  const sandboxClient = opts.workspace !== undefined ? undefined : createSandboxToolClientFromEnv(process.env);
  const workspace = opts.workspace !== undefined ? opts.workspace : (sandboxClient ?? null);
  const runtimeDiagnostics = opts.runtimeDiagnostics !== undefined ? opts.runtimeDiagnostics : (sandboxClient ?? null);
  const store = new SessionStore({
    pi,
    catalog,
    masker: pi?.secretMasker,
    projects,
    storeDir,
    storeError: sessionStoreError,
    workspace,
    rootCwd: cwd,
    notifications,
  });
  if (storeDir) {
    try {
      await store.init();
    } catch (error) {
      // 準備に失敗したらセッション作成も 503 で止める (メモリだけの黙ったフォールバックをしない)
      sessionStoreError = messageFor(error);
      store.markStoreUnavailable(sessionStoreError);
      sessionStore = { path: storeDir, ok: false, error: sessionStoreError };
      console.error(`[u7agent] session store init failed: ${sessionStoreError}`);
    }
  }
  return {
    cwd,
    pi,
    initError,
    catalog,
    projects,
    store,
    workspace,
    runtimeDiagnostics,
    sessionStore,
    appDb,
    notifications,
    archiveSettings,
  };
}
