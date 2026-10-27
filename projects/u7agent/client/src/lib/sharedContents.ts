/**
 * 共有ダイアログの文言と状態の見せ方。公開は非同期なので、`publishing` の間だけポーリングし、
 * 終端は `status` と `lastError` の組で読む（契約は docs/static-sharing.md）。
 */
import type {
  CreateSharedContentBody,
  SessionSummary,
  SharedContentResponse,
  SharedContentStatusValue,
} from "../types";
import type { ConfirmRequest, PromptRequest } from "./confirmDialog";

/** 状態を読み直す間隔。公開ジョブの所要は数十秒なので、待ちすぎず叩きすぎない値にする */
export const SHARE_POLL_MS = 2000;

/**
 * 共有の受付（POST）の本文。`directory` は入口のパスをそのまま渡し（root 直下は `.` で、空文字に置き換えない）、
 * 空欄の表示名は送らない（サーバーがディレクトリ名 / root ではセッション ID へ落とす）。
 */
export function sharedContentCreateBody(input: {
  sessionId: string;
  directory: string;
  name?: string;
}): CreateSharedContentBody {
  const name = (input.name ?? "").trim();
  return { sessionId: input.sessionId, directory: input.directory, ...(name === "" ? {} : { name }) };
}

/** 同じ公開元が公開中のときの理由。再送を止め、完了後に URL がどこへ出るかだけを示す */
export const SHARE_PUBLISHING_NOTE = "公開処理中です。完了すると 設定 → 共有 に URL が出ます。";

/** 公開中に閉じても公開が止まらないことと、結果の確認先。閉じる操作は塞がない */
export const SHARE_CLOSE_HINT = "閉じても公開は続きます。結果は 設定 → 共有 で確認できます。";

/** 表示名の上限。`server/src/shared-contents.ts` の `SHARED_CONTENT_MAX_NAME_LENGTH` と同じ値 */
export const SHARE_NAME_MAX_LENGTH = 100;

/** 公開元の表示。root はセッション ID を含む生パスを出さない */
export function sharedContentSourceLabel(item: Pick<SharedContentResponse, "sourceKind" | "sourcePath">): string {
  return item.sourceKind === "session-root" ? "セッションの作業フォルダ" : item.sourcePath;
}

/**
 * 同じ公開元の共有物。プレビューを取得できていない間（`sourcePath === null`）は判定しない
 * （見えていない対象で「共有済み」と言い切らない）。
 */
export function sharedContentWithSourcePath(
  sourcePath: string | null,
  items: readonly SharedContentResponse[],
): SharedContentResponse | undefined {
  return sourcePath === null ? undefined : items.find((item) => item.sourcePath === sourcePath);
}

/**
 * 同じ公開元で公開中の共有物があるか。一覧は作成日時降順なので、同じ公開元が複数あるときに
 * `sharedContentWithSourcePath` の先頭 1 件だけを見ると、古い共有物の更新中を公開済みと誤認する。
 */
export function sharedContentPublishingWithSourcePath(
  sourcePath: string | null,
  items: readonly SharedContentResponse[],
): boolean {
  return sourcePath !== null && items.some((item) => item.sourcePath === sourcePath && item.status === "publishing");
}

/**
 * 共有ダイアログの主操作。同じ公開元の共有物があれば更新を主にし、新規作成は副次へ下げる。
 * 公開中だけは、閉じて開き直して `activeId` が失われても再送させない（Worker と URL を二重に作らない）。
 */
export type SharePrimaryAction =
  | { kind: "create" }
  | { kind: "update"; item: SharedContentResponse }
  | { kind: "publishing" };

/** 公開元の同一性はプレビューの `sourcePath` の文字列だけで見る（`directory` の字面はサーバーの解決規則と二重になる） */
export function sharePrimaryAction(
  sourcePath: string | null,
  items: readonly SharedContentResponse[],
): SharePrimaryAction {
  if (sharedContentPublishingWithSourcePath(sourcePath, items)) return { kind: "publishing" };
  const item = sharedContentWithSourcePath(sourcePath, items);
  return item === undefined ? { kind: "create" } : { kind: "update", item };
}

