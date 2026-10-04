/**
 * 作業環境 → 環境変数タブの表示と入力の規則。値そのものは状態に持たない (フォームの入力欄だけが持つ) ため、
 * ここは名前の見せ方と文言だけを決める純関数に閉じる。検証の正はサーバー (server/src/secrets.ts)。
 */
import type { SecretItem } from "../types";
import type { ConfirmRequest } from "./confirmDialog";

/** 8 文字未満のシークレットは自動マスクの対象外 (server/src/redact.ts の MIN_SECRET_LENGTH と同じ値) */
export const SECRET_MASK_MIN_LENGTH = 8;

/** 削除の確認。対象は clamp した独立した行へ出し、シークレットは値が戻せないことを先に伝える */
export function secretDeleteConfirmRequest(item: Pick<SecretItem, "name" | "kind">): ConfirmRequest {
  const secret = item.kind === "secret";
  return {
    kind: "confirm",
    title: `${secret ? "シークレット" : "環境変数"}を削除`,
    subject: { label: secret ? "削除するシークレット" : "削除する変数", value: item.name },
    ...(secret ? { body: ["保存した値は再取得できません。"] } : {}),
    confirmLabel: "削除する",
    danger: true,
  };
}

/** タブ上部の 1 行。反映の境界は「保存」ではなく「次回の起動」 */
export const ENV_RESTART_NOTE = "シークレットの変更は次回の起動から反映されます";

/** プロジェクト所属の cwd を共有しているときだけ出す 1 行 */
export const ENV_PROJECT_NOTE = "このプロジェクトの設定です";

/** シークレットの説明。値を見せない代わりに、何ができないかを先に書く */
export const ENV_SECRET_NOTES: readonly string[] = [
  "シークレットはこの会話上では参照できません",
  "保存後に値を再取得できません",
  "サービスとして起動したときだけ参照できます",
];

/** 変数の説明。エージェントに見えることが変数の利点であるため、そこを明示する */
export const ENV_VARIABLE_NOTES: readonly string[] = [
  "この会話のエージェントにも見えます（bash の printenv に出ます）",
  "サービスとして起動したときだけ参照できます",
];

/** シークレットの入力が短いときの注記 (誤解したまま保存させない) */
export const ENV_SHORT_SECRET_NOTE = "短い値は自動マスクされません";

/** 前後の空白 / 改行を除去したときの注記。加工した事実を必ず出す */
export const ENV_TRIM_NOTE = "前後に空白 / 改行があったため除去しました";

/** 名前の入力プレビュー。保存・注入・表示の正規化 (trim + 大文字化) と同じ結果を見せる */
export function envNamePreview(raw: string): string {
  return raw.trim().toUpperCase();
}

export function envKindLabel(kind: SecretItem["kind"]): string {
  return kind === "secret" ? "シークレット" : "変数";
}

export function envKindNotes(kind: SecretItem["kind"]): readonly string[] {
  return kind === "secret" ? ENV_SECRET_NOTES : ENV_VARIABLE_NOTES;
}

/** 入力中の値が「自動マスクされない長さ」か。空欄では出さない (保存前の注記なので) */
export function shortSecretNote(kind: SecretItem["kind"], value: string): string | undefined {
  return kind === "secret" && value.length > 0 && value.length < SECRET_MASK_MIN_LENGTH
    ? ENV_SHORT_SECRET_NOTE
    : undefined;
}

/**
 * 追加フォームの送信可否。空の名前 / 値はサーバーへ送らない (400 の往復を待たずに入力欄で示す)。
 * 名前の正規化後の内容で見るため、空白だけの名前も送らない。
 */
export function canSubmitEnvDraft(draft: { name: string; value: string }): boolean {
  return envNamePreview(draft.name) !== "" && canSubmitEnvValue(draft.value);
}

/**
 * 変更フォームの送信可否。名前と種別は変えられないため値だけで判定する
 * (変更時は名前の入力欄を出さず、name の state も更新しない)。
 */
export function canSubmitEnvValue(value: string): boolean {
  return value.trim() !== "";
}

/** 行の名前。コピー導線とエージェント向けの一覧に同じ並びを使う */
export function envNameList(items: readonly SecretItem[]): string[] {
  return items.map((item) => item.name);
}

/** 作業環境パネルのタブ。並びは表示順そのもの */
export type SessionEnvTab = "files" | "env";

export const SESSION_ENV_TABS: readonly { id: SessionEnvTab; label: string }[] = [
  { id: "files", label: "作業フォルダ" },
  { id: "env", label: "環境変数" },
];

/**
 * 出せるタブ。作業フォルダは root が決まっているとき、環境変数は要求元 (会話 or 作成先プロジェクト) が
 * あるときに出す。cwd が決まっている会話では両方なので、片方だけの面ではタブバーごと出さない
 * (押しても変わらない行を残さない)。設定ページは呼び出し側がパネル自体を出さない。
 */
export function sessionEnvTabs(input: {
  root: string;
  scope: SessionEnvScope | null;
}): readonly { id: SessionEnvTab; label: string }[] {
  return SESSION_ENV_TABS.filter((tab) => (tab.id === "files" ? input.root !== "" : input.scope !== null));
}

/** 環境変数タブの要求元 (server の SecretsScope と同形) */
export type SessionEnvScope = { sessionId?: string; projectId?: string };

/**
 * 要求元の識別子。パネルの key と取得の依存に使い、**cwd を共有する会話の切替でも**
 * 別の値になるようにする (切り替えでフォームのドラフトを破棄するため)。
 * どちらも無い (未所属の新規会話) は空文字で、タブを出さない。
 */
export function sessionEnvScopeKey(scope: SessionEnvScope): string {
  if (scope.sessionId) return `session:${scope.sessionId}`;
  if (scope.projectId) return `project:${scope.projectId}`;
  return "";
}

/**
 * 識別子から要求元へ戻す。取得の依存を「値が変わったか」だけで比べるために使う
 * (scope は毎描画で新しい object になるため、effect の依存にできない)。
 */
export function sessionEnvScopeFromKey(key: string): SessionEnvScope {
  if (key.startsWith("session:")) return { sessionId: key.slice("session:".length) };
  if (key.startsWith("project:")) return { projectId: key.slice("project:".length) };
  return {};
}

/**
 * 環境変数タブの要求元。会話があれば sessionId、未作成なら作成先プロジェクトの projectId。
 * 所有者は cwd なので会話 ID は必須ではなく、プロジェクト起点の新規会話でも保存できる。
 * 未所属の新規会話 (どちらも無い) は null で、タブを出さない。
 */
export function sessionEnvScope(input: { sessionId: string; projectId: string }): SessionEnvScope | null {
  if (input.sessionId) return { sessionId: input.sessionId };
  if (input.projectId) return { projectId: input.projectId };
  return null;
}

/** 変更フォームに初期値として入れる値。変数は保存済みの値をプリフィルし、シークレットは空欄にする */
export function initialDraftValue(item: SecretItem, values: Readonly<Record<string, string>>): string {
  return item.kind === "variable" ? (values[item.secretId] ?? "") : "";
}
