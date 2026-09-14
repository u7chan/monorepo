import { createPiBff } from "./agent";
import type { PiBff } from "./agent";
import { createAgentCatalog } from "./agents";
import type { AgentCatalog } from "./agents";
import { messageFor } from "./http";
import { ProjectStore } from "./projects";
import { createSandboxToolClientFromEnv } from "./sandbox/client";
import type { SandboxWorkspaceClient } from "./sandbox/client";
import { SessionStore } from "./sessions";

export type CreateBffAppOptions = {
  cwd?: string;
  /** テストは明示的な pi (null も含む) を渡してランタイム構築をスキップする */
  pi?: PiBff | null;
  /** ファイル一覧とプロジェクト作成のサンドボックス。未指定なら env から生成し、null なら未設定として 503 を返す */
  workspace?: SandboxWorkspaceClient | null;
  /** テスト用: 静的配信のルートディレクトリ (既定は client/dist) */
  clientDistDir?: string;
};

export type BffContext = {
  cwd: string;
  pi: PiBff | null;
  initError: string | undefined;
  catalog: AgentCatalog;
  projects: ProjectStore;
  store: SessionStore;
  workspace: SandboxWorkspaceClient | null;
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
  const store = new SessionStore({ pi, catalog, masker: pi?.secretMasker, projects });
  // 作業領域の操作はモデルランタイムとは独立に生成する (APIキー未設定で ready: false でもツリーは開けるように)
  const workspace =
    opts.workspace !== undefined ? opts.workspace : createSandboxToolClientFromEnv(process.env) ?? null;
  return { cwd, pi, initError, catalog, projects, store, workspace };
}
