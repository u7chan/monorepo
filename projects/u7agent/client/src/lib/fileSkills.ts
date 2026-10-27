/**
 * 共通スキル (`.agents/skills`) と組み込みスキルの表示用の導出。重複警告・上書き表示の文言をここ 1 箇所へ閉じ、
 * コンポーネントは結果を描画するだけにする (docs/api-catalog.md)。
 */
import { formatBytes } from "./attachments";
import { filterBySearch } from "./settingsSearch";
import type { FileSkillInfo, SandboxSkillImportPlanEntry } from "../types";

/** ファイルスキル (共通 + 組み込み) のブロック見出し。共通は編集でき、組み込みは読み取り専用 */
export const FILE_SKILL_SECTION_LABEL = "ファイルスキル";
export const FILE_SKILL_GROUP_LABEL = "共通スキル";
/** スキル詳細 / スキル一覧の見出しで使う短い語。組み込みを先頭に固定するので、こちらは後に置く */
export const COMMON_SKILL_SECTION_LABEL = "共通";
export const BUILTIN_SKILL_GROUP_LABEL = "組み込みスキル";
/** 再読み込みは共通 + 組み込みを同時に取り直すので、読み上げ名でも両方を挙げる */
export const FILE_SKILL_RELOAD_LABEL = "再読み込み";
export const FILE_SKILL_RELOAD_ARIA_LABEL = "共通スキルと組み込みスキルを再読み込み";
export const FILE_SKILL_SCOPE_LABEL: Record<FileSkillInfo["scope"], string> = {
  user: "共通",
  project: "プロジェクト",
  builtin: "組み込み",
};
export const FILE_SKILL_EMPTY_NOTE = "共通スキルはまだありません。";
export const BUILTIN_SKILL_EMPTY_NOTE = "組み込みスキルはありません。";
export const FILE_SKILL_ERROR_PREFIX = "スキルを取得できませんでした";
export const FILE_SKILL_LOADING_NOTE = "スキルを読み込んでいます…";
export const BUILTIN_SKILL_OVERRIDE_NOTE = "上書きされています（同名の共通スキルが優先されます）";
export const BUILTIN_SKILL_READONLY_NOTE = "アプリに同梱されているため、編集・削除はできません。";
/** 共通スキルをこの画面から編集できることの案内。改名できないことは新規作成のときだけ関係する */
export const FILE_SKILL_EDITABLE_NOTE = "説明と本文だけを変更できます。名前は作成時に決まり、あとから変更できません。";
/** 保存できない共通スキル (frontmatter が特殊なものなど) の前置き。理由は detail.reason に続ける */
export const FILE_SKILL_LOCKED_PREFIX = "このスキルは保存できません";
/** 保存の要求の上限。BFF の bodyGuard (64 KiB) と揃えた案内で、値は server/src/http.ts が正 */
export const FILE_SKILL_SAVE_LIMIT_NOTE =
  "保存の要求は 64 KiB までです。それより大きなスキルは閲覧だけできます (切り詰めて保存はしません)。";
/** 競合 (409) で保存を止めたときの案内。下書きは残し、再読み込みを促す */
export const FILE_SKILL_CONFLICT_NOTE =
  "他の変更と競合しました。入力した内容はこのまま残しています。再読み込みしてから、もう一度保存してください。";
export const FILE_SKILL_EDIT_LABEL = "編集";
export const FILE_SKILL_ADD_LABEL = "新しいスキル";
export const FILE_SKILL_CREATE_HEADING = "新しいスキル";
export const FILE_SKILL_SAVE_LABEL = "保存";
export const FILE_SKILL_CANCEL_LABEL = "キャンセル";
export const FILE_SKILL_DELETE_LABEL = "削除";
export const FILE_SKILL_NAME_LABEL = "名前";
export const FILE_SKILL_NAME_READONLY_NOTE = "名前は変更できません。";
export const FILE_SKILL_DESCRIPTION_LABEL = "説明";
export const FILE_SKILL_BODY_LABEL = "本文";
/** 本文ビューの見出し。一覧のグループ名 (共通 / プロジェクト / 組み込み) と同じ語を使う */
export const FILE_SKILL_PANEL_HEADING: Record<FileSkillInfo["scope"], string> = {
  user: "共通スキル",
  project: "プロジェクトスキル",
  builtin: "組み込みスキル",
};
/** 詳細のタブ。ファイルは root を導けるスキルだけ、使用中は読み取り専用の一覧 */
export const SKILL_TAB_BODY_LABEL = "本文";
export const SKILL_TAB_FILES_LABEL = "ファイル";
export const SKILL_TAB_USAGE_LABEL = "使用中";
/** 詳細のタブ行の読み上げ名 */
export const SKILL_DETAIL_TABS_ARIA_LABEL = "スキルの面";
/** 使用中タブの前置き。ここから割り当ては変えない (読み取り専用) */
export const SKILL_USAGE_TAB_NOTE = "このスキルを使うエージェント。切り替えは「エージェント」画面で行います。";
/** 使用中タブが空のときの案内 */
export const SKILL_USAGE_EMPTY_NOTE = "このスキルを使うユーザー定義エージェントはありません。";
/** 一覧の行に出す「使用中エージェント数」の読み上げ名。件数の意味は skillUsage.ts が正 */
export function fileSkillUsageLabel(count: number): string {
  return `使用中 ${count} 体`;
}
/** 本文の取得中 / 失敗の表示。組み込みは一覧の応答に本文が載るため、ファイルスキルだけが通る */
export const FILE_SKILL_BODY_LOADING_NOTE = "本文を読み込んでいます…";
export const FILE_SKILL_BODY_ERROR_PREFIX = "本文を取得できませんでした";

