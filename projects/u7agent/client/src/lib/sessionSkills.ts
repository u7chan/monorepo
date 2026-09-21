/**
 * セッションのスキル一覧 (GET /api/sessions/:id/skills) の表示用の導出。グループ分け・注意書き・
 * 場所の表示をここ 1 箇所へ閉じ、コンポーネントは結果を描画するだけにする (docs/api-sessions.md)。
 * 形式の正はサーバーの SessionSkillInfo で、ここは文言だけを持つ。
 */
import type { SessionSkillInfo } from "../types";

export const SESSION_SKILL_SCOPE_LABEL: Record<SessionSkillInfo["scope"], string> = {
  project: "プロジェクト",
  user: "共通",
  builtin: "組み込み",
  catalog: "エージェント定義",
};

/** 一覧のグループ順。優先順位 (project > user > builtin > catalog) と同じ順に見せる */
export const SESSION_SKILL_SCOPE_ORDER: SessionSkillInfo["scope"][] = ["project", "user", "builtin", "catalog"];

export const SESSION_SKILL_LOADING_NOTE = "スキルを読み込んでいます…";
export const SESSION_SKILL_EMPTY_NOTE = "使えるスキルはありません。";
export const SESSION_SKILL_UNAVAILABLE_NOTE = "メッセージを送るとセッションが始まり、スキル一覧を使えます。";
export const SESSION_SKILL_BODY_NOTE = "本文は送信時に読み直します（一覧と優先順位はセッション作成時の内容）。";
export const SESSION_SKILL_DISABLED_NOTE = "モデルからは呼ばれません（手動でのみ実行できます）";
export const SESSION_SKILL_SHADOWED_NOTE = "同名のスキルが優先されます（この行は使われません）";

/** 選択で入力欄へ入れるコマンド。末尾の空白は引数を続けて書くため */
export function skillCommandText(name: string): string {
  return `/skill:${name} `;
}

/** location を表示用にする。root 配下は root 相対へ落とし、仮想の値 (catalog:…) はそのまま返す */
export function skillLocationLabel(rootCwd: string, location: string): string {
  const normalized = location.replace(/\\/g, "/");
  const root = rootCwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

/** 一覧のグループ分け。空のスコープは出さない (グループ見出しだけが残らないようにする) */
export function groupSessionSkills(
  skills: SessionSkillInfo[],
): Array<{ scope: SessionSkillInfo["scope"]; label: string; skills: SessionSkillInfo[] }> {
  const groups: Array<{ scope: SessionSkillInfo["scope"]; label: string; skills: SessionSkillInfo[] }> = [];
  for (const scope of SESSION_SKILL_SCOPE_ORDER) {
    const items = skills.filter((skill) => skill.scope === scope);
    if (items.length > 0) groups.push({ scope, label: SESSION_SKILL_SCOPE_LABEL[scope], skills: items });
  }
  return groups;
}

/**
 * 行に出す注意書き。使われない行 (同名の上位スコープがある) はその理由と優先される側を示し、
 * 採用された行は隠している側を示す。注意が無ければ null。
 */
export function sessionSkillWarning(skill: SessionSkillInfo, rootCwd: string): string | null {
  if (skill.shadowed) {
    const winner = skill.shadowedBy ? `: ${skillLocationLabel(rootCwd, skill.shadowedBy)}` : "";
    return `${SESSION_SKILL_SHADOWED_NOTE}${winner}`;
  }
  if (skill.shadows.length === 0) return null;
  const hidden = skill.shadows.map((location) => skillLocationLabel(rootCwd, location)).join(", ");
  return `同名のスキルは読み込まれません: ${hidden}`;
}

/** 行の補足 (場所)。カタログは実ファイルが無いので「エージェント定義」と示す */
export function sessionSkillLocation(skill: SessionSkillInfo, rootCwd: string): string {
  if (skill.relativePath) return skill.relativePath;
  return skillLocationLabel(rootCwd, skill.location);
}
