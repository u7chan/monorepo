export const SIDEBAR_SECTIONS_KEY = "u7agent-expanded-sidebar-sections";
export const SIDEBAR_SECTIONS_VERSION = 1;

export const SIDEBAR_SECTION_IDS = ["projects", "unassigned"] as const;
export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];

const DEFAULT_EXPANDED_SECTIONS: SidebarSectionId[] = [...SIDEBAR_SECTION_IDS];

export function encodeExpandedSidebarSections(expanded: SidebarSectionId[]): string {
  return JSON.stringify({ version: SIDEBAR_SECTIONS_VERSION, expanded });
}

export function decodeExpandedSidebarSections(raw: string | null): SidebarSectionId[] {
  if (raw === null) return [...DEFAULT_EXPANDED_SECTIONS];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [...DEFAULT_EXPANDED_SECTIONS];
  }
  if (!isRecord(parsed) || parsed.version !== SIDEBAR_SECTIONS_VERSION || !Array.isArray(parsed.expanded)) {
    return [...DEFAULT_EXPANDED_SECTIONS];
  }
  return normalizeExpandedSidebarSections(parsed.expanded);
}

export function normalizeExpandedSidebarSections(value: readonly unknown[]): SidebarSectionId[] {
  return SIDEBAR_SECTION_IDS.filter((section) => value.includes(section));
}

export type SidebarSectionsStorage = Pick<Storage, "getItem" | "setItem">;

export type SidebarSectionsStore = {
  read(): SidebarSectionId[];
  write(expanded: SidebarSectionId[]): void;
};

export function createSidebarSectionsStore(storage?: SidebarSectionsStorage | null): SidebarSectionsStore {
  let memory: SidebarSectionId[] | undefined;
  const resolve = (): SidebarSectionsStorage | null => (storage === undefined ? defaultStorage() : storage);

  return {
    read() {
      if (memory !== undefined) return memory;
      const target = resolve();
      if (!target) return [...DEFAULT_EXPANDED_SECTIONS];
      try {
        memory = decodeExpandedSidebarSections(target.getItem(SIDEBAR_SECTIONS_KEY));
        return memory;
      } catch {
        return [...DEFAULT_EXPANDED_SECTIONS];
      }
    },
    write(expanded) {
      const next = normalizeExpandedSidebarSections(expanded);
      memory = next;
      const target = resolve();
      if (!target) return;
      try {
        target.setItem(SIDEBAR_SECTIONS_KEY, encodeExpandedSidebarSections(next));
      } catch {
        // 表示設定の保存失敗でカテゴリの開閉操作まで止めない。
      }
    },
  };
}

export const sidebarSectionsStore = createSidebarSectionsStore();

function defaultStorage(): SidebarSectionsStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