/**
 * 更新で何が起きるか。更新は成果物を上げ直すので、未デプロイ・失敗からの復帰も同じ経路。
 * 管理一覧の停止中の「再公開」は版を変えないので、同じ「停止中」でも意味が違う。
 */
export const SHARE_UPDATE_NOTE_LIVE = "この URL を更新します。";
export const SHARE_UPDATE_NOTE_STOPPED = "停止中の共有物を更新して公開します。";
export const SHARE_UPDATE_NOTE_INCOMPLETE = "前回の公開は完了していません。更新で同じ URL に公開し直せます。";

/** 更新する対象の状態を、押す前に読める 1 行にする */
export function shareUpdateNote(item: SharedContentResponse): string {
  if (isSharedContentUndeployed(item) || item.status === "failed") return SHARE_UPDATE_NOTE_INCOMPLETE;
  switch (item.status) {
    case "published":
      return SHARE_UPDATE_NOTE_LIVE;
    case "stopped":
      return SHARE_UPDATE_NOTE_STOPPED;
    case "publishing":
      return SHARE_PUBLISHING_NOTE;
  }
}

/** 更新では表示名を変えない（URL と状態に影響しないラベル変更は、更新と別の操作として管理一覧の ⋯ に置く） */
export const SHARE_NAME_LOCKED_NOTE = "更新しても表示名は変わりません。変更は 設定 → 共有 の ⋯ から行えます。";
/** 副次の新規作成は取り消しにくい（Worker が増える）ので、押す前に 1 行だけ添える */
export const SHARE_CREATE_SECONDARY_NOTE = "新しい URL が増えます（Worker が 1 つ増えます）。";
/**
 * プレビューが失敗して公開元が分からないときの案内。更新の対象を特定できないので、存在を断定しない
 * （同じフォルダの共有物があっても、ここからは更新へ進めない）。
 */
export const SHARE_PREVIEW_FAILED_UPDATE_HINT = "同じフォルダの共有物がある場合、更新は 設定 → 共有 から行えます。";

/**
 * 確認画面の注意の summary。`SHARE_CONFIRM_NOTES` を畳んだままでも要点が読める 1 行にする
 * （`client/src/components/CollapsibleNotice.tsx` の契約）。
 */
export const SHARE_CONFIRM_SUMMARY = "URL は誰でも見られます。ファイルに含めた秘密の値もそのまま公開されます。";

/**
 * 新規作成の確認画面に必ず出す条件。順序も含めて契約にする（公開は取り消しにくいので、押す前に全部読めるようにする）。
 * 確定した URL は受付時に決まるため、ここには URL を出さない（この条件は新規作成だけのもの）。
 */
export const SHARE_CONFIRM_NOTES: readonly string[] = [
  "URL を知っていれば誰でも見られます（認証・期限はありません）。",
  "静的ファイルに含めた秘密値（API キー・トークンなど）も、そのまま公開されます。",
  "公開すると確定した URL が発行されます。URL は受付時に決まるため、公開前には表示できません。",
  "Cloudflare（workers.dev）へ公開します。サービス（一時プレビュー）とは別で、この画面からは停止・削除ができません。",
];

/**
 * 更新の確認画面に出す条件。更新は URL が既に決まっているので、確認画面に更新先として出す
 * （「公開前に確定 URL を出さない」は新規作成の条件に限定される）。
 */
