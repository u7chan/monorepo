// 共有ダイアログの純関数。公開の状態は status と lastError の組で読み、確認画面に確定 URL を出さないこと、
// ポーリングの宛先 (受付した 1 件は詳細、他は一覧) を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  filterSharedContents,
  SHARE_CONFIRM_NOTES,
  shareItemsPublishing,
  sharePollPlan,
  shareStatusView,
  sharedContentActions,
  sharedContentBusyLabel,
  sharedContentDeleteConfirm,
  sharedContentFilterCounts,
  sharedContentMenuActions,
  sharedContentPrimaryAction,
  sharedContentSessionMissing,
  sharedContentUpdateConfirm,
  sharedContentsPolling,
  settleAcceptedSharedContent,
  trackAcceptedSharedContent,
  SHARED_CONTENT_FILTERS,
  SHARED_CONTENT_NO_CREDENTIALS_NOTE,
  SHARED_CONTENT_SESSION_MISSING_NOTE,
  withSharedContent,
  type SharedContentBusyKind,
} from "../src/lib/sharedContents";
import type { SharedContentResponse } from "../src/types";

const base: SharedContentResponse = {
  id: "abc123",
  sessionId: "s1",
  name: "dist",
  sourcePath: "projects/app/dist",
  provider: "cloudflare",
  status: "publishing",
  publicUrl: "https://u7s-abc123.demo.workers.dev/",
  createdAt: 1,
  updatedAt: 1,
  publishedAt: null,
  stoppedAt: null,
  lastError: null,
};

const item = (overrides: Partial<SharedContentResponse> = {}): SharedContentResponse => ({ ...base, ...overrides });

test("状態の見せ方: 公開中・公開済み・停止中・失敗と、結果不明を openUrl と note で区別する", () => {
  assert.deepEqual(shareStatusView(item()), { label: "公開中", tone: "busy", openUrl: null, note: null });
  assert.deepEqual(shareStatusView(item({ status: "published" })), {
    label: "公開済み",
    tone: "ok",
    openUrl: base.publicUrl,
    note: null,
  });
  // 再公開の失敗は前の版が生きている。URL は開かせ、理由も添える
  assert.deepEqual(shareStatusView(item({ status: "published", lastError: "公開に失敗しました" })), {
    label: "公開済み",
    tone: "ok",
    openUrl: base.publicUrl,
    note: "公開に失敗しました",
  });
  assert.deepEqual(shareStatusView(item({ status: "stopped" })), {
    label: "停止中",
    tone: "warn",
    openUrl: null,
    note: null,
  });
  assert.deepEqual(shareStatusView(item({ status: "failed", lastError: "index.html がありません" })), {
    label: "公開できませんでした",
    tone: "danger",
    openUrl: null,
    note: "index.html がありません",
  });
  // 結果不明は「公開中」と言い切らない (外部が公開されているかを確定できていない)
  assert.deepEqual(shareStatusView(item({ lastError: "公開の結果を確認できませんでした" })), {
    label: "結果不明",
    tone: "warn",
    openUrl: null,
    note: "公開の結果を確認できませんでした",
  });
});

