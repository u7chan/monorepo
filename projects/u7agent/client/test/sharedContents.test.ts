// 共有ダイアログの純関数。公開の状態は status と lastError の組で読み、確認画面に確定 URL を出さないこと、
// ポーリングの宛先 (受付した 1 件は詳細、他は一覧) を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  SHARE_CONFIRM_NOTES,
  SHARED_CONTENT_UNDEPLOYED_NOTE,
  isSharedContentUndeployed,
  shareItemsPublishing,
  sharePollPlan,
  shareStatusView,
  sharedContentActions,
  sharedContentBusyLabel,
  sharedContentDeleteConfirm,
  sharedContentFilterCounts,
  sharedContentMenuActions,
  sharedContentPrimaryAction,
  sharedContentSession,
  sharedContentSessionMissing,
  sharedContentUndeployedFilterCounts,
  sharedContentUpdateConfirm,
  sharedContentsPolling,
  settleAcceptedSharedContent,
  trackAcceptedSharedContent,
  SHARED_CONTENT_FILTERS,
  SHARED_CONTENT_NO_CREDENTIALS_NOTE,
  SHARED_CONTENT_SESSION_MISSING_NOTE,
  visibleSharedContents,
  withSharedContent,
  type SharedContentBusyKind,
} from "../src/lib/sharedContents";
import type { SessionSummary, SharedContentResponse } from "../src/types";

const base: SharedContentResponse = {
  id: "abc123",
  sessionId: "s1",
  name: "dist",
  sourcePath: "projects/app/dist",
  sourceKind: "directory",
  provider: "cloudflare",
  status: "publishing",
  publicUrl: "https://u7s-abc123.demo.workers.dev/",
  createdAt: 1,
  updatedAt: 1,
  publishedAt: null,
  stoppedAt: null,
  lastError: null,
};

/** 公開が一度でも成功した時刻。`publishedAt` が無い published / stopped は未デプロイ（要更新） */
const PUBLISHED_AT = 1_000;

const item = (overrides: Partial<SharedContentResponse> = {}): SharedContentResponse => ({ ...base, ...overrides });

