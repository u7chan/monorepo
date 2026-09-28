/**
 * セッションのスキル一覧 (GET /api/sessions/:id/skills と、セッション未確定の GET /api/skills/session) の
 * 取得先と表示用の導出。取得先の切替・状態の文言・グループ分け・注意書き・場所の表示をここ 1 箇所へ閉じ、
 * フックとコンポーネントは結果を使うだけにする (docs/api-sessions.md)。
 * 再取得 (ポップアップを開き直したとき) の結果の畳み方もここに置く: 一覧を持っている間の失敗は
 * `reloadError` にして一覧を残す (索引として使える方が得なので、一瞬の失敗で消さない)。
 * 形式の正はサーバーの SessionSkillInfo で、ここは文言と取得先だけを持つ。
 */
import type { SessionSkillInfo, SessionSkillsPreview, SessionSkillsResponse } from "../types";

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
export const SESSION_SKILL_ERROR_PREFIX = "スキルを取得できませんでした";
/** 取得先がまだ判明していないときだけ出す (その間はボタンを押せない)。セッションの有無とは別 */
export const SESSION_SKILL_UNAVAILABLE_NOTE =
  "スキル一覧を取得できる状態ではありません（起動処理の完了後に使えます）。";
/** ファイルスキルは一覧のたびに探索し直し、カタログの本文はセッション作成時のスナップショットになる */
export const SESSION_SKILL_BODY_NOTE = "本文は送信時に読み直します（ファイルスキルは一覧のたびに探索し直します）。";
/** 再取得だけが失敗したときの 1 行。持っている一覧は残すので、空 / 失敗とは別の文言にする */
export const SESSION_SKILL_RELOAD_ERROR_PREFIX = "一覧を更新できませんでした";
export const SESSION_SKILL_DISABLED_NOTE = "モデルからは呼ばれません（手動でのみ実行できます）";
export const SESSION_SKILL_SHADOWED_NOTE = "同名のスキルが優先されます（この行は使われません）";

/**
 * 一覧の状態。`unavailable` は取得先がまだ判明していないときだけ (起動直後は保存された選択がまだ
 * 検証されていない) で、その間はボタンを押せない。取得先がある状態での失敗は `error` にして、
 * パネルに理由を出す (ボタンは押せるままにする)。
 */
export type SessionSkillsState =
  | { status: "unavailable" }
  | { status: "loading" }
  /** `reloadError` は一覧を保ったまま再取得に失敗したときだけ入る (一覧は索引なので捨てない) */
  | { status: "ready"; skills: SessionSkillInfo[]; projectSkills: boolean; reloadError?: string }
  | { status: "error"; message: string };

/** 一覧の取得先。セッションが確定していればセッション基準、無ければ新規チャットのプレビュー */
export type SessionSkillsSource =
  | { kind: "session"; sessionId: string }
  | { kind: "preview"; projectId: string; agentId: string };

/**
 * 取得先。sessionId があれば既存 API (セッションのスナップショットで解決する)、無ければ作成前の
 * 選択 (プロジェクト / エージェント。未選択は "") を使う。
 */
export function sessionSkillsSource(sessionId: string, projectId: string, agentId: string): SessionSkillsSource {
  return sessionId ? { kind: "session", sessionId } : { kind: "preview", projectId, agentId };
}

/**
 * 取得キー。これが変わるときだけ取り直す。セッションがあればセッションで一意になり、開いている間に
 * プロジェクト / エージェントを切り替えても同じ一覧なので取り直さない (ファイルの再走査と読込表示を避ける)。
 */
export function sessionSkillsSourceKey(source: SessionSkillsSource): string {
  return source.kind === "session" ? `session:${source.sessionId}` : `preview:${source.projectId}:${source.agentId}`;
}

/** 一覧の取得。フックは api.ts を渡し、テストは stub を渡す */
export type SessionSkillsFetchers = {
  session: (sessionId: string) => Promise<SessionSkillsResponse>;
  preview: (input: { projectId: string; agentId: string }) => Promise<SessionSkillsPreview>;
};

