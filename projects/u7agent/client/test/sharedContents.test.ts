// 共有ダイアログの純関数。公開の状態は status と lastError の組で読み、主操作の切り替えと
// 202 後の追跡（詳細の宛先・一覧の要否）を固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { sessionBusy } from "../src/lib/sessionBusy";
import {
  SHARE_CONFIRM_NOTES,
  SHARE_PUBLISHING_NOTE,
  SHARE_RUNNING_NOTE,
  SHARE_UPDATE_CONFIRM_NOTES,
  SHARE_UPDATE_NOTE_INCOMPLETE,
  SHARE_UPDATE_NOTE_LIVE,
  SHARE_UPDATE_NOTE_STOPPED,
  SHARED_CONTENT_UPDATE_RUNNING_NOTE,
  SHARED_CONTENT_UNDEPLOYED_NOTE,
  isSharedContentUndeployed,
  shareRunBlockedReason,
  shareItemsPublishing,
  settleAcceptedDetail,
  sharePollDetailId,
  sharePrimaryAction,
  shareStatusView,
  shareUpdateNote,
  sharedContentActions,
  sharedContentBusyLabel,
  sharedContentDeleteConfirm,
  sharedContentFilterCounts,
  sharedContentInFlightCount,
  sharedContentMenuActions,
  sharedContentPrimaryAction,
  sharedContentRenameRequest,
  sharedContentSession,
  sharedContentSessionMissing,
  sharedContentStopAllConfirm,
  sharedContentStopAllNote,
  sharedContentUndeployedFilterCounts,
  stoppableSharedContents,
  sharedContentUpdateConfirm,
  sharedContentsPolling,
  settleAcceptedAfterMutation,
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

test("確認の条件: 新規は確定 URL を出さず、更新は URL を出す（契約は経路で分かれる）", () => {
  const create = SHARE_CONFIRM_NOTES.join("\n");
  assert.match(create, /誰でも見られます/);
  assert.match(create, /秘密値/);
  assert.match(create, /公開前には表示できません/);
  assert.match(create, /サービス（一時プレビュー）とは別/);
  assert.equal(
    SHARE_CONFIRM_NOTES.some((note) => /https?:\/\//.test(note)),
    false,
    "新規の確認画面に確定 URL を出さない",
  );
  const update = SHARE_UPDATE_CONFIRM_NOTES.join("\n");
  assert.match(update, /誰でも見られます/);
  assert.match(update, /秘密値/);
  assert.match(update, /サービス（一時プレビュー）とは別/);
  // 更新は URL が決まっているので、「公開前には見せられない」と言わない
  assert.match(update, /更新しても URL は変わりません/);
  assert.equal(
    SHARE_UPDATE_CONFIRM_NOTES.some((note) => /公開前には表示できません/.test(note)),
    false,
  );
});

// What: 同じ公開元の共有物があれば更新を主操作にし、公開中だけは再送させない
test("主操作: 同じ公開元があれば更新、なければ新規、公開中は主操作なし", () => {
  const sourcePath = "projects/app/dist";
  const published = item({ status: "published", publishedAt: PUBLISHED_AT });
  assert.deepEqual(sharePrimaryAction(sourcePath, []), { kind: "create" });
  assert.deepEqual(sharePrimaryAction(null, [published]), { kind: "create" }, "公開元が分からなければ新規だけ");
  assert.deepEqual(sharePrimaryAction("projects/app/site", [published]), { kind: "create" });
  assert.deepEqual(sharePrimaryAction(sourcePath, [published]), { kind: "update", item: published });
  // 同じ公開元が公開中なら、公開済みの別行があっても再送しない
  const publishing = item({ id: "old" });
  assert.deepEqual(sharePrimaryAction(sourcePath, [published, publishing]), { kind: "publishing" });
});

// What: 更新の文言を状態ごとに出し分け、未デプロイと失敗は同じ復帰の文にする
test("更新の文言: 生きた / 停止中 / 未デプロイ・失敗 を分ける", () => {
  assert.equal(shareUpdateNote(item({ status: "published", publishedAt: PUBLISHED_AT })), SHARE_UPDATE_NOTE_LIVE);
  assert.equal(shareUpdateNote(item({ status: "stopped", publishedAt: PUBLISHED_AT })), SHARE_UPDATE_NOTE_STOPPED);
  assert.equal(shareUpdateNote(item({ status: "published", publishedAt: null })), SHARE_UPDATE_NOTE_INCOMPLETE);
  assert.equal(shareUpdateNote(item({ status: "stopped", publishedAt: null })), SHARE_UPDATE_NOTE_INCOMPLETE);
  assert.equal(shareUpdateNote(item({ status: "failed" })), SHARE_UPDATE_NOTE_INCOMPLETE);
  assert.equal(shareUpdateNote(item({ status: "publishing" })), SHARE_PUBLISHING_NOTE);
});

test("ポーリングの宛先: 受付した 1 件と追跡中の id を詳細で追い、一覧の要否は sharedContentsPolling が決める", () => {
  // 受付した 1 件が一覧に載っていない間も詳細で追う
  assert.equal(sharePollDetailId("abc123", []), "abc123");
  assert.equal(sharePollDetailId("abc123", [item()]), "abc123");
  // 一覧の同じ id が終端なら詳細は要らない (一覧の取り直しで十分)
  assert.equal(sharePollDetailId("abc123", [item({ status: "published" })]), null);
  assert.equal(sharePollDetailId(null, [item()]), null);
  // 追跡中の id は、一覧が古い published 行のままでも詳細で追う
  const stale = [item({ id: "abc123", status: "published", publishedAt: PUBLISHED_AT })];
  assert.equal(sharePollDetailId(null, stale, ["abc123"]), "abc123");
  // 受付した 1 件がまだ一覧に無い間は、そちらを優先する (追跡 id は一覧の取り直しで揃う)
  assert.equal(sharePollDetailId("abc123", [], ["def456"]), "abc123");
  // 一覧の要否は状態と追跡の両方で決める。追跡が残っている間は止めない
  assert.equal(shareItemsPublishing(stale), false);
  assert.equal(sharedContentsPolling(stale, []), false);
  assert.equal(sharedContentsPolling(stale, ["abc123"]), true);
  assert.equal(shareItemsPublishing([item({ status: "published" })]), false);
  assert.equal(shareItemsPublishing([item({ status: "published" }), item({ id: "def456" })]), true);
});

test("受付済みの追跡: 202 の直後の一覧取得が失敗しても、終端を取得するまでポーリングを続ける", () => {
  const published = item({ id: "abc123", status: "published" });
  // 202 の受付時に追跡へ入れる
  let tracked = trackAcceptedSharedContent([], "abc123");
  assert.deepEqual(tracked, ["abc123"]);
  // 受付直後の一覧 GET が失敗した場合、items は操作前 (published) のまま。それでも追跡が残るので続ける
  assert.equal(sharedContentsPolling([published], tracked), true);
  // 一覧が古い published のままでも詳細を読む (更新前の結果を出したまま止まらない)
  assert.equal(sharePollDetailId(null, [published], tracked), "abc123");
  // 一覧が取れて publishing を確認できた: 追跡を続ける
  tracked = settleAcceptedSharedContent(tracked, [item({ id: "abc123", status: "publishing" })]);
  assert.deepEqual(tracked, ["abc123"]);
  assert.equal(sharedContentsPolling([], tracked), true);
  // 終端を確認できたら追跡をやめる
  tracked = settleAcceptedSharedContent(tracked, [item({ id: "abc123", status: "stopped" })]);
  assert.deepEqual(tracked, []);
  assert.equal(sharedContentsPolling([published], tracked), false);
  assert.equal(sharePollDetailId(null, [published], tracked), null, "終端を確かめたら詳細も止める");
  // 一覧から消えた id も追跡をやめる
  assert.deepEqual(settleAcceptedSharedContent(["gone"], [published]), []);
  // 同じ id を重ねて追跡しない
  assert.deepEqual(trackAcceptedSharedContent(["abc123"], "abc123"), ["abc123"]);
});

// What: 詳細で終端を確認した id は、一覧が失敗し続けても追跡を終え、詳細・一覧の要求を続けない
test("詳細の精算: 詳細の終端で追跡を終える（他の id は落とさない）", () => {
  const stale = [item({ id: "abc123", status: "published", publishedAt: PUBLISHED_AT })];
  const tracked = trackAcceptedSharedContent([], "abc123");
  // 詳細が publishing の間は追跡を続ける (一覧の古い行で終端と誤認しない)
  const publishing = settleAcceptedDetail(tracked, item({ id: "abc123", status: "publishing" }));
  assert.deepEqual(publishing, ["abc123"]);
  assert.equal(sharePollDetailId(null, stale, publishing), "abc123");
  assert.equal(sharedContentsPolling(stale, publishing), true);
  // 詳細が終端を返したら、一覧が古い published のままでも詳細・一覧とも止める
  for (const terminal of [
    item({ id: "abc123", status: "published", publishedAt: PUBLISHED_AT, lastError: "更新に失敗しました" }),
    item({ id: "abc123", status: "failed", lastError: "index.html がありません" }),
    item({ id: "abc123", status: "stopped", publishedAt: PUBLISHED_AT }),
  ]) {
    const settled = settleAcceptedDetail(tracked, terminal);
    assert.deepEqual(settled, [], terminal.status);
    assert.equal(sharePollDetailId(null, stale, settled), null, terminal.status);
    assert.equal(sharedContentsPolling(stale, settled), false, terminal.status);
  }
  // 一覧にまだ現れていない他の id は終端扱いにしない (一覧を受け取る settleAcceptedSharedContent との違い)
  const both = trackAcceptedSharedContent(trackAcceptedSharedContent([], "abc123"), "def456");
  assert.deepEqual(settleAcceptedDetail(both, item({ id: "abc123", status: "published" })), ["def456"]);
});

test("操作後の 202 追跡: 受付は追跡へ入れ、終端は外し、表示名の変更は触らない", () => {
  assert.deepEqual(settleAcceptedAfterMutation([], "id1", "update"), ["id1"]);
  assert.deepEqual(settleAcceptedAfterMutation(["id1"], "id2", "retry"), ["id1", "id2"]);
  assert.deepEqual(settleAcceptedAfterMutation(["id1"], "id1", "resume"), ["id1"]);
  assert.deepEqual(settleAcceptedAfterMutation(["id1"], "id1", "stop"), []);
  assert.deepEqual(settleAcceptedAfterMutation(["id1"], "id1", "delete"), []);
  // 表示名の変更は終端を持たない。一覧の取得に失敗している間に受けた公開の追跡を消さない
  assert.deepEqual(settleAcceptedAfterMutation(["id1"], "id1", "rename"), ["id1"]);
});

test("受付した 1 件の反映: 同じ id は差し替え、未取得なら先頭へ足す", () => {
  const published = item({ status: "published" });
  assert.deepEqual(withSharedContent([item()], published), [published]);
  const other = item({ id: "def456" });
  assert.deepEqual(withSharedContent([other], published), [published, other]);
});

test("操作行: 状態ごとの主操作だけを並べ、停止 / 削除は行に出さない", () => {
  const kinds = (overrides: Partial<SharedContentResponse>) =>
    sharedContentActions(item(overrides), { sessionMissing: false }).map((action) => action.kind);
  assert.deepEqual(kinds({ status: "published", publishedAt: PUBLISHED_AT }), ["open", "qr", "update"]);
  assert.deepEqual(kinds({ status: "published", publishedAt: PUBLISHED_AT, lastError: "更新に失敗しました" }), [
    "open",
    "qr",
    "update",
  ]);
  assert.deepEqual(kinds({ status: "stopped", publishedAt: PUBLISHED_AT }), ["resume"]);
  assert.deepEqual(kinds({ status: "failed" }), ["retry"]);
  assert.deepEqual(kinds({ status: "publishing" }), []);
  assert.deepEqual(kinds({ status: "publishing", lastError: "公開の結果を確認できませんでした" }), ["stop"]);
  // 実体が無いのに開かせたり再公開させたりしない。解消は更新（同じ URL へ上げ直す）と削除だけ
  assert.deepEqual(kinds({ status: "published" }), ["update"]);
  assert.deepEqual(kinds({ status: "stopped" }), ["update"]);
  assert.deepEqual(kinds({ status: "published", lastError: "公開に失敗しました" }), ["update"]);
});

test("実行中: 共有・更新・再試行を理由付きで無効にし、読み取りと逃げ道は残す", () => {
  // 判定は BFF の isBusy と同じ集合 (running / queued / compacting)
  assert.equal(sessionBusy("running"), true);
  assert.equal(sessionBusy("queued"), true);
  assert.equal(sessionBusy("compacting"), true);
  for (const status of ["idle", "completed", "stopped", "error"] as const) {
    assert.equal(sessionBusy(status), false, status);
    assert.equal(shareRunBlockedReason(status), undefined, status);
  }
  assert.equal(shareRunBlockedReason("running"), SHARE_RUNNING_NOTE);

  // 管理一覧: 更新だけを理由付きで無効にし、開く・QR・停止・削除は残す
  const published = sharedContentActions(item({ status: "published", publishedAt: PUBLISHED_AT }), {
    sessionMissing: false,
    sessionBusy: true,
  });
  const update = published.find((action) => action.kind === "update");
  assert.equal(update?.disabled, true);
  assert.equal(update?.reason, SHARED_CONTENT_UPDATE_RUNNING_NOTE);
  assert.deepEqual(
    published.filter((action) => action.disabled !== true).map((action) => action.kind),
    ["open", "qr"],
  );
  assert.deepEqual(
    sharedContentMenuActions(item({ status: "published", publishedAt: PUBLISHED_AT }), {
      sessionMissing: false,
      narrow: true,
      sessionBusy: true,
    }).map((action) => [action.kind, action.disabled === true]),
    [
      ["rename", false],
      ["update", true],
      ["qr", false],
      ["stop", false],
      ["delete", false],
    ],
  );
  // 未デプロイ行の主操作 (更新) も同じ理由で止める
  const undeployed = sharedContentPrimaryAction(item({ status: "published" }), {
    sessionMissing: false,
    sessionBusy: true,
  });
  assert.equal(undeployed?.disabled, true);
  assert.equal(undeployed?.reason, SHARED_CONTENT_UPDATE_RUNNING_NOTE);
  // failed 行の唯一の復旧導線 (公開を再試行) も、更新と同じ publish を叩くので実行中は止める
  for (const action of [
    ...sharedContentActions(item({ status: "failed" }), { sessionMissing: false, sessionBusy: true }),
    sharedContentPrimaryAction(item({ status: "failed" }), { sessionMissing: false, sessionBusy: true }),
  ]) {
    assert.equal(action?.kind, "retry");
    assert.equal(action?.disabled, true);
    assert.equal(action?.reason, SHARED_CONTENT_UPDATE_RUNNING_NOTE);
  }
  // 再公開 (resume) は成果物を読まないので、実行中でも押せる
  assert.deepEqual(
    sharedContentActions(item({ status: "stopped", publishedAt: PUBLISHED_AT }), {
      sessionMissing: false,
      sessionBusy: true,
    }),
    [{ kind: "resume", label: "再公開" }],
  );
  // セッション削除済みの理由が優先する (更新できない理由が 2 つあるときは恒久的なほうを出す)
  const missing = sharedContentPrimaryAction(item({ status: "published" }), {
    sessionMissing: true,
    sessionBusy: true,
  });
  assert.equal(missing?.reason, SHARED_CONTENT_SESSION_MISSING_NOTE);
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
    ["open", "qr"],
  );
  // ⋯ の更新も同じ理由で無効にする（狭い面の主操作は開くだけなので、更新はここにしかない）
  const menu = sharedContentMenuActions(item({ status: "published", publishedAt: PUBLISHED_AT }), {
    sessionMissing: true,
    narrow: true,
  });
  assert.deepEqual(
    menu.map((action) => [action.kind, action.disabled === true]),
    [
      ["rename", false],
      ["update", true],
      ["qr", false],
      ["stop", false],
      ["delete", false],
    ],
  );
  assert.deepEqual(
    sharedContentActions(item({ status: "stopped", publishedAt: PUBLISHED_AT }), { sessionMissing: true }).map(
      (action) => action.kind,
    ),
    ["resume"],
  );
});

test("未デプロイのセッション削除済み: 更新だけを理由付きで無効にし、削除は残す", () => {
  for (const status of ["published", "stopped"] as const) {
    const desktop = sharedContentActions(item({ status }), { sessionMissing: true });
    assert.deepEqual(
      desktop.map((action) => [action.kind, action.disabled === true]),
      [["update", true]],
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
    // ... は名前を変更と削除だけ（行 / 主操作に出ている更新を重ねない）
    assert.deepEqual(
      sharedContentMenuActions(item({ status }), { sessionMissing: true, narrow: true }).map((action) => action.kind),
      ["rename", "delete"],
    );
  }
});

test("⋯ の操作: 名前を変更を先頭に置き、行に出ていない操作だけを幅ごとに並べる", () => {
  const menu = (overrides: Partial<SharedContentResponse>, narrow: boolean) =>
    sharedContentMenuActions(item(overrides), { sessionMissing: false, narrow }).map((action) => action.kind);
  const published = { status: "published", publishedAt: PUBLISHED_AT } as const;
  // PC は行に更新があるので ⋯ には重ねない。狭い面は主操作が開くだけなので更新も入れる
  assert.deepEqual(menu(published, false), ["rename", "stop", "delete"]);
  assert.deepEqual(menu(published, true), ["rename", "update", "qr", "stop", "delete"]);
  assert.deepEqual(menu({ status: "published" }, false), ["rename", "delete"]);
  assert.deepEqual(menu({ status: "stopped" }, false), ["rename", "delete"]);
  assert.deepEqual(menu({ status: "stopped", publishedAt: PUBLISHED_AT }, true), ["rename", "delete"]);
  assert.deepEqual(menu({ status: "failed" }, false), ["rename", "delete"]);
  // 公開中はどちらの幅でも ⋯ を出さない（状態が確定してから変更する）
  assert.deepEqual(menu({ status: "publishing" }, false), []);
  assert.deepEqual(menu({ status: "publishing", lastError: "公開の結果を確認できませんでした" }, true), []);
  assert.equal(
    sharedContentMenuActions(item(published), { sessionMissing: false, narrow: false }).at(-1)?.danger,
    true,
    "削除は破壊的な操作として示す",
  );
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

test("QR: 公開済みで URL があるときだけ行と ⋯ に出す", () => {
  const live = { status: "published", publishedAt: PUBLISHED_AT } as const;
  const row = (overrides: Partial<SharedContentResponse>) =>
    sharedContentActions(item(overrides), { sessionMissing: false }).map((action) => action.kind);
  const menu = (overrides: Partial<SharedContentResponse>, narrow: boolean) =>
    sharedContentMenuActions(item(overrides), { sessionMissing: false, narrow }).map((action) => action.kind);

  assert.deepEqual(row(live), ["open", "qr", "update"]);
  assert.deepEqual(menu(live, true), ["rename", "update", "qr", "stop", "delete"]);
  // PC の ⋯ には行と重ねない
  assert.deepEqual(menu(live, false), ["rename", "stop", "delete"]);

  // 公開済みでも URL が無い / 外部に実体が無い（未デプロイ）なら QR を出さない
  assert.deepEqual(row({ ...live, publicUrl: null }), ["open", "update"]);
  assert.deepEqual(menu({ ...live, publicUrl: null }, true), ["rename", "update", "stop", "delete"]);
  assert.deepEqual(row({ ...live, publishedAt: null }), ["update"]);

  for (const status of ["stopped", "failed", "publishing"] as const) {
    assert.equal(row({ status, publishedAt: PUBLISHED_AT }).includes("qr"), false, status);
    assert.equal(menu({ status, publishedAt: PUBLISHED_AT }, true).includes("qr"), false, status);
  }
});

test("名前の変更: 対象と現在値を入れ、URL と状態が変わらないことを示す", () => {
  assert.deepEqual(sharedContentRenameRequest({ name: "モンスト風" }), {
    kind: "prompt",
    title: "名前を変更",
    label: "共有物の名前",
    defaultValue: "モンスト風",
    body: ["表示名だけを変えます。公開 URL と公開状態は変わりません。"],
    confirmLabel: "変更する",
  });
});

test("操作中の表示: 何をしているかを種類ごとに出す", () => {
  const kinds: SharedContentBusyKind[] = ["rename", "update", "stop", "resume", "retry", "delete"];
  assert.deepEqual(kinds.map(sharedContentBusyLabel), [
    "変更中",
    "更新中",
    "停止処理中",
    "再公開中",
    "公開中",
    "削除中",
  ]);
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

// 一括停止は「外部に実体があり、止められる行」だけを対象にする。フィルタの件数とは一致しない。
test("一括停止の対象: 公開済み（公開実績あり）と結果不明だけを止める", () => {
  const items = [
    item({ id: "live", status: "published", publishedAt: PUBLISHED_AT }),
    item({ id: "undeployed", status: "published", publishedAt: null }),
    item({ id: "in-flight", status: "publishing", lastError: null }),
    item({ id: "unknown", status: "publishing", lastError: "公開の結果を確認できませんでした" }),
    item({ id: "stopped", status: "stopped", publishedAt: PUBLISHED_AT }),
    item({ id: "failed", status: "failed" }),
  ];

  assert.deepEqual(
    stoppableSharedContents(items).map((entry) => entry.id),
    ["live", "unknown"],
    "未デプロイ・結果待ち・停止中・失敗は止めない",
  );
  assert.equal(sharedContentInFlightCount(items), 1, "結果待ちだけを対象外として数える");
  assert.equal(sharedContentInFlightCount([item({ status: "publishing", lastError: "結果不明" })]), 0);
});

test("一括停止の確認: 対象の名前と状態を並べ、結果待ちは対象外として件数を出す", () => {
  const items = [
    item({ id: "a", name: "portfolio", status: "published", publishedAt: PUBLISHED_AT }),
    item({ id: "b", name: "lp", status: "published", publishedAt: PUBLISHED_AT }),
    item({ id: "c", name: "docs", status: "publishing", lastError: "結果不明" }),
    item({ id: "d", name: "in-flight", status: "publishing" }),
    item({ id: "e", name: "old", status: "stopped", publishedAt: PUBLISHED_AT }),
    item({ id: "f", name: "undeployed", status: "published" }),
  ];

  const request = sharedContentStopAllConfirm(items);
  assert.equal(request.kind, "confirm");
  if (request.kind !== "confirm") return;
  assert.equal(request.title, "稼働中の共有物をすべて停止");
  assert.equal(request.subject?.value, "稼働中の共有物 3 件");
  assert.deepEqual(
    request.targets?.items.map((target) => [target.label, target.note]),
    [
      ["portfolio", "公開済み"],
      ["lp", "公開済み"],
      ["docs", "結果不明"],
    ],
  );
  assert.equal(request.targets?.more, undefined);
  assert.ok(
    request.notes?.includes("公開処理中の 1 件は対象外です。完了すると公開されます。"),
    "停止できない結果待ちを押す前に示す",
  );
  assert.equal(request.danger, true);
});

test("一括停止の確認: 対象が多いときは名前を 5 件までにして残りを件数へ畳む", () => {
  const items = Array.from({ length: 7 }, (_, index) =>
    item({
      id: `site-${index}`,
      name: `site-${index}`,
      status: "published",
      publishedAt: PUBLISHED_AT,
    }),
  );
  const request = sharedContentStopAllConfirm(items);
  if (request.kind !== "confirm") return;
  assert.equal(request.targets?.items.length, 5);
  assert.equal(request.targets?.more, 2);
});

test("一括停止の結果: 成功・一部失敗・全失敗・対象外を 1 行にまとめる", () => {
  assert.deepEqual(sharedContentStopAllNote({ total: 3, stopped: 3, failures: [], excludedPublishing: 0 }), {
    text: "稼働中 3 件をすべて停止しました。",
    error: false,
  });
  assert.deepEqual(sharedContentStopAllNote({ total: 3, stopped: 3, failures: [], excludedPublishing: 1 }), {
    text: "稼働中 3 件をすべて停止しました。公開処理中の 1 件は対象外です。完了すると公開されます。",
    error: false,
  });

  const partial = sharedContentStopAllNote({
    total: 3,
    stopped: 2,
    failures: [{ name: "docs" }],
    excludedPublishing: 0,
  });
  assert.deepEqual(partial, {
    text: "3 件中 2 件を停止しました。1 件は停止できませんでした（docs）。理由は各カードに表示しています。",
    error: true,
  });

  // 2 件以上失敗しても、ノートは全件の名前を落とさない（理由は各カードへ配る）
  assert.deepEqual(
    sharedContentStopAllNote({
      total: 4,
      stopped: 2,
      failures: [{ name: "docs" }, { name: "lp" }],
      excludedPublishing: 0,
    }),
    {
      text: "4 件中 2 件を停止しました。2 件は停止できませんでした（docs、lp）。理由は各カードに表示しています。",
      error: true,
    },
  );

  assert.deepEqual(
    sharedContentStopAllNote({
      total: 3,
      stopped: 0,
      failures: [{ name: "docs" }, { name: "lp" }],
      excludedPublishing: 0,
    }),
    {
      text: "3 件を停止できませんでした（docs、lp）。理由は各カードに表示しています。",
      error: true,
    },
  );
  assert.equal(sharedContentStopAllNote({ total: 0, stopped: 0, failures: [], excludedPublishing: 0 }), null);
});