// 状態 × 公開時刻。どれも `status` が同じでも、実体が外にあるかどうかで見せ方が変わる
test("状態の見せ方: status だけでなく publishedAt を見て、未デプロイは「要更新」にする", () => {
  const cases: { name: string; input: Partial<SharedContentResponse>; view: ReturnType<typeof shareStatusView> }[] = [
    {
      name: "公開中",
      input: { status: "publishing" },
      view: { label: "公開中", tone: "busy", openUrl: null, note: null },
    },
    {
      name: "結果不明",
      input: { status: "publishing", lastError: "公開の結果を確認できませんでした" },
      view: { label: "結果不明", tone: "warn", openUrl: null, note: "公開の結果を確認できませんでした" },
    },
    // 公開済みでも publishedAt が無ければ外部に実体が無い。URL を持たせず、更新へ案内する
    {
      name: "公開済み + publishedAt なし",
      input: { status: "published" },
      view: { label: "要更新", tone: "warn", openUrl: null, note: SHARED_CONTENT_UNDEPLOYED_NOTE },
    },
    {
      name: "停止中 + publishedAt なし",
      input: { status: "stopped" },
      view: { label: "要更新", tone: "warn", openUrl: null, note: SHARED_CONTENT_UNDEPLOYED_NOTE },
    },
    {
      name: "公開済み",
      input: { status: "published", publishedAt: PUBLISHED_AT },
      view: { label: "公開済み", tone: "ok", openUrl: base.publicUrl, note: null },
    },
    // 再公開の失敗は前の版が生きている。URL は開かせ、理由も添える
    {
      name: "公開済み + 直近の失敗",
      input: { status: "published", publishedAt: PUBLISHED_AT, lastError: "公開に失敗しました" },
      view: { label: "公開済み", tone: "ok", openUrl: base.publicUrl, note: "公開に失敗しました" },
    },
    {
      name: "停止中",
      input: { status: "stopped", publishedAt: PUBLISHED_AT },
      view: { label: "停止中", tone: "warn", openUrl: null, note: null },
    },
    {
      name: "失敗",
      input: { status: "failed", lastError: "index.html がありません" },
      view: { label: "公開できませんでした", tone: "danger", openUrl: null, note: "index.html がありません" },
    },
  ];
  for (const entry of cases) {
    assert.deepEqual(shareStatusView(item(entry.input)), entry.view, entry.name);
  }
  // 判定は status と publishedAt だけ。lastError の文言では変わらない
  assert.equal(isSharedContentUndeployed(item({ status: "published", lastError: "公開に失敗しました" })), true);
  assert.equal(isSharedContentUndeployed(item({ status: "stopped", publishedAt: PUBLISHED_AT })), false);
  assert.equal(isSharedContentUndeployed(item({ status: "failed", publishedAt: PUBLISHED_AT })), false);
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

test("管理一覧の操作: 状態ごとに受け付ける操作だけを並べ、未デプロイは更新と削除だけにする", () => {
  const kinds = (overrides: Partial<SharedContentResponse>) =>
    sharedContentActions(item(overrides), { sessionMissing: false }).map((action) => action.kind);
  assert.deepEqual(kinds({ status: "published", publishedAt: PUBLISHED_AT }), [
    "open",
    "copy",
    "update",
    "stop",
    "delete",
  ]);
  assert.deepEqual(kinds({ status: "published", publishedAt: PUBLISHED_AT, lastError: "更新に失敗しました" }), [
    "open",
    "copy",
    "update",
    "stop",
    "delete",
  ]);
  assert.deepEqual(kinds({ status: "stopped", publishedAt: PUBLISHED_AT }), ["resume", "delete"]);
  assert.deepEqual(kinds({ status: "failed" }), ["retry", "delete"]);
  assert.deepEqual(kinds({ status: "publishing" }), []);
  assert.deepEqual(kinds({ status: "publishing", lastError: "公開の結果を確認できませんでした" }), ["stop"]);
  // 実体が無いのに開かせたり再公開させたりしない。解消は更新（同じ URL へ上げ直す）と削除だけ
  assert.deepEqual(kinds({ status: "published" }), ["update", "delete"]);
  assert.deepEqual(kinds({ status: "stopped" }), ["update", "delete"]);
  assert.deepEqual(kinds({ status: "published", lastError: "公開に失敗しました" }), ["update", "delete"]);
  assert.equal(
    sharedContentActions(item({ status: "published" }), { sessionMissing: false }).at(-1)?.danger,
    true,
    "削除は破壊的な操作として示す",
  );
});

test("セッション削除済み: 更新だけを理由付きで無効にし、停止・再公開・削除は残す", () => {
  const published = sharedContentActions(item({ status: "published", publishedAt: PUBLISHED_AT }), {
    sessionMissing: true,
  });
  const update = published.find((action) => action.kind === "update");
  assert.equal(update?.disabled, true);
  assert.equal(update?.reason, SHARED_CONTENT_SESSION_MISSING_NOTE);
  assert.deepEqual(
    published.filter((action) => action.disabled !== true).map((action) => action.kind),
    ["open", "copy", "stop", "delete"],
  );
  const menu = sharedContentMenuActions(item({ status: "published", publishedAt: PUBLISHED_AT }), {
    sessionMissing: true,
  });
  assert.deepEqual(
    menu.map((action) => [action.kind, action.disabled === true]),
    [
      ["update", true],
      ["stop", false],
      ["delete", false],
    ],
  );
  assert.deepEqual(
    sharedContentActions(item({ status: "stopped", publishedAt: PUBLISHED_AT }), { sessionMissing: true }).map(
      (action) => action.kind,
    ),
    ["resume", "delete"],
  );
});

test("未デプロイのセッション削除済み: 更新だけを理由付きで無効にし、削除は残す", () => {
  for (const status of ["published", "stopped"] as const) {
    const desktop = sharedContentActions(item({ status }), { sessionMissing: true });
    assert.deepEqual(
      desktop.map((action) => [action.kind, action.disabled === true]),
      [
        ["update", true],
        ["delete", false],
      ],
      status,
    );
    assert.equal(desktop[0].reason, SHARED_CONTENT_SESSION_MISSING_NOTE);
    const primary = sharedContentPrimaryAction(item({ status }), { sessionMissing: true });
    assert.deepEqual(primary, {
      kind: "update",
      label: "更新",
      disabled: true,
      reason: SHARED_CONTENT_SESSION_MISSING_NOTE,
    });
  }
});

test("狭い面の ⋯ と主操作: 未デプロイは更新と削除、公開中は更新 / 停止 / 削除、停止中と失敗は削除だけ", () => {
  const menu = (overrides: Partial<SharedContentResponse>) =>
    sharedContentMenuActions(item(overrides), { sessionMissing: false }).map((action) => action.kind);
  assert.deepEqual(menu({ status: "published", publishedAt: PUBLISHED_AT }), ["update", "stop", "delete"]);
  assert.deepEqual(menu({ status: "published" }), ["update", "delete"]);
  assert.deepEqual(menu({ status: "stopped" }), ["update", "delete"]);
  assert.deepEqual(menu({ status: "stopped", publishedAt: PUBLISHED_AT }), ["delete"]);
  assert.deepEqual(menu({ status: "failed" }), ["delete"]);
  assert.deepEqual(menu({ status: "publishing" }), []);
  assert.deepEqual(menu({ status: "publishing", lastError: "公開の結果を確認できませんでした" }), []);
  const primary = (overrides: Partial<SharedContentResponse>) =>
    sharedContentPrimaryAction(item(overrides), { sessionMissing: false });
  assert.equal(primary({ status: "published", publishedAt: PUBLISHED_AT })?.kind, "open");
  assert.equal(primary({ status: "stopped", publishedAt: PUBLISHED_AT })?.kind, "resume");
  assert.equal(primary({ status: "failed" })?.kind, "retry");
  assert.equal(primary({ status: "publishing" }), null);
  // 未デプロイは「開く」も「再公開」も出さず、主操作を更新にする（セッションが生きていれば押せる）
  assert.deepEqual(primary({ status: "published" }), { kind: "update", label: "更新" });
  assert.deepEqual(primary({ status: "stopped" }), { kind: "update", label: "更新" });
  assert.deepEqual(primary({ status: "publishing", lastError: "公開の結果を確認できませんでした" }), {
    kind: "stop",
    label: "停止",
  });
});

test("操作中の表示: 何をしているかを種類ごとに出す", () => {
  const kinds: SharedContentBusyKind[] = ["update", "stop", "resume", "retry", "delete"];
  assert.deepEqual(kinds.map(sharedContentBusyLabel), ["更新中", "停止中", "再公開中", "公開中", "削除中"]);
});

test("状態フィルタ: 件数は全件から数え、絞り込みは status だけを見る（結果不明は処理中）", () => {
  const items = [
    item({ id: "a", status: "published", publishedAt: PUBLISHED_AT }),
    item({ id: "b", status: "publishing" }),
    item({ id: "c", status: "publishing", lastError: "公開の結果を確認できませんでした" }),
    item({ id: "d", status: "stopped", publishedAt: PUBLISHED_AT }),
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
    visibleSharedContents(items, "publishing").map((entry) => entry.id),
    ["b", "c"],
  );
  assert.deepEqual(
    visibleSharedContents(items, "all").map((entry) => entry.id),
    ["a", "b", "c", "e", "d"],
    "all は状態で固める（公開済み → 処理中 → 失敗 → 停止中）",
  );
});

test("未デプロイの件数: フィルタの絞り込みは status のまま、公開 / 停止のチップにだけ要更新を数える", () => {
  const items = [
    item({ id: "published", status: "published", publishedAt: PUBLISHED_AT }),
    item({ id: "undeployed-published", status: "published" }),
    item({ id: "undeployed-stopped", status: "stopped" }),
    item({ id: "publishing", status: "publishing" }),
    item({ id: "failed", status: "failed" }),
  ];
  assert.deepEqual(sharedContentUndeployedFilterCounts(items), {
    all: 0,
    published: 1,
    publishing: 0,
    stopped: 1,
    failed: 0,
  });
  // 選択肢は増やさず、状態の件数も status のまま（要更新は別に添えるだけ）
  assert.deepEqual(sharedContentFilterCounts(items), {
    all: 5,
    published: 2,
    publishing: 1,
    stopped: 1,
    failed: 1,
  });
  assert.deepEqual(sharedContentUndeployedFilterCounts([]), {
    all: 0,
    published: 0,
    publishing: 0,
    stopped: 0,
    failed: 0,
  });
});

test("一覧の並び: 状態で固め、その中は更新の新しい順、同時刻は API の順を保つ", () => {
  const items = [
    item({ id: "old-stopped", status: "stopped", updatedAt: 100 }),
    item({ id: "new-published", status: "published", updatedAt: 300 }),
    item({ id: "new-stopped", status: "stopped", updatedAt: 900 }),
    item({ id: "old-published", status: "published", updatedAt: 200 }),
    item({ id: "failed", status: "failed", updatedAt: 800 }),
    item({ id: "tie-a", status: "publishing", updatedAt: 400 }),
    item({ id: "tie-b", status: "publishing", updatedAt: 400 }),
  ];
  assert.deepEqual(
    visibleSharedContents(items, "all").map((entry) => entry.id),
    ["new-published", "old-published", "tie-a", "tie-b", "failed", "new-stopped", "old-stopped"],
  );
  assert.deepEqual(
    visibleSharedContents(items, "stopped").map((entry) => entry.id),
    ["new-stopped", "old-stopped"],
    "単一状態のタブでも更新の新しい順",
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

test("公開元の会話: 一覧が信頼でき、その id が居るときだけ返す", () => {
  const sessions: SessionSummary[] = [
    {
      spaceId: "work",
      sessionId: "s1",
      title: "会話",
      agentId: "default",
      status: "idle",
      queueDepth: 0,
      messageCount: 1,
      createdAt: 1,
      lastUsedAt: 1,
      serveCommand: null,
      pinned: false,
    },
  ];
  assert.deepEqual(sharedContentSession(item(), sessions, true), sessions[0]);
  assert.equal(sharedContentSession(item(), sessions, false), undefined, "一覧が未取得の間は推測で飛ばさない");
  assert.equal(
    sharedContentSession(item({ sessionId: "gone" }), sessions, true),
    undefined,
    "一覧に載っていない会話は返さない",
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
