/**
 * 共有ダイアログの文言と状態の見せ方。公開は非同期なので、`publishing` の間だけポーリングし、
 * 終端は `status` と `lastError` の組で読む（契約は docs/static-sharing.md）。
 */
import type { SharedContentResponse } from "../types";
import type { ConfirmRequest } from "./confirmDialog";

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

/** 公開がまだ進行中の共有物があるか。`exceptId` を渡すとその 1 件は数えない */
export function shareItemsPublishing(items: readonly SharedContentResponse[], exceptId: string | null = null): boolean {
  return items.some((item) => item.status === "publishing" && item.id !== exceptId);
}

/** 次の tick で読む対象。両方 true なら 1 tick で両方を読む */
export type SharePollPlan = {
  /** 受付した 1 件の詳細。null = 追う必要が無い */
  detailId: string | null;
  /** 一覧の取り直し。受付した 1 件とは別に進行中の共有物があるときだけ要る */
  list: boolean;
};

/**
 * 詳細だけにすると受付後に一覧の他の進行中が止まったままになるため、両方を 1 tick で追う。
 * 受付した 1 件は一覧にまだ載っていない間も詳細で追う。
 */
export function sharePollPlan(activeId: string | null, items: readonly SharedContentResponse[]): SharePollPlan {
  const active = activeId === null ? undefined : items.find((item) => item.id === activeId);
  return {
    detailId: activeId !== null && (active === undefined || active.status === "publishing") ? activeId : null,
    list: shareItemsPublishing(items, activeId),
  };
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

/**
 * 受付済み（202）の共有物 id を、終端を確認するまで保持する。受付直後の一覧取得が失敗すると
 * 手元の items は操作前の状態のままなので、これが無いとポーリングが始まらない。
 */
export function trackAcceptedSharedContent(tracked: readonly string[], id: string): string[] {
  return tracked.includes(id) ? [...tracked] : [...tracked, id];
}

/** 取得できた一覧で publishing のままの id だけを残す。終端・消失した id は追跡をやめる */
export function settleAcceptedSharedContent(
  tracked: readonly string[],
  items: readonly SharedContentResponse[],
): string[] {
  if (tracked.length === 0) return [];
  const publishing = new Set(items.filter((item) => item.status === "publishing").map((item) => item.id));
  return tracked.filter((id) => publishing.has(id));
}

/** 一覧を取り直し続ける必要があるか。受付済みで未確認の id があれば、items が古くても追跡を続ける */
export function sharedContentsPolling(items: readonly SharedContentResponse[], tracked: readonly string[]): boolean {
  return tracked.length > 0 || shareItemsPublishing(items);
}

/** 管理一覧の状態フィルタ。`publishing` は結果不明（lastError 付き）も含む（status は publishing のまま） */
export type SharedContentsFilter = "all" | "published" | "publishing" | "stopped" | "failed";

export const SHARED_CONTENT_FILTERS: readonly { key: SharedContentsFilter; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "published", label: "公開済み" },
  { key: "publishing", label: "処理中" },
  { key: "stopped", label: "停止中" },
  { key: "failed", label: "失敗" },
];

