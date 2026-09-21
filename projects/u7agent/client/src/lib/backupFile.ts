import { BACKUP_TARGETS, backupTargetLabel, isBackupTargetId, type BackupTargetId } from "./backupTargets";

/**
 * バックアップファイルの封筒。取り込み範囲は `data` のキーそのもので決める
 * (対象の一覧を別に持つと、キーとの食い違いで「入っていない対象を消す」事故が起きる)。
 * 旧形式 (`{ agents, skills }` 直下) は運用前のため受理しない。
 */

export const BACKUP_APP = "u7agent";
export const BACKUP_SCHEMA = 1;

export type BackupData = Partial<Record<BackupTargetId, unknown>>;

export type BackupFile = {
  app: string;
  schema: number;
  exportedAt: string;
  data: BackupData;
};

const TARGET_LIST = BACKUP_TARGETS.map((target) => backupTargetLabel(target.id)).join(" / ");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 失敗はそのまま画面の注記へ出すため、原因の分かる日本語で投げる */
export function parseBackupFile(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("バックアップファイルを JSON として読み取れませんでした");
  }
  if (!isRecord(parsed) || parsed.app !== BACKUP_APP) {
    throw new Error("u7agent のバックアップファイルではありません");
  }
  if (parsed.schema !== BACKUP_SCHEMA) {
    throw new Error(`このバックアップファイルの形式 (schema ${String(parsed.schema)}) は読み込めません`);
  }
  if (!isRecord(parsed.data)) {
    throw new Error("バックアップファイルにデータが入っていません");
  }
  const data: BackupData = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (!isBackupTargetId(key)) {
      throw new Error(`未知の対象「${key}」が含まれています。対応している対象は ${TARGET_LIST} です`);
    }
    data[key] = value;
  }
  if (Object.keys(data).length === 0) {
    throw new Error("バックアップファイルに対象が入っていません");
  }
  return {
    app: BACKUP_APP,
    schema: BACKUP_SCHEMA,
    exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : "",
    data,
  };
}

/** 定義側の並びで返す。適用順と確認カードの表示順をこれに揃える */
export function backupTargetIdsIn(data: BackupData): BackupTargetId[] {
  return BACKUP_TARGETS.filter((target) => Object.hasOwn(data, target.id)).map((target) => target.id);
}

export function serializeBackup(
  targets: BackupTargetId[],
  data: BackupData,
  exportedAt: Date,
): { fileName: string; text: string } {
  const body = { app: BACKUP_APP, schema: BACKUP_SCHEMA, exportedAt: exportedAt.toISOString(), data };
  const date = exportedAt.toISOString().slice(0, 10);
  const fileName = targets.length === 1 ? `u7agent-${targets[0]}-${date}.json` : `u7agent-backup-${date}.json`;
  return { fileName, text: JSON.stringify(body, null, 2) };
}

export type ImportSplit = { ready: BackupTargetId[]; blocked: BackupTargetId[] };

/**
 * 準備中の対象を含むファイルは何も適用せず中止する。一部だけ取り込むと、
 * 消えたように見える対象が出てどれが入ったか説明できなくなるため。
 */
export function splitImportTargets(ids: BackupTargetId[]): ImportSplit {
  const split: ImportSplit = { ready: [], blocked: [] };
  for (const id of ids) {
    const target = BACKUP_TARGETS.find((item) => item.id === id);
    (target?.ready ? split.ready : split.blocked).push(id);
  }
  return split;
}

export type DefinitionsPayload = { agents: unknown[]; skills: unknown[] };

/** 適用の前にここで形を確定させる (途中まで適用してから失敗させない) */
export function parseDefinitionsPayload(value: unknown): DefinitionsPayload {
  if (!isRecord(value) || !Array.isArray(value.agents) || !Array.isArray(value.skills)) {
    throw new Error("エージェントとスキルの配列を含むバックアップファイルではありません");
  }
  return { agents: value.agents, skills: value.skills };
}

function countText(value: unknown): string {
  return Array.isArray(value) ? `${value.length} 件` : "内容不明";
}

/** 確認カードに出す対象ごとの内容。対象を増やしたらここも足す */
export function describeBackupPayload(id: BackupTargetId, value: unknown): string {
  if (id !== "definitions" || !isRecord(value)) return "内容不明";
  return `エージェント ${countText(value.agents)} / スキル ${countText(value.skills)}`;
}