export const SHARE_UPDATE_CONFIRM_NOTES: readonly string[] = [
  "URL を知っていれば誰でも見られます（認証・期限はありません）。",
  "静的ファイルに含めた秘密値（API キー・トークンなど）も、そのまま公開されます。",
  "更新しても URL は変わりません。公開中の版は、更新が成功するまで残ります。",
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

/** 未デプロイの案内。`lastError` の文言では分岐せず、状態と公開時刻だけで決める */
export const SHARED_CONTENT_UNDEPLOYED_NOTE =
  "公開処理が完了していません。設定 → 共有 の「更新」で公開し直してください";

/**
 * 公開が一度も成功していない共有物。DB の不整合行は自動移行しないので、`status` が
 * `published` / `stopped` でも `publishedAt` が無ければ外部に実体が無いものとして扱う。
 */
export function isSharedContentUndeployed(item: Pick<SharedContentResponse, "status" | "publishedAt">): boolean {
  return (item.status === "published" || item.status === "stopped") && item.publishedAt === null;
}

/** 状態の見せ方。`published` + `lastError` は「前の版が生きている」ので、URL を出しつつ理由も添える */
export function shareStatusView(item: SharedContentResponse): ShareStatusView {
  const url = item.publicUrl;
  if (isSharedContentUndeployed(item)) {
    return { label: "要更新", tone: "warn", openUrl: null, note: SHARED_CONTENT_UNDEPLOYED_NOTE };
  }
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

/** 公開がまだ進行中の共有物があるか */
export function shareItemsPublishing(items: readonly SharedContentResponse[]): boolean {
  return items.some((item) => item.status === "publishing");
}

/**
 * 次の tick で詳細を読む 1 件。`tracked` は受付（202）済みで終端をまだ確認できていない id。
 * 受付直後の一覧取得が失敗すると items は操作前のままなので、これが無いと `activeId` の詳細も読まれず、
 * 更新前の結果を出したままポーリングが止まる。
 */
export function sharePollDetailId(
  activeId: string | null,
  items: readonly SharedContentResponse[],
  tracked: readonly string[] = [],
): string | null {
  const active = activeId === null ? undefined : items.find((item) => item.id === activeId);
  if (activeId !== null && (active === undefined || active.status === "publishing")) return activeId;
  return tracked[0] ?? null;
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

/**
 * 1 件の操作が成功したあとの 202 追跡。受付を返す操作は追跡へ入れ、終端を返す操作（停止・削除）は外す。
 * 表示名の変更は provider を呼ばず終端も受付も返さないので、追跡をそのまま残す
 * （ここで外すと、一覧の取得に失敗している間に受けた公開の結果を読めなくなる）。
 */
export function settleAcceptedAfterMutation(
  tracked: readonly string[],
  id: string,
  kind: SharedContentBusyKind,
): string[] {
  if (kind === "update" || kind === "retry" || kind === "resume") return trackAcceptedSharedContent(tracked, id);
  if (kind === "stop" || kind === "delete") return tracked.filter((entry) => entry !== id);
  return [...tracked];
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

/**
 * 詳細の 1 件で終端を確認できた id を追跡から外す。一覧の取得が失敗し続けても、詳細が終端を返した時点で
 * その id のポーリングは終えられる。一覧にまだ現れていない他の id は落とさないので、
 * 一覧を受け取る `settleAcceptedSharedContent` とは使い分ける。
 */
export function settleAcceptedDetail(tracked: readonly string[], item: SharedContentResponse): string[] {
  return tracked.filter((id) => id !== item.id || item.status === "publishing");
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

/**
 * フィルタごとの未デプロイ件数。絞り込みは `status` のままなので、`published` / `stopped` の
 * チップにだけ「要更新」を添える（`all` と他の状態は 0）。
 */
export function sharedContentUndeployedFilterCounts(
  items: readonly SharedContentResponse[],
): Record<SharedContentsFilter, number> {
  const counts: Record<SharedContentsFilter, number> = { all: 0, published: 0, publishing: 0, stopped: 0, failed: 0 };
  for (const item of items) {
    if (isSharedContentUndeployed(item)) counts[item.status] += 1;
  }
  return counts;
}

/**
 * 一括停止の対象か。外部に実体のある公開済みと、停止だけを受け付ける結果不明だけを対象にする。
 * 公開処理中（結果待ち）は 202 をキャンセルできず、完了後に公開され得るので含めない。
 */
export function isSharedContentStoppable(
  item: Pick<SharedContentResponse, "status" | "publishedAt" | "lastError">,
): boolean {
  if (item.status === "published") return item.publishedAt !== null;
  return item.status === "publishing" && item.lastError !== null;
}

/** 一括停止の対象（フィルタの外側の全件から数える。表示中の部分集合とは一致しない） */
export function stoppableSharedContents(items: readonly SharedContentResponse[]): SharedContentResponse[] {
  return items.filter(isSharedContentStoppable);
}

/** 結果待ちで停止できない件数。確認と結果で「対象外」として示す */
export function sharedContentInFlightCount(items: readonly SharedContentResponse[]): number {
  return items.filter((item) => item.status === "publishing" && item.lastError === null).length;
}

/** 一覧の並びの重み。生きている共有物を先に置き、寝ている停止中を最後にする */
const SHARED_CONTENT_STATUS_ORDER: Record<SharedContentStatusValue, number> = {
  published: 0,
  publishing: 1,
  failed: 2,
  stopped: 3,
};

/**
 * 一覧に出す行。`filter` で絞ってから、状態で固め、その中は更新の新しい順にする
 * （カードが前面に出す「更新」と一致させ、並びの理由を画面だけで説明できるようにする）。
 */
export function visibleSharedContents(
  items: readonly SharedContentResponse[],
  filter: SharedContentsFilter,
): SharedContentResponse[] {
  return items
    .filter((item) => filter === "all" || item.status === filter)
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        SHARED_CONTENT_STATUS_ORDER[a.item.status] - SHARED_CONTENT_STATUS_ORDER[b.item.status] ||
        b.item.updatedAt - a.item.updatedAt ||
        // 同時刻は API の並び（作成の新しい順）を保つ
        a.index - b.index,
    )
    .map(({ item }) => item);
}

/** 一覧の操作種別。`retry` は failed からの再公開で、API は `update` と同じ publish 経路 */
export type SharedContentActionKind = "open" | "qr" | "rename" | "update" | "stop" | "resume" | "retry" | "delete";

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
 * 値の正は `server/src/cloudflare-settings.ts` の `SHARED_CONTENT_NO_CREDENTIALS`。
 */
export const SHARED_CONTENT_NO_CREDENTIALS_NOTE =
  "Cloudflare の資格情報が未登録です。設定 → 共有 → 接続 で登録してください";

function updateAction(sessionMissing: boolean): SharedContentAction & { kind: "update" } {
  return sessionMissing
    ? { kind: "update", label: "更新", disabled: true, reason: SHARED_CONTENT_SESSION_MISSING_NOTE }
    : { kind: "update", label: "更新" };
}

/**
 * 公開 URL を渡せる状態か。QR は開く・コピーと同じ条件に揃える
 * （未デプロイは URL の記録だけがあり、外部に実体が無いので含めない）。
 */
export function sharedContentUrlLive(
  item: Pick<SharedContentResponse, "status" | "publicUrl" | "publishedAt">,
): boolean {
  return item.status === "published" && item.publicUrl !== null && !isSharedContentUndeployed(item);
}

function qrAction(): SharedContentAction & { kind: "qr" } {
  return { kind: "qr", label: "QR コード" };
}

/** デスクトップの操作行に並べる主操作。停止 / 削除と表示名の変更は ⋯ へ送り、行を増やさない */
export function sharedContentActions(
  item: SharedContentResponse,
  { sessionMissing }: { sessionMissing: boolean },
): SharedContentAction[] {
  if (isSharedContentUndeployed(item)) return [updateAction(sessionMissing)];
  switch (item.status) {
    case "published":
      return [
        { kind: "open", label: "開く" },
        ...(sharedContentUrlLive(item) ? [qrAction()] : []),
        updateAction(sessionMissing),
      ];
    case "stopped":
      return [{ kind: "resume", label: "再公開" }];
    case "failed":
      return [{ kind: "retry", label: "公開を再試行" }];
    case "publishing":
      // 結果不明は停止だけを受け付ける。確定していない公開中には操作を出さない
      return item.lastError === null ? [] : [{ kind: "stop", label: "停止" }];
  }
}

/** ⋯ に入る操作。開く / 更新は主操作としてカード側に置く */
export type SharedContentMenuKind = Extract<SharedContentActionKind, "qr" | "rename" | "update" | "stop" | "delete">;

/**
 * ⋯ の操作。壊さない変更（名前を変更）を先頭、破壊的な削除を最後に置き、**行に出ていない操作だけ**を並べる。
 * 公開中は状態が確定していないので何も出さない（名前を変えたいときは確定を待つ）。
 */
export function sharedContentMenuActions(
  item: SharedContentResponse,
  { sessionMissing, narrow }: { sessionMissing: boolean; narrow: boolean },
): (SharedContentAction & { kind: SharedContentMenuKind })[] {
  if (item.status === "publishing") return [];
  const rename = { kind: "rename", label: "名前を変更" } as const;
  const remove = { kind: "delete", label: "削除", danger: true } as const;
  if (isSharedContentUndeployed(item)) return [rename, remove];
  switch (item.status) {
    case "published":
      // 狭い面の主操作は「開く」だけなので、更新と QR もここに入れる（PC の行には QR がある）
      return [
        rename,
        ...(narrow ? [updateAction(sessionMissing)] : []),
        ...(narrow && sharedContentUrlLive(item) ? [qrAction()] : []),
        { kind: "stop", label: "停止" },
        remove,
      ];
    case "stopped":
    case "failed":
      return [rename, remove];
  }
}

/**
 * QR を表示する 1 件。表示対象は id で持ち、一覧の更新のたびに引き直す
 * （公開済みでなくなった / URL が消えた / 一覧から消えたら null）。
 */
export function sharedContentQrTarget(
  items: readonly SharedContentResponse[],
  id: string | null,
): SharedContentResponse | null {
  if (id === null) return null;
  const item = items.find((entry) => entry.id === id);
  return item !== undefined && sharedContentUrlLive(item) ? item : null;
}

/** 狭い面の主操作。未デプロイは更新、結果不明は停止、公開中は主操作なし（⋯ も出さない） */
export function sharedContentPrimaryAction(
  item: SharedContentResponse,
  { sessionMissing }: { sessionMissing: boolean },
): SharedContentAction | null {
  if (isSharedContentUndeployed(item)) return updateAction(sessionMissing);
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
export type SharedContentBusyKind = "rename" | "update" | "stop" | "resume" | "retry" | "delete";

export function sharedContentBusyLabel(kind: SharedContentBusyKind): string {
  switch (kind) {
    case "rename":
      return "変更中";
    case "update":
      return "更新中";
    case "stop":
      // 停止済みの「停止中」と混ざらないよう、操作中は処理中と書く
      return "停止処理中";
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

/**
 * 公開元の会話。削除済みと同じ材料で解決し、会話一覧が信頼できない間は見つからない扱いにする
 * (推測の所属で別スペースへ飛ばさない)。
 */
export function sharedContentSession(
  item: Pick<SharedContentResponse, "sessionId">,
  sessions: readonly SessionSummary[],
  sessionsLoaded: boolean,
): SessionSummary | undefined {
  return sessionsLoaded ? sessions.find((session) => session.sessionId === item.sessionId) : undefined;
}

/** 更新の確認。再公開する前に、対象の共有物と読み直す source_path を必ず見せる */ export function sharedContentUpdateConfirm(
  item: SharedContentResponse,
): ConfirmRequest {
  return {
    kind: "confirm",
    title: "共有物を更新",
    subject: { label: "共有物", value: item.name },
    code: { label: "公開元", value: sharedContentSourceLabel(item) },
    body: [
      "現在の公開元を読み直して、同じ URL へ再公開します。",
      "共有は公開時点のスナップショットです。ディレクトリを編集しただけでは反映されません。",
      "公開中の版は、更新が成功するまで残ります。",
    ],
    confirmLabel: "更新する",
  };
}

/**
 * 名前の変更。URL と公開状態が変わらないことを、対象と一緒に示す。
 * 入力の空欄・未変更は `renameInputValue` が捨てる（設定 → ファイル のリネームと同じ規則）。
 */
export function sharedContentRenameRequest(item: Pick<SharedContentResponse, "name">): PromptRequest {
  return {
    kind: "prompt",
    title: "名前を変更",
    label: "共有物の名前",
    defaultValue: item.name,
    body: ["表示名だけを変えます。公開 URL と公開状態は変わりません。"],
    confirmLabel: "変更する",
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

/** 確認に並べる対象名の上限。超えた分は「ほか n 件」に畳む */
export const SHARED_CONTENT_STOP_ALL_TARGET_LIMIT = 5;

/**
 * 一括停止の確認。件数だけでは対象を確かめられないので、上から数件の名前と状態を並べる。
 * 公開処理中は止められないことを、対象外の件数とあわせて押す前に示す。
 */
export function sharedContentStopAllConfirm(items: readonly SharedContentResponse[]): ConfirmRequest {
  const targets = stoppableSharedContents(items);
  const inFlight = sharedContentInFlightCount(items);
  const shown = targets.slice(0, SHARED_CONTENT_STOP_ALL_TARGET_LIMIT);
  return {
    kind: "confirm",
    title: "稼働中の共有物をすべて停止",
    subject: { label: "対象", value: `稼働中の共有物 ${targets.length} 件` },
    body: ["Cloudflare（workers.dev）を無効にして、公開 URL を開けない状態にします。"],
    targets: {
      items: shown.map((item) => ({ label: item.name, note: shareStatusView(item).label })),
      ...(targets.length > shown.length ? { more: targets.length - shown.length } : {}),
    },
    notes: [
      "URL と一覧の記録は残ります。再公開すると同じ URL を有効に戻せます。",
      ...(inFlight > 0 ? [`公開処理中の ${inFlight} 件は対象外です。完了すると公開されます。`] : []),
    ],
    confirmLabel: "すべて停止する",
    danger: true,
  };
}

/** 一括停止の集計。`done` は試行数なので、成功数は `stopped` で別に持つ */
export type SharedContentStopAllResult = {
  total: number;
  stopped: number;
  failures: readonly { name: string }[];
  /** 確認時点で結果待ちだった件数（停止の対象外） */
  excludedPublishing: number;
};

/**
 * 一括停止の結果。一覧は最後に取り直すので、ここでは再読み込みを促さない。
 * 1 件でも失敗したらエラーのトーンにし、失敗した全件の名前を出す（理由はカード側の error が持つ）。
 */
export function sharedContentStopAllNote(result: SharedContentStopAllResult): { text: string; error: boolean } | null {
  if (result.total === 0 || (result.stopped === 0 && result.failures.length === 0)) return null;
  // ノートは 1 行のログなので理由はカードへ配り、ここでは全件の名前を落とさずに出す
  const failureNames = result.failures.map((failure) => failure.name).join("、");
  const failureSuffix = result.failures.length === 0 ? "" : `理由は各カードに表示しています。`;
  const stoppedPart =
    result.failures.length === 0
      ? `稼働中 ${result.stopped} 件をすべて停止しました。`
      : result.stopped === 0
        ? `${result.total} 件を停止できませんでした（${failureNames}）。${failureSuffix}`
        : `${result.total} 件中 ${result.stopped} 件を停止しました。${result.failures.length} 件は停止できませんでした（${failureNames}）。${failureSuffix}`;
  const excludedPart =
    result.excludedPublishing > 0
      ? `公開処理中の ${result.excludedPublishing} 件は対象外です。完了すると公開されます。`
      : "";
  return { text: `${stoppedPart}${excludedPart}`, error: result.failures.length > 0 };
}