test("確認の条件: 対象外の URL を出さず、外部公開・秘密値・URL 発行・serve との区別を含む", () => {
  const all = SHARE_CONFIRM_NOTES.join("\n");
  assert.match(all, /誰でも見られます/);
  assert.match(all, /秘密値/);
  assert.match(all, /公開前には表示できません/);
  assert.match(all, /サービス（一時プレビュー）とは別/);
  assert.equal(
    SHARE_CONFIRM_NOTES.some((note) => /https?:\/\//.test(note)),
    false,
    "確認画面に確定 URL を出さない",
  );
});

test("ポーリングの宛先: 受付した 1 件は詳細、他の進行中は一覧、両方あるときは同じ tick で両方読む", () => {
  // 受付した 1 件が一覧に載っていない間も詳細で追う
  assert.deepEqual(sharePollPlan("abc123", []), { detailId: "abc123", list: false });
  assert.deepEqual(sharePollPlan("abc123", [item()]), { detailId: "abc123", list: false });
  // 受付した 1 件を詳細で追っている間も、他の進行中は一覧の取り直しで更新する (止まったままにしない)
  assert.deepEqual(sharePollPlan("abc123", [item(), item({ id: "def456" })]), {
    detailId: "abc123",
    list: true,
  });
  assert.deepEqual(sharePollPlan("abc123", [item({ status: "published" }), item({ id: "def456" })]), {
    detailId: null,
    list: true,
  });
  assert.deepEqual(sharePollPlan("abc123", [item({ status: "published" })]), { detailId: null, list: false });
  assert.deepEqual(sharePollPlan(null, [item()]), { detailId: null, list: true });
  assert.deepEqual(sharePollPlan(null, [item({ status: "published" }), item({ id: "def456" })]), {
    detailId: null,
    list: true,
  });
  assert.deepEqual(sharePollPlan(null, [item({ status: "published" })]), { detailId: null, list: false });
  assert.equal(shareItemsPublishing([item({ status: "published" })]), false);
  assert.equal(shareItemsPublishing([item({ status: "published" }), item({ id: "def456" })]), true);
  // 受付した 1 件だけが進行中なら、一覧の取り直しは要らない
  assert.equal(shareItemsPublishing([item()], "abc123"), false);
});

test("受付済みの追跡: 202 の直後の一覧取得が失敗しても、終端を取得するまでポーリングを続ける", () => {
  const published = item({ id: "abc123", status: "published" });
  // 202 の受付時に追跡へ入れる
  let tracked = trackAcceptedSharedContent([], "abc123");
  assert.deepEqual(tracked, ["abc123"]);
  // 受付直後の一覧 GET が失敗した場合、items は操作前 (published) のまま。それでも追跡が残るので続ける
  assert.equal(sharedContentsPolling([published], tracked), true);
  // 一覧が取れて publishing を確認できた: 追跡を続ける
  tracked = settleAcceptedSharedContent(tracked, [item({ id: "abc123", status: "publishing" })]);
  assert.deepEqual(tracked, ["abc123"]);
  assert.equal(sharedContentsPolling([], tracked), true);
  // 終端を確認できたら追跡をやめる
  tracked = settleAcceptedSharedContent(tracked, [item({ id: "abc123", status: "stopped" })]);
  assert.deepEqual(tracked, []);
  assert.equal(sharedContentsPolling([published], tracked), false);
  // 一覧から消えた id も追跡をやめる
  assert.deepEqual(settleAcceptedSharedContent(["gone"], [published]), []);
  // 同じ id を重ねて追跡しない
  assert.deepEqual(trackAcceptedSharedContent(["abc123"], "abc123"), ["abc123"]);
});

test("受付した 1 件の反映: 同じ id は差し替え、未取得なら先頭へ足す", () => {
  const published = item({ status: "published" });
  assert.deepEqual(withSharedContent([item()], published), [published]);
  const other = item({ id: "def456" });
  assert.deepEqual(withSharedContent([other], published), [published, other]);
});

test("管理一覧の操作: 状態ごとに受け付ける操作だけを並べ、結果不明は停止だけにする", () => {
  const kinds = (status: SharedContentResponse["status"], lastError: string | null = null) =>
    sharedContentActions(item({ status, lastError }), { sessionMissing: false }).map((action) => action.kind);
  assert.deepEqual(kinds("published"), ["open", "copy", "update", "stop", "delete"]);
  assert.deepEqual(kinds("published", "更新に失敗しました"), ["open", "copy", "update", "stop", "delete"]);
  assert.deepEqual(kinds("stopped"), ["resume", "delete"]);
  assert.deepEqual(kinds("failed"), ["retry", "delete"]);
  assert.deepEqual(kinds("publishing"), []);
  assert.deepEqual(kinds("publishing", "公開の結果を確認できませんでした"), ["stop"]);
  assert.equal(
    sharedContentActions(item({ status: "published" }), { sessionMissing: false }).at(-1)?.danger,
    true,
    "削除は破壊的な操作として示す",
  );
});

test("セッション削除済み: 更新だけを理由付きで無効にし、停止・再公開・削除は残す", () => {
  const published = sharedContentActions(item({ status: "published" }), { sessionMissing: true });
  const update = published.find((action) => action.kind === "update");
  assert.equal(update?.disabled, true);
  assert.equal(update?.reason, SHARED_CONTENT_SESSION_MISSING_NOTE);
  assert.deepEqual(
    published.filter((action) => action.disabled !== true).map((action) => action.kind),
    ["open", "copy", "stop", "delete"],
  );
  const menu = sharedContentMenuActions(item({ status: "published" }), { sessionMissing: true });
  assert.deepEqual(
    menu.map((action) => [action.kind, action.disabled === true]),
    [
      ["update", true],
      ["stop", false],
      ["delete", false],
    ],
  );
  assert.deepEqual(
    sharedContentActions(item({ status: "stopped" }), { sessionMissing: true }).map((action) => action.kind),
    ["resume", "delete"],
  );
});

test("狭い面の ⋯ と主操作: 公開中は更新 / 停止 / 削除、停止中と失敗は削除だけ、結果不明は主操作の停止だけ", () => {
  const menu = (status: SharedContentResponse["status"], lastError: string | null = null) =>
    sharedContentMenuActions(item({ status, lastError }), { sessionMissing: false }).map((action) => action.kind);
  assert.deepEqual(menu("published"), ["update", "stop", "delete"]);
  assert.deepEqual(menu("stopped"), ["delete"]);
  assert.deepEqual(menu("failed"), ["delete"]);
  assert.deepEqual(menu("publishing"), []);
  assert.deepEqual(menu("publishing", "公開の結果を確認できませんでした"), []);
  assert.equal(sharedContentPrimaryAction(item({ status: "published" }))?.kind, "open");
  assert.equal(sharedContentPrimaryAction(item({ status: "stopped" }))?.kind, "resume");
  assert.equal(sharedContentPrimaryAction(item({ status: "failed" }))?.kind, "retry");
  assert.equal(sharedContentPrimaryAction(item({ status: "publishing" })), null);
  assert.deepEqual(
    sharedContentPrimaryAction(item({ status: "publishing", lastError: "公開の結果を確認できませんでした" })),
    { kind: "stop", label: "停止" },
  );
});

test("操作中の表示: 何をしているかを種類ごとに出す", () => {
  const kinds: SharedContentBusyKind[] = ["update", "stop", "resume", "retry", "delete"];
  assert.deepEqual(kinds.map(sharedContentBusyLabel), ["更新中", "停止中", "再公開中", "公開中", "削除中"]);
});

test("状態フィルタ: 件数は全件から数え、絞り込みは status だけを見る（結果不明は処理中）", () => {
  const items = [
    item({ id: "a", status: "published" }),
    item({ id: "b", status: "publishing" }),
    item({ id: "c", status: "publishing", lastError: "公開の結果を確認できませんでした" }),
    item({ id: "d", status: "stopped" }),
    item({ id: "e", status: "failed" }),
  ];
  assert.deepEqual(sharedContentFilterCounts(items), {
    all: 5,
    published: 1,
    publishing: 2,
    stopped: 1,
    failed: 1,
  });
  assert.deepEqual(
    SHARED_CONTENT_FILTERS.map((filter) => [filter.key, filter.label]),
    [
      ["all", "すべて"],
      ["published", "公開済み"],
      ["publishing", "処理中"],
      ["stopped", "停止中"],
      ["failed", "失敗"],
    ],
  );
  assert.deepEqual(
    filterSharedContents(items, "publishing").map((entry) => entry.id),
    ["b", "c"],
  );
  assert.deepEqual(
    filterSharedContents(items, "all").map((entry) => entry.id),
    ["a", "b", "c", "d", "e"],
    "all は API の並びを変えない",
  );
});

test("セッション削除済みの判定: 会話一覧を取得できてから、載っていない会話だけを削除済みとする", () => {
  const sessionIds = new Set(["s1"]);
  assert.equal(sharedContentSessionMissing(item({ sessionId: "s1" }), sessionIds, true), false);
  assert.equal(sharedContentSessionMissing(item({ sessionId: "s2" }), sessionIds, true), true);
  assert.equal(
    sharedContentSessionMissing(item({ sessionId: "s2" }), sessionIds, false),
    false,
    "一覧が未取得の間に削除済みと言い切らない",
  );
});

test("確認ダイアログ: 更新は公開元のパス、削除は URL と取り消せないことを示す", () => {
  const published = item({ status: "published", sourcePath: "projects/app/dist" });
  const update = sharedContentUpdateConfirm(published);
  assert.equal(update.kind, "confirm");
  assert.equal(update.code?.value, "projects/app/dist");
  assert.equal(update.danger, undefined);
  assert.match(update.body?.join("\n") ?? "", /同じ URL へ再公開/);
  const remove = sharedContentDeleteConfirm(published);
  assert.equal(remove.kind, "confirm");
  assert.equal(remove.danger, true);
  assert.equal(remove.code?.value, published.publicUrl);
  assert.match(remove.notes?.join("\n") ?? "", /URL と記録は残りません/);
  const withoutUrl = sharedContentDeleteConfirm(item({ status: "failed", publicUrl: null }));
  assert.equal(withoutUrl.code, undefined, "URL が無い共有物には URL の行を出さない");
});

test("接続未登録の案内は BFF の固定文言と同じで、接続タブへの導線を含む", () => {
  assert.equal(
    SHARED_CONTENT_NO_CREDENTIALS_NOTE,
    "Cloudflare の資格情報が未登録です。設定 → 共有 → 接続 で登録してください",
  );
});
