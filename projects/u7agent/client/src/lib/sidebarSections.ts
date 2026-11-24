import { createDeviceSettingsStore, type DeviceSettingsStorage, type DeviceSettingsStore } from "./deviceSettingsStore";
import { isRecord } from "./isRecord";

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

export function createSidebarSectionsStore(
  storage?: DeviceSettingsStorage | null,
): DeviceSettingsStore<SidebarSectionId[]> {
  return createDeviceSettingsStore<SidebarSectionId[]>(storage, {
    key: SIDEBAR_SECTIONS_KEY,
    parse: decodeExpandedSidebarSections,
    serialize: encodeExpandedSidebarSections,
    normalize: normalizeExpandedSidebarSections,
    fallback: () => [...DEFAULT_EXPANDED_SECTIONS],
  });
}

export const sidebarSectionsStore = createSidebarSectionsStore();
