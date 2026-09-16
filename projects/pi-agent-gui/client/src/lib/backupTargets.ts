/**
 * バックアップの対象一覧。エクスポートの選択肢と、インポート時に受け入れるキーの正を兼ねる
 * (画面とファイル形式で対象がずれないようにする)。保存先もここに持つ。
 */

export type BackupTargetId = "definitions" | "projects" | "sessions" | "appearance";

export type BackupTarget = {
  id: BackupTargetId;
  label: string;
  description: string;
  /** データの置き場所。再起動で消えるのはメモリ内だけ */
  store: string;
  /** エクスポート / インポートに未対応の間は false。チェックできず、含むファイルは取り込まない */
  ready: boolean;
};

export const BACKUP_TARGETS: BackupTarget[] = [
  {
    id: "definitions",
    label: "エージェントとスキル",
    description: "会話の役割と、割り当てる指示の定義",
    store: "サーバーのメモリ",
    ready: true,
  },
  {
    id: "projects",
    label: "プロジェクト",
    description: "登録済みの作業ディレクトリ",
    store: "サーバーのメモリ",
    ready: false,
  },
  {
    id: "sessions",
    label: "会話履歴",
    description: "セッションとメッセージ",
    store: "サーバーのメモリ",
    ready: false,
  },
  { id: "appearance", label: "外観", description: "選んでいるテーマ", store: "このブラウザ", ready: false },
];

export const READY_BACKUP_TARGETS: BackupTarget[] = BACKUP_TARGETS.filter((target) => target.ready);

export function isBackupTargetId(value: string): value is BackupTargetId {
  return BACKUP_TARGETS.some((target) => target.id === value);
}

export function backupTargetLabel(id: BackupTargetId): string {
  return BACKUP_TARGETS.find((target) => target.id === id)?.label ?? id;
}

/** 表示・適用の順序を定義側に揃える (選択した順でファイルの中身が変わらないようにする) */
export function orderBackupTargets(ids: BackupTargetId[]): BackupTargetId[] {
  return BACKUP_TARGETS.filter((target) => ids.includes(target.id)).map((target) => target.id);
}