/**
 * 取得先 1 つ分の一覧を取り、`canApply` が真のときだけ `setState` へ渡す。切替中に届いた古い応答はここで
 * 捨てる (プレビュー取得中に project / agent が変わる、送信中に別チャットへ移る)。適用は functional な
 * 更新にする: 初回取得では前の `loading` を、再取得では持っている一覧を保つかの判断を呼び出し側が持つ。
 */
export async function fetchSessionSkills(
  source: SessionSkillsSource,
  fetchers: SessionSkillsFetchers,
  canApply: () => boolean,
  setState: (update: (previous: SessionSkillsState) => SessionSkillsState) => void,
): Promise<void> {
  try {
    const response =
      source.kind === "session" ? await fetchers.session(source.sessionId) : await fetchers.preview(source);
    if (canApply())
      setState((previous) =>
        reduceSessionSkills(previous, { ok: true, skills: response.skills, projectSkills: response.projectSkills }),
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (canApply()) setState((previous) => reduceSessionSkills(previous, { ok: false, message }));
  }
}

/** 取得の結果。`ok` は一覧が取れたことだけを指し、失敗の行き先は前の状態が決める */
export type SessionSkillsResult =
  | { ok: true; skills: SessionSkillInfo[]; projectSkills: boolean }
  | { ok: false; message: string };

/**
 * 取得の結果を今の状態へ重ねる。一覧を持っている間の失敗は `reloadError` にして一覧を残す
 * (索引として使える方が得なので、一瞬の失敗で消さない)。持っていなければ `error` にする。
 */
export function reduceSessionSkills(previous: SessionSkillsState, result: SessionSkillsResult): SessionSkillsState {
  if (result.ok) return { status: "ready", skills: result.skills, projectSkills: result.projectSkills };
  if (previous.status === "ready") return { ...previous, reloadError: result.message };
  return { status: "error", message: result.message };
}

/**
 * 再取得の開始。持っている一覧は消さない (消すと読込表示へ戻ってポップアップの高さが跳ねる)。
 * 一覧が無い (`loading` / `error` / `unavailable`) ときは通常の読込表示へ戻す。
 */
export function startSessionSkillsReload(previous: SessionSkillsState): SessionSkillsState {
  return previous.status === "ready" ? previous : { status: "loading" };
}

/** パネルに出す状態の 1 行。一覧を出せている (ready かつ 1 件以上で再取得も成功) ときは何も出さない */
export function sessionSkillsNotice(state: SessionSkillsState): { text: string; warn: boolean; retry: boolean } | null {
  if (state.status === "loading") return { text: SESSION_SKILL_LOADING_NOTE, warn: false, retry: false };
  if (state.status === "unavailable") return { text: SESSION_SKILL_UNAVAILABLE_NOTE, warn: false, retry: false };
  if (state.status === "error")
    return { text: `${SESSION_SKILL_ERROR_PREFIX}: ${state.message}`, warn: true, retry: true };
  // 失敗していても一覧は出せるので、0 件の注意より先に理由を見せる
  if (state.reloadError)
    return { text: `${SESSION_SKILL_RELOAD_ERROR_PREFIX}: ${state.reloadError}`, warn: true, retry: true };
  return state.skills.length === 0 ? { text: SESSION_SKILL_EMPTY_NOTE, warn: false, retry: true } : null;
}

/** 選択で入力欄へ入れるコマンド。末尾の空白は引数を続けて書くため */
export function skillCommandText(name: string): string {
  return `/skill:${name} `;
}

/** location を表示用にする。root 配下は root 相対へ落とし、root の外の値はそのまま返す */
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

/** 行の補足 (場所)。カタログは実体の無い仮想パスなので、そのまま (root 相対で) 示す */
export function sessionSkillLocation(skill: SessionSkillInfo, rootCwd: string): string {
  if (skill.relativePath) return skill.relativePath;
  return skillLocationLabel(rootCwd, skill.location);
}