/** 一覧のスコープタブ。「すべて」では組み込みを先頭に並べる */
export type FileSkillScopeTab = "all" | "builtin" | "common";
export const FILE_SKILL_SCOPE_TABS: { value: FileSkillScopeTab; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "builtin", label: "組み込み" },
  { value: "common", label: "共通" },
];

/** 一覧の件数。スコープタブの数字は検索で絞る前の件数を出す */
export function fileSkillScopeCounts(skills: readonly FileSkillInfo[]): Record<FileSkillScopeTab, number> {
  const builtin = skills.filter((skill) => skill.scope === "builtin").length;
  return { all: skills.length, builtin, common: skills.length - builtin };
}

/**
 * 一覧の絞り込み。**表示だけ**を絞る (個別の選択や詳細の対象には使わない)。
 * 「すべて」は組み込みを先頭にし、各スコープの中では取得順を保つ。名前と説明で探す。
 */
export function filterFileSkills(
  skills: readonly FileSkillInfo[],
  scope: FileSkillScopeTab,
  query: string,
): FileSkillInfo[] {
  const byScope = skills.filter((skill) =>
    scope === "all" ? true : scope === "builtin" ? skill.scope === "builtin" : skill.scope !== "builtin",
  );
  const ordered =
    scope === "all"
      ? [...byScope].sort((a, b) => Number(a.scope !== "builtin") - Number(b.scope !== "builtin"))
      : byScope;
  return filterBySearch(ordered, query, (skill) => [skill.name, skill.description]);
}

/** 選択が無いときの右ペインの案内。作成できない状態では「新しいスキル」を案内しない (追加行も出ない) */
export const FILE_SKILL_PANE_NOTE =
  "一覧からスキルを選ぶと、説明と本文を表示します。共通スキルは「新しいスキル」から作成できます。";
export const FILE_SKILL_PANE_LOADING_NOTE = "一覧からスキルを選ぶと、説明と本文を表示します。スキルを読み込んでいます…";
export const FILE_SKILL_PANE_ERROR_NOTE =
  "一覧からスキルを選ぶと、説明と本文を表示します。一覧を取得できていないため、新しいスキルは作成できません。";

/**
 * エクスポート / インポート (`.agents/skills` の ZIP)。一覧の見出し行に並べる操作 (docs/api-catalog.md)。
 * 操作の対象 (ZIP の出入り) がラベルだけで読めるよう、画面の語は 持ち出し / 取り込み ではなくこの対で揃える。
 */
export const SKILL_EXPORT_LABEL = "エクスポート";
export const SKILL_IMPORT_LABEL = "インポート";
export const SKILL_EXPORT_EMPTY_NOTE = "エクスポートできるスキルがありません。";
export const SKILL_EXPORT_STARTED_NOTE = "ZIP の保存を開始しました。";
export const SKILL_IMPORT_NOT_ZIP_NOTE = "ZIP ファイル（.zip）を選んでください。";
export const SKILL_IMPORT_DIALOG_TITLE = "ZIP をインポート";
export const SKILL_IMPORT_FILE_LABEL = "インポートする ZIP";
export const SKILL_IMPORT_PLANNING_NOTE = "ZIP の内容を確認しています…";
export const SKILL_IMPORT_APPLY_LABEL = "インポート";
export const SKILL_IMPORT_APPLYING_LABEL = "インポートしています…";
export const SKILL_IMPORT_CLOSE_LABEL = "閉じる";
export const SKILL_IMPORT_NOTHING_NOTE = "インポートするスキルがありません。";
export const SKILL_IMPORT_PLAN_HEADING = "インポートする内容";
export const SKILL_IMPORT_SELECT_ALL_LABEL = "同名をすべて選ぶ";
export const SKILL_IMPORT_APPLIED_HEADING = "インポートしたスキル";
export const SKILL_IMPORT_SKIPPED_HEADING = "インポートしなかったスキル";
export const SKILL_IMPORT_APPLIED_NEW_NOTE = "追加しました。";
export const SKILL_IMPORT_APPLIED_REPLACED_NOTE = "同名のスキルを置き換えました。";

