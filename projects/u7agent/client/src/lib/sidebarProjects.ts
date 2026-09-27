/**
 * サイドバーのプロジェクト開閉の保存 schema と、その保存先 (localStorage) の薄い境界。
 * 保存するのは「開いているプロジェクト」の cwd (ワークスペース root 相対) の集合で、
 * 閉じた (未操作の) プロジェクトはエントリを作らない。DOM に触れるのは保存先の解決だけ。
 */

/** 保存キー。テーマ等と同じく端末ローカルの表示設定として持つ */
export const SIDEBAR_PROJECTS_KEY = "u7agent-expanded-projects";
export const SIDEBAR_PROJECTS_VERSION = 1;
/** 保存する cwd 数の上限。超えた分は先に書かれた cwd から落とす */
export const SIDEBAR_PROJECTS_LIMIT = 20;

export function encodeExpandedProjects(expanded: string[]): string {
  return JSON.stringify({ version: SIDEBAR_PROJECTS_VERSION, expanded });
}

/**
 * 保存値を読む。JSON 全体 / version が合わなければ全体を捨て、配列の非文字列・空文字・重複は
 * 1 件ずつ落とす。上限を超えた分は先に書かれた cwd から落とす (末尾 = 今回書いた cwd)。
 */
export function decodeExpandedProjects(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed.version !== SIDEBAR_PROJECTS_VERSION || !Array.isArray(parsed.expanded)) return [];
  return normalizeExpandedProjects(parsed.expanded);
}

/** 保存できる形へ寄せる。非文字列・空文字・重複を落とし、上限を超えた分は先頭から落とす */
export function normalizeExpandedProjects(value: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const expanded: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "" || seen.has(item)) continue;
    seen.add(item);
    expanded.push(item);
  }
  return expanded.slice(-SIDEBAR_PROJECTS_LIMIT);
}

export type SidebarProjectsStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type SidebarProjectsStore = {
  /** 開いている cwd (保存順)。読み書きした後はメモリ側が正になる */
  read(): string[];
  /** 集合を丸ごと差し替える。空にするとキーごと消す */
  write(expanded: string[]): void;
};

/**
 * 開いているプロジェクトの集合を localStorage の 1 キーで読み書きする。保存領域が使えない環境
 * (private browsing 等) でも操作を止めず、代わりに同じセッション内のメモリを使う。write が
 * 失敗した後でも、再読み込みするまでは開閉を保つ (filePreviewState.ts と同じ扱い)。
 */
export function createSidebarProjectsStore(storage?: SidebarProjectsStorage | null): SidebarProjectsStore {
  // 一度でも読み書きしたら、以降はここが正 (書けなくても session 内は保つ)
  let memory: string[] | undefined;
  // 引数を省いたときは毎回引き直す (例外を投げる環境と、window が無いテストの両方に対応する)
  const resolve = (): SidebarProjectsStorage | null => (storage === undefined ? defaultStorage() : storage);

  return {
    read() {
      if (memory !== undefined) return memory;
      const target = resolve();
      if (!target) return [];
      try {
        memory = decodeExpandedProjects(target.getItem(SIDEBAR_PROJECTS_KEY));
        return memory;
      } catch {
        return [];
      }
    },
    write(expanded) {
      // 読み手が捨てる形は書かない (書くと次の mount で開閉が変わる)
      const next = normalizeExpandedProjects(expanded);
      memory = next;
      const target = resolve();
      if (!target) return;
      try {
        if (next.length === 0) target.removeItem(SIDEBAR_PROJECTS_KEY);
        else target.setItem(SIDEBAR_PROJECTS_KEY, encodeExpandedProjects(next));
      } catch {
        // 保存できない。次の変更でまた試す (ここでは再試行しない)
      }
    },
  };
}

/** アプリが使う既定の store */
export const sidebarProjectsStore = createSidebarProjectsStore();

/** localStorage の accessor 自体が例外になる環境 (private browsing 等) がある */
function defaultStorage(): SidebarProjectsStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
