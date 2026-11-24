/**
 * サイドバーのプロジェクト開閉の保存 schema。保存するのは「開いているプロジェクト」の cwd
 * (ワークスペース root 相対) の集合で、閉じた (未操作の) プロジェクトはエントリを作らない。
 * 保存先の解決と状態の控えは deviceSettingsStore.ts。
 */
import type { ConfirmRequest } from "./confirmDialog";
import { createDeviceSettingsStore, type DeviceSettingsStorage, type DeviceSettingsStore } from "./deviceSettingsStore";
import { isRecord } from "./isRecord";

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

export function createSidebarProjectsStore(storage?: DeviceSettingsStorage | null): DeviceSettingsStore<string[]> {
  return createDeviceSettingsStore<string[]>(storage, {
    key: SIDEBAR_PROJECTS_KEY,
    parse: decodeExpandedProjects,
    // 読み手が捨てる形は書かない (書くと次の mount で開閉が変わる)
    normalize: normalizeExpandedProjects,
    // 空にするとキーごと消す
    serialize: (expanded) => (expanded.length === 0 ? null : encodeExpandedProjects(expanded)),
    fallback: () => [],
  });
}

/** アプリが使う既定の store */
export const sidebarProjectsStore = createSidebarProjectsStore();

/**
 * プロジェクトの登録解除の確認。配下のセッションを停止することを先に伝え (履歴とファイルは残る)、
 * プロジェクト名は clamp した独立した行へ出す。名前が取れないとき (一覧が古い) は本文だけで確認する。
 */
export function projectDeleteConfirmRequest(
  project: { name: string } | undefined,
  sessionCount: number,
): ConfirmRequest {
  return {
    kind: "confirm",
    title: "プロジェクトの登録を解除",
    ...(project?.name ? { subject: { label: "登録を解除するプロジェクト", value: project.name } } : {}),
    body: [`配下の ${sessionCount} 件のセッションを停止します（履歴とファイルは残ります）。`],
    confirmLabel: "登録を解除する",
    danger: true,
  };
}