/** plan の 1 行の状態。インポートする / 書き込まない / 選べる / 選べないの別をここに閉じる */
export type SkillImportStatus = SandboxSkillImportPlanEntry["status"];
export const SKILL_IMPORT_STATUS_LABEL: Record<SkillImportStatus, string> = {
  new: "新規",
  identical: "内容が同一",
  conflict: "同名あり",
  invalid: "インポートしない",
};
export const SKILL_IMPORT_STATUS_NOTE: Record<SkillImportStatus, string> = {
  new: "インポートします。",
  identical: "内容が同じなので書き込みません。",
  conflict: "同名のスキルがあります。",
  invalid: "インポートしません。",
};

/** plan の見積り。件数はディレクトリを含む ZIP のエントリ数で、サイズは展開後 (上限の判定と同じ値) */
export function skillImportPlanNote(entries: number, bytes: number): string {
  return `ZIP のエントリ数 ${entries} 件 / 展開後 ${formatBytes(bytes)}`;
}

/** 実行前に示す件数。new は常にインポートし、identical / invalid は常に対象外で、conflict は選択分だけ */
export function skillImportSummary(imported: number, replaced: number): string {
  return replaced > 0
    ? `インポートするスキル ${imported} 件（うち同名の置き換え ${replaced} 件）`
    : `インポートするスキル ${imported} 件`;
}

/** 適用後の結果。部分適用の有無は出さず、件数だけを示す (スキルごとの内訳はダイアログの一覧) */
export function skillImportDoneNote(applied: number, skipped: number): string {
  return `スキルをインポートしました（${applied} 件 / 省略 ${skipped} 件）。`;
}

/**
 * ファイルタブの root にできるスキルディレクトリ (root 相対)。組み込みは実体の無い仮想パス、root の外は
 * 絶対パスで返るため、どちらもここで落とす。判定は normalizeFileTreeRoot より前に行う (絶対パスは
 * "." へ畳まれ、ワークスペース root を見せてしまう)。
 */
export function fileSkillDir(skill: Pick<FileSkillInfo, "scope" | "relativePath">): string | null {
  if (skill.scope === "builtin") return null;
  const path = skill.relativePath;
  // バックスラッシュは区切りとして扱わない (Windows の絶対パスを root 相対と誤認しない)
  if (!path || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return null;
  const segments = path.split("/");
  // 親参照はツリーの root を外へ動かす (release..notes のような名前は巻き込まない)
  if (segments.some((segment) => segment === ".." || segment === "")) return null;
  if (segments.length < 2 || segments[segments.length - 1] !== "SKILL.md") return null;
  return segments.slice(0, -1).join("/");
}

/** 一覧のグループ分け。組み込みは別グループで表示する (読み取り専用で、上書き状態を持つ) */
export function groupFileSkills(skills: FileSkillInfo[]): { common: FileSkillInfo[]; builtin: FileSkillInfo[] } {
  const common: FileSkillInfo[] = [];
  const builtin: FileSkillInfo[] = [];
  for (const skill of skills) {
    if (skill.scope === "builtin") builtin.push(skill);
    else common.push(skill);
  }
  return { common, builtin };
}

/**
 * 行に出す注意書き。共通 / プロジェクトの重複は「どちらが有効か」、組み込みは「上書きされている」を示す
 * (組み込み側には shadowed ではなく overridden が立つ)。注意が無ければ null。
 */
export function fileSkillWarning(skill: FileSkillInfo): string | null {
  if (skill.scope === "builtin") return skill.overridden ? BUILTIN_SKILL_OVERRIDE_NOTE : null;
  if (skill.shadowed.length === 0) return null;
  const shadowed = skill.shadowed.map((item) => item.relativePath).join(", ");
  return `同名のスキルが ${skill.shadowed.length + 1} 件あります。有効: ${skill.relativePath} / 読み込まれない: ${shadowed}`;
}