/** フィルタごとの件数。`all` を先頭に、状態の値と同名のキーで返す */
export function sharedContentFilterCounts(
  items: readonly SharedContentResponse[],
): Record<SharedContentsFilter, number> {
  const counts: Record<SharedContentsFilter, number> = {
    all: items.length,
    published: 0,
    publishing: 0,
    stopped: 0,
    failed: 0,
  };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

/** 一覧の絞り込み。`all` はそのまま返し、並びは API の順（更新の新しい順）を変えない */
export function filterSharedContents(
  items: readonly SharedContentResponse[],
  filter: SharedContentsFilter,
): SharedContentResponse[] {
  return filter === "all" ? [...items] : items.filter((item) => item.status === filter);
}

/** 一覧の操作種別。`retry` は failed からの再公開で、API は `update` と同じ publish 経路 */
export type SharedContentActionKind = "open" | "copy" | "update" | "stop" | "resume" | "retry" | "delete";

export type SharedContentAction = {
  kind: SharedContentActionKind;
  label: string;
  danger?: boolean;
  /** 押せない操作。理由は `reason` に出す（項目ごと隠すと、できない理由が分からない） */
  disabled?: boolean;
  reason?: string;
};

/** セッションが消えた共有物で更新だけを止める理由。停止・再公開・削除はソースを見ないので通す */
export const SHARED_CONTENT_SESSION_MISSING_NOTE = "セッションが削除されているため更新できません";
/** 一覧に残すが、更新だけが使えないことを示す印 */
export const SHARED_CONTENT_SESSION_DELETED_LABEL = "セッション（削除済み）";
/**
 * 接続未登録の案内。操作を試す前に出すため、BFF の固定文言（表示にもそのまま使う）と同じ文を持つ。
 * 値の正は `server/src/shared-contents.ts` の `SHARED_CONTENT_NO_CREDENTIALS`。
 */
export const SHARED_CONTENT_NO_CREDENTIALS_NOTE =
  "Cloudflare の資格情報が未登録です。設定 → 共有 → 接続 で登録してください";

function updateAction(sessionMissing: boolean): SharedContentAction & { kind: "update" } {
  return sessionMissing
    ? { kind: "update", label: "更新", disabled: true, reason: SHARED_CONTENT_SESSION_MISSING_NOTE }
    : { kind: "update", label: "更新" };
}

/** デスクトップのカードに並べる操作。API の状態遷移に合わせ、現状から受け付けない操作は出さない */
export function sharedContentActions(
  item: SharedContentResponse,
  { sessionMissing }: { sessionMissing: boolean },
): SharedContentAction[] {
  switch (item.status) {
    case "published":
      return [
        { kind: "open", label: "開く" },
        { kind: "copy", label: "URL をコピー" },
        updateAction(sessionMissing),
        { kind: "stop", label: "停止" },
        { kind: "delete", label: "削除", danger: true },
      ];
    case "stopped":
      return [
        { kind: "resume", label: "再公開" },
        { kind: "delete", label: "削除", danger: true },
      ];
    case "failed":
      return [
        { kind: "retry", label: "公開を再試行" },
        { kind: "delete", label: "削除", danger: true },
      ];
    case "publishing":
      // 結果不明は停止だけを受け付ける。確定していない公開中には操作を出さない
      return item.lastError === null ? [] : [{ kind: "stop", label: "停止" }];
  }
}

/** ⋯ に入る操作。開く / コピーは主操作としてカード側に置く */
export type SharedContentMenuKind = Extract<SharedContentActionKind, "update" | "stop" | "delete">;

/** 狭い面の ⋯ に入れる操作。主操作と URL コピーはカード側に出す */
export function sharedContentMenuActions(
  item: SharedContentResponse,
  { sessionMissing }: { sessionMissing: boolean },
): (SharedContentAction & { kind: SharedContentMenuKind })[] {
  switch (item.status) {
    case "published":
      return [
        updateAction(sessionMissing),
        { kind: "stop", label: "停止" },
        { kind: "delete", label: "削除", danger: true },
      ];
    case "stopped":
    case "failed":
      return [{ kind: "delete", label: "削除", danger: true }];
    case "publishing":
      return [];
  }
}

/** 狭い面の主操作。結果不明は停止、公開中は主操作なし（⋯ も出さない） */
export function sharedContentPrimaryAction(item: SharedContentResponse): SharedContentAction | null {
  switch (item.status) {
    case "published":
      return { kind: "open", label: "開く" };
    case "stopped":
      return { kind: "resume", label: "再公開" };
    case "failed":
      return { kind: "retry", label: "公開を再試行" };
    case "publishing":
      return item.lastError === null ? null : { kind: "stop", label: "停止" };
  }
}

/** 操作中の表示。カードの操作を全部止め、何をしているかを出す */
export type SharedContentBusyKind = "update" | "stop" | "resume" | "retry" | "delete";

export function sharedContentBusyLabel(kind: SharedContentBusyKind): string {
  switch (kind) {
    case "update":
      return "更新中";
    case "stop":
      return "停止中";
    case "resume":
      return "再公開中";
    case "retry":
      return "公開中";
    case "delete":
      return "削除中";
  }
}

/**
 * 一覧に載っていない会話の共有物は「セッション（削除済み）」にする。
 * 会話一覧をまだ取得できていない間は、消えたと言い切らず更新を止めない（BFF も 409 で拒否する）。
 */
export function sharedContentSessionMissing(
  item: SharedContentResponse,
  sessionIds: ReadonlySet<string>,
  sessionsLoaded: boolean,
): boolean {
  return sessionsLoaded && !sessionIds.has(item.sessionId);
}

/** 更新の確認。再公開する前に、対象の共有物と読み直す source_path を必ず見せる */
export function sharedContentUpdateConfirm(item: SharedContentResponse): ConfirmRequest {
  return {
    kind: "confirm",
    title: "共有物を更新",
    subject: { label: "共有物", value: item.name },
    code: { label: "公開元", value: item.sourcePath },
    body: [
      "現在の公開元を読み直して、同じ URL へ再公開します。",
      "共有は公開時点のスナップショットです。ディレクトリを編集しただけでは反映されません。",
      "公開中の版は、更新が成功するまで残ります。",
    ],
    confirmLabel: "更新する",
  };
}

/** 削除の確認。停止と違って URL と記録が残らないことを、対象を明示して伝える */
export function sharedContentDeleteConfirm(item: SharedContentResponse): ConfirmRequest {
  return {
    kind: "confirm",
    title: "共有物を削除",
    subject: { label: "共有物", value: item.name },
    ...(item.publicUrl === null ? {} : { code: { label: "公開 URL", value: item.publicUrl } }),
    body: ["Cloudflare の公開物と一覧の記録を削除します。元に戻せません。"],
    notes: ["削除すると URL は開けなくなります。停止とは違い、URL と記録は残りません。"],
    confirmLabel: "削除する",
    danger: true,
  };
}
