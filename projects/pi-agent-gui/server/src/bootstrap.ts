import { createPiBff } from "./agent";
import type { PiBff } from "./agent";
import { createAgentCatalog } from "./agents";
import type { AgentCatalog } from "./agents";
import { messageFor } from "./http";
import { ProjectStore } from "./projects";
import { createSandboxToolClientFromEnv } from "./sandbox/client";
import type { SandboxWorkspaceClient } from "./sandbox/client";
import { SessionStore } from "./sessions";
import { resolveSessionStoreDir } from "./session-store";

export type CreateBffAppOptions = {
  cwd?: string;
  /** null を渡すとランタイム構築をスキップする (テスト用) */
  pi?: PiBff | null;
  /** 未指定なら env から生成し、null なら未設定として 503 を返す */
  workspace?: SandboxWorkspaceClient | null;
  clientDistDir?: string;
  /** 会話ストアの絶対パス。null で永続化なし。未指定は PI_SESSION_STORE → 既定 (<agentDir>/pi-agent-gui/sessions) */
  sessionStoreDir?: string | null;
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
  sessionStore: SessionStoreStatus;
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
      console.error(`[pi-agent-gui] Pi runtime unavailable: ${initError}`);
    }
  }

  const catalog = createAgentCatalog();
  const projects = new ProjectStore();
  // 作業領域の操作はモデルランタイムとは独立に生成する (APIキー未設定で ready: false でもツリーは開けるように)
  const workspace =
    opts.workspace !== undefined ? opts.workspace : (createSandboxToolClientFromEnv(process.env) ?? null);
  // 会話ストアはサンドボックスと共有しない。設定ミス (ワークスペース内の指定) は永続化なしに落とし、
  // health で理由を見せてセッション作成だけを 503 で止める。
  let sessionStore: SessionStoreStatus = { path: null, ok: true };
  let sessionStoreError: string | undefined;
  let storeDir: string | null = null;
  try {
    storeDir = opts.sessionStoreDir !== undefined ? opts.sessionStoreDir : resolveSessionStoreDir({ rootCwd: cwd });
  } catch (error) {
    sessionStoreError = messageFor(error);
    console.error(`[pi-agent-gui] session store unavailable: ${sessionStoreError}`);
  }
  if (storeDir) sessionStore = { path: storeDir, ok: true };
  else if (sessionStoreError) sessionStore = { path: null, ok: false, error: sessionStoreError };
  const store = new SessionStore({
    pi,
    catalog,
    masker: pi?.secretMasker,
    projects,
    storeDir,
    storeError: sessionStoreError,
    workspace,
    rootCwd: cwd,
  });
  if (storeDir) {
    try {
      await store.init();
    } catch (error) {
      // 準備に失敗したらセッション作成も 503 で止める (メモリだけの黙ったフォールバックをしない)
      sessionStoreError = messageFor(error);
      store.markStoreUnavailable(sessionStoreError);
      sessionStore = { path: storeDir, ok: false, error: sessionStoreError };
      console.error(`[pi-agent-gui] session store init failed: ${sessionStoreError}`);
    }
  }
  return { cwd, pi, initError, catalog, projects, store, workspace, sessionStore };
}
