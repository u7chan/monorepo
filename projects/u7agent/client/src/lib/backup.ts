/**
 * 設定 → バックアップ (`/settings/backup`) の文言と、plan / 結果から表示を決める純関数。
 * サーバーはコードと値だけを返すため、日本語はここに集める (docs/backup.md)。
 */
import type {
  BackupBlocker,
  BackupDiffCounts,
  BackupExportCheck,
  BackupResetResult,
  BackupRestorePlan,
  BackupRestoreResult,
  BackupTarget,
  BackupTargetPlan,
  BackupWarning,
} from "../types";

export const BACKUP_PAGE_TITLE = "バックアップ";
export const BACKUP_EXPORT_HEADING = "バックアップを書き出す";
export const BACKUP_RESTORE_HEADING = "バックアップから復元";
export const BACKUP_RESET_HEADING = "定義をすべて削除";
export const BACKUP_WILL_REPLACE_NOTE =
  "復元は全置換です。バックアップに含まれる対象はバックアップの状態へ同期され、バックアップに無い既存の定義は削除されます。バックアップに含まれない対象は変更しません。";
export const BACKUP_PLAINTEXT_NOTE =
  "バックアップは暗号化されない ZIP です。システムプロンプトに書いた秘密も含まれ得るため、平文のファイルとして扱ってください。";
export const BACKUP_EXPORT_EMPTY_NOTE = "書き出せる定義がありません。";
export const BACKUP_EXPORT_BLOCKED_NOTE = "書き出せない対象があります";
export const BACKUP_EXPORT_STARTED_NOTE = "バックアップの書き出しを開始しました。";
export const BACKUP_RESTORE_DIALOG_TITLE = "バックアップの内容を確認";
export const BACKUP_RESTORE_PLANNING_NOTE = "バックアップを検証しています。";
export const BACKUP_RESTORE_NOT_ZIP_NOTE = ".zip のバックアップファイルを選んでください。";
export const BACKUP_RESTORE_APPLYING_LABEL = "復元しています…";
export const BACKUP_RESTORE_APPLY_LABEL = "復元する";
export const BACKUP_RESTORE_CLOSE_LABEL = "閉じる";
export const BACKUP_RESTORE_DELETE_CHECK_LABEL = "既存の定義が削除されることを理解しました";
export const BACKUP_RESET_DIALOG_TITLE = "定義をすべて削除";
export const BACKUP_RESET_CHECK_LABEL = "書き出し済み、または失ってもよい";
export const BACKUP_RESET_APPLY_LABEL = "すべて削除する";
export const BACKUP_RESET_APPLYING_LABEL = "削除しています…";
export const BACKUP_KEPT_NOTE =
  "組み込みのエージェント / 定型プロンプト / スキル、会話、プロジェクト、ワークスペースのファイル、設定、API キー、共有コンテンツ、プロジェクト側スキルは残ります。";
export const BACKUP_SKILL_LIMITS_NOTE =
  "スキルの symlink / 特殊ファイル / 実行権限は復元されません。SKILL.md を持たない直下の項目は対象外として残ります。";
export const BACKUP_NO_CHANGES_NOTE = "選択した対象に変更はありません。";
export const BACKUP_TARGET_LABELS: Record<BackupTarget, string> = {
  prompts: "定型プロンプト",
  agents: "エージェント",
  skills: "共通スキル",
};

export const BACKUP_STATUS_LABELS: Record<string, string> = {
  added: "追加",
  updated: "更新",
  identical: "同一",
  removed: "削除",
  reordered: "並び替え",
  blocked: "取り込めない",
};

/** サーバーが返す警告コードの文言。未知のコードはコードのまま出す (黙って落とさない) */
const WARNING_TEXT: Record<string, string> = {
  model_unknown: "モデル一覧を取得できないため、モデルを保持しました",
  model_settings_missing: "復元先で API キーが未設定です。設定 → モデル を確認してください",
  model_unavailable: "モデルがカタログに無いため、アプリ既定に戻しました",
  model_not_allowed: "許可リストで除外されているため、アプリ既定に戻しました",
  prompt_reference_removed: "参照先の定型プロンプトが無いため、紐づけを外しました",
  common_skill_not_found: "共通スキルが見つかりません (許可リストは残しました)",
  builtin_skill_not_found: "組み込みスキルが見つかりません (許可リストは残しました)",
  tool_not_found: "ツールが見つかりません (許可リストは残しました)",
};

const BLOCKER_TEXT: Record<string, string> = {
  prompt_in_use: "適用後も残るエージェントが参照している定型プロンプトは削除できません",
  skill_invalid: "取り込めないスキルがあります",
  skill_unreadable: "スキルの ZIP を検証できません",
  skill_too_large: "スキルの ZIP が大きすぎます",
  skill_unavailable: "サンドボックスが未設定のためスキルを復元できません",
};

