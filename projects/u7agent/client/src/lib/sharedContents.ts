/**
 * 共有ダイアログの文言と状態の見せ方。公開は非同期なので、`publishing` の間だけポーリングし、
 * 終端は `status` と `lastError` の組で読む（契約は docs/static-sharing.md）。
 */
import type { SharedContentResponse } from "../types";

/** 状態を読み直す間隔。公開ジョブの所要は数十秒なので、待ちすぎず叩きすぎない値にする */
export const SHARE_POLL_MS = 2000;

/**
 * 確認画面に必ず出す条件。順序も含めて契約にする（公開は取り消しにくいので、押す前に全部読めるようにする）。
 * 確定した URL は受付時に決まるため、ここには URL を出さない。
 */
export const SHARE_CONFIRM_NOTES: readonly string[] = [
  "URL を知っていれば誰でも見られます（認証・期限はありません）。",
  "静的ファイルに含めた秘密値（API キー・トークンなど）も、そのまま公開されます。",
  "公開すると確定した URL が発行されます。URL は受付時に決まるため、公開前には表示できません。",
  "Cloudflare（workers.dev）へ公開します。サービス（一時プレビュー）とは別で、この画面からは停止・削除ができません。",
];

export type ShareStatusTone = "busy" | "ok" | "warn" | "danger";

/** 1 件の共有物の見せ方。`openUrl` は外部で開いてよい URL だけを持つ */
export type ShareStatusView = {
  label: string;
  tone: ShareStatusTone;
  openUrl: string | null;
  /** 補足。`lastError` は BFF の分類済み文言をそのまま出し、こちらで言い換えない */
  note: string | null;
};

/** 状態の見せ方。`published` + `lastError` は「前の版が生きている」ので、URL を出しつつ理由も添える */
export function shareStatusView(item: SharedContentResponse): ShareStatusView {
  const url = item.publicUrl;
  switch (item.status) {
    case "publishing":
      return item.lastError === null
        ? { label: "公開中", tone: "busy", openUrl: null, note: null }
        : { label: "結果不明", tone: "warn", openUrl: null, note: item.lastError };
    case "published":
      return { label: "公開済み", tone: "ok", openUrl: url, note: item.lastError };
    case "stopped":
      return { label: "停止中", tone: "warn", openUrl: null, note: item.lastError };
    case "failed":
      return { label: "公開できませんでした", tone: "danger", openUrl: null, note: item.lastError };
  }
}

/** 公開がまだ進行中の共有物があるか。1 件でもあれば一覧を取り直す */
export function shareItemsPublishing(items: readonly SharedContentResponse[]): boolean {
  return items.some((item) => item.status === "publishing");
}

export type SharePollPlan = { kind: "detail"; id: string } | { kind: "list" } | null;

/**
 * 次に読む対象。受付直後の 1 件は詳細で追い（一覧にまだ載っていない間も含む）、
 * それ以外の進行中は一覧の取り直しで追う。`null` = 読む必要が無い。
 */
export function sharePollPlan(activeId: string | null, items: readonly SharedContentResponse[]): SharePollPlan {
  const active = activeId === null ? undefined : items.find((item) => item.id === activeId);
  if (activeId !== null && (active === undefined || active.status === "publishing")) {
    return { kind: "detail", id: activeId };
  }
  if (shareItemsPublishing(items)) return { kind: "list" };
  return null;
}

/** 受付した 1 件を一覧へ差し替える（未取得なら先頭に足す）。詳細のポーリング結果を反映する 1 箇所 */
export function withSharedContent(
  items: readonly SharedContentResponse[],
  item: SharedContentResponse,
): SharedContentResponse[] {
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index === -1) return [item, ...items];
  return items.map((entry) => (entry.id === item.id ? item : entry));
}
