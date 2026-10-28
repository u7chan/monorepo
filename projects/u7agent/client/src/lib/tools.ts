/**
 * ツール欄の文言と並びの索引。応答 (`GET /api/agents` の `tools`) はコードだけを返すので、
 * 利用者に見せる文言はここに置く (既存の分担は `fileSkills.ts` / `settingsNotes.ts` と同じ)。
 */
import type { ToolCatalogEntry, ToolGroup, ToolUnavailableReason } from "../types";

/** グループの並び。レジストリの `group` の値は API の契約で、表示順はここが決める */
export const TOOL_GROUP_ORDER: ToolGroup[] = ["sandbox", "app"];

/** グループ見出し。種別ごとの語はここ 1 箇所 */
export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = {
  sandbox: "作業ツール",
  app: "アプリのツール",
};

/**
 * アプリ側で使えない理由の文言。チェックを入れても使えないことを必ず含める (行は出したままにする)。
 * 理由にコードを返すのは API、文言を持つのはクライアント、という分担のクライアント側。
 */
const UNAVAILABLE_NOTES: Record<ToolUnavailableReason, string> = {
  deploy_allowlist: "この構成では無効です（PI_AGENT_TOOLS）。チェックしても使えません",
  app_disabled: "アプリ側で無効です。チェックしても使えません",
  no_key: "キーが未設定です。チェックしても使えません",
};

/** サーバーが理由コードを増やしても画面を壊さないよう、未知の値は汎用の文言へ落とす */
export function unavailableToolNote(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return UNAVAILABLE_NOTES[reason as ToolUnavailableReason] ?? "いまは使えません。チェックしても使えません";
}

/**
 * 外した行に出す依存の注記。外すと何が動かなくなるかを名前で引くため、ツールが増えても
 * 対応する注記が無ければ何も出ない。
 */
const TOOL_OFF_HINTS: Record<string, string> = {
  read: "スキル本文を読めなくなり、スキルは一覧の索引だけが残ります",
  serve: "組み込みスキル serve の手順はこのツールを使うため、手順どおりに実行できません",
  bash: "edit / write を外しても、bash からはファイルへ書き込めます",
};

export function offToolNote(name: string): string | undefined {
  return TOOL_OFF_HINTS[name];
}

/** 保存名のうち一覧に無いもの (改名・削除・同梱の入れ替え)。落とさず残すことを注記で知らせる */
export function missingToolNote(names: string[]): string {
  return `見つかりません: ${names.join("、")}（一覧が入れ替わっても、保存した名前はそのまま残ります）`;
}

/** 明示リストは対象の名前だけを使う。あとから増えたツールを勝手に許可しないことを知らせる */
export const TOOL_EXPLICIT_NOTE = "選んだ名前だけを使います。あとから増えたツールは自動では選ばれません。";

/**
 * ツールカードの注記。伝えるのは (1) 外すと新しい会話で使えなくなる (既存の会話には効かない)
 * (2) アプリ側で無効なものはチェックが入っていても使えない (3) 画像 / 音声はキー未設定でも使えない、の 3 点。
 * (3) は「アプリ側で無効」に含まれるが、設定を変えれば使えるようになることが分かるよう名前を出す。
 */
export const TOOL_CARD_NOTE =
  "チェックを外すと、新しい会話でそのツールを使えなくなります（開いている会話の振る舞いは変わりません）。アプリ側で無効なツールは、チェックが入っていても使えません（理由は行に出ます。キー未設定の画像 / 音声も同じです）。";

/** カタログを取得できていないときの代わり。空の一覧と見分けが付かないので、行ではなく理由を出す */
export const TOOL_CATALOG_UNAVAILABLE_NOTE =
  "ツールの一覧を取得できませんでした。アプリの状態を確認して、このページを開き直してください。";

/** グループごとに分ける。未知の group は捨てる (表示順は上の定数が正) */
export function groupTools(tools: ToolCatalogEntry[]): Array<{ group: ToolGroup; tools: ToolCatalogEntry[] }> {
  return TOOL_GROUP_ORDER.map((group) => ({ group, tools: tools.filter((tool) => tool.group === group) })).filter(
    (entry) => entry.tools.length > 0,
  );
}