function countPart(label: string, value: number): string[] {
  return value > 0 ? [`${label} ${value}`] : [];
}

/** 差分の件数。0 の項目は出さない (何もしない対象を「更新 0」で埋めない) */
export function backupCountsSummary(counts: BackupDiffCounts): string {
  const parts = [
    ...countPart("追加", counts.added),
    ...countPart("更新", counts.updated),
    ...countPart("同一", counts.identical),
    ...countPart("削除", counts.removed),
    ...countPart("並び替え", counts.reordered),
  ];
  return parts.length > 0 ? parts.join(" / ") : "変更なし";
}

/** 選択した対象の合計。`選択していない対象` は含めない */
export function backupTotalSummary(plan: BackupRestorePlan): string {
  const parts = plan.plans
    .filter((item) => plan.selected.includes(item.target))
    .map((item) => `${BACKUP_TARGET_LABELS[item.target]} ${item.total} 件`);
  return parts.length > 0 ? `復元後: ${parts.join(" / ")}` : "復元後: 変更なし";
}

/** 削除が起きるか (確認チェックを必須にするか) */
export function backupNeedsDeleteConfirm(plan: BackupRestorePlan): boolean {
  return plan.plans.some((item) => plan.selected.includes(item.target) && item.counts.removed > 0);
}

/** 削除される名前。上限で打ち切り、「ほか n 件」を添える */
export function backupRemovedNames(plan: BackupRestorePlan, limit = 5): string[] {
  const names = plan.plans
    .filter((item) => plan.selected.includes(item.target))
    .flatMap((item) => item.items.filter((entry) => entry.status === "removed").map((entry) => entry.name));
  if (names.length <= limit) return names;
  return [...names.slice(0, limit), `ほか ${names.length - limit} 件`];
}

export function backupWarningsOf(plan: BackupRestorePlan): string[] {
  const texts: string[] = [];
  for (const item of plan.plans) {
    for (const warning of item.warnings) {
      const base = WARNING_TEXT[warning.code] ?? warning.code;
      const text = warning.name ? `${base}: ${warning.name}` : base;
      if (!texts.includes(text)) texts.push(text);
    }
  }
  return texts;
}

export function backupBlockerText(blocker: BackupBlocker): string {
  const base = BLOCKER_TEXT[blocker.code] ?? blocker.message;
  return blocker.names.length > 0 ? `${base}: ${blocker.names.join("、")}` : base;
}

/** 実行できるか。ブロッカーが無く、差分があり、削除があるときは確認済みであること */
export function backupCanApply(plan: BackupRestorePlan, confirmed: boolean): boolean {
  if (plan.blocked || !plan.changed) return false;
  return !backupNeedsDeleteConfirm(plan) || confirmed;
}

export function backupTargetPlanOf(plan: BackupRestorePlan, target: BackupTarget): BackupTargetPlan | undefined {
  return plan.plans.find((item) => item.target === target);
}

/** 書き出し前の確認に出す件数。スキルは件数だけを出し、復元可否は restore plan で確かめる */
export function backupExportSummary(check: BackupExportCheck): string {
  return check.entries.map((entry) => `${BACKUP_TARGET_LABELS[entry.target]} ${entry.count} 件`).join(" / ");
}

/** 書き出しの可否。スキルだけが `available: false` になり得る */
export function backupExportBlockReason(check: BackupExportCheck): string | null {
  const blocked = check.entries.find((entry) => entry.available === false);
  if (!blocked) return null;
  return `${BACKUP_TARGET_LABELS[blocked.target]}を書き出せません${blocked.reason ? `: ${blocked.reason}` : ""}`;
}

export function backupRestoreDoneNote(result: BackupRestoreResult): string {
  if (!result.complete) {
    const failed = result.failed.map((item) => `${BACKUP_TARGET_LABELS[item.target]}: ${item.message}`).join(" / ");
    return `一部だけ復元しました。再実行すると残りを適用できます (${failed})`;
  }
  const applied = result.applied.map((item) => BACKUP_TARGET_LABELS[item.target]).join("、");
  return applied ? `復元しました (${applied})` : "復元しました (変更なし)";
}

export function backupResetDoneNote(result: BackupResetResult): string {
  const base = `削除しました (エージェント ${result.agents} 件 / 定型プロンプト ${result.prompts} 件 / 共通スキル ${result.skills} 件)`;
  if (result.complete) return base;
  const failed = result.failed.map((item) => `${BACKUP_TARGET_LABELS[item.target]}: ${item.message}`).join(" / ");
  return `${base}。一部は削除できませんでした (${failed})`;
}

/** ダイアログに出す警告の整形。件数が多すぎるときはサーバー側で打ち切られている */
export function backupWarningTexts(warnings: readonly BackupWarning[]): string[] {
  return warnings.map((warning) => {
    const base = WARNING_TEXT[warning.code] ?? warning.code;
    return warning.name ? `${base}: ${warning.name}` : base;
  });
}
