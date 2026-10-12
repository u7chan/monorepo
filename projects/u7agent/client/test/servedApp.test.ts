import assert from "node:assert/strict";

import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SingleColumnBar } from "../src/components/SingleColumnBar";
import { ServedAppGroup, ServedAppIndicator, type ServedAppProps } from "../src/components/ServedAppStatus";
import {
  servedAppBusyKind,
  servedAppFocusRequest,
  servedAppMenuSeparators,
  servedAppReplaceHint,
  servedAppRow,
  servedAppRowHref,
  servedAppStartConfirm,
  servedAppUrl,
  servedAppView,
  type ServeRowEvent,
} from "../src/lib/servedApp";
import type { ServeStatus } from "../src/types";
import { serveProps, serveStatus } from "./serve-fixture";

/** location.hostname を使うリンク生成のための最小のグローバル (node には無い) */
function withLocation<T>(run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { hostname: "app.test" } });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else Reflect.deleteProperty(globalThis, "location");
  }
}

test("サービス URL は hostname と health のポートで組み、未取得・不正値には URL を作らない", () => {
  assert.equal(servedAppUrl("localhost", 8080), "http://localhost:8080/");
  assert.equal(servedAppUrl("192.168.1.2", 8016), "http://192.168.1.2:8016/");
  assert.equal(servedAppUrl("[::1]", 8016), "http://[::1]:8016/");
  for (const port of [undefined, 0, -1, 65536, 1.5, NaN]) assert.equal(servedAppUrl("localhost", port), undefined);
});

test("表の 5 行を状態・リンク・操作へ写す", () => {
  // 到達可 + mine: 稼働中 + リンク + 停止
  const running = servedAppView(
    serveStatus({ reachable: true, owner: { kind: "mine", title: "トップページの改修" }, generation: "gen-1" }),
  );
  assert.deepEqual(
    [running.kind, running.label, running.tone, running.canOpen, running.canStop, running.canStart],
    ["running", "稼働中", "ok", true, true, false],
  );
  // 到達可 + other + 実績: 停止中 (リンクなし) + 起動 (置き換え)
  const other = servedAppView(serveStatus({ reachable: true, owner: { kind: "other", title: "決済画面の検証" } }));
  assert.deepEqual(
    [other.kind, other.label, other.tone, other.canOpen, other.canStop, other.canStart, other.ownerTitle],
    ["other", "停止中", "idle", false, false, true, "決済画面の検証"],
  );
  // 到達可 + unknown + 実績: 停止中（起動元不明）+ 停止 + 起動
  const unknown = servedAppView(serveStatus({ reachable: true, owner: { kind: "unknown" } }));
  assert.deepEqual(
    [unknown.kind, unknown.label, unknown.tone, unknown.canOpen, unknown.canStop, unknown.canStart],
    ["unknown", "停止中（起動元不明）", "warn", false, true, true],
  );
  // 到達不可 + 実績: 停止中 + 起動
  const stopped = servedAppView(serveStatus());
  assert.deepEqual(
    [stopped.kind, stopped.label, stopped.tone, stopped.canOpen, stopped.canStop, stopped.canStart],
    ["stopped", "停止中", "idle", false, false, true],
  );
  // 実績なし (および取得失敗) は何も出さない
  for (const status of [serveStatus({ command: null }), null, undefined]) {
    assert.equal(servedAppView(status).kind, "none");
  }
  // 到達可でも実績が無ければ何も出さない (他会話の実績は見せない)
  assert.equal(servedAppView(serveStatus({ reachable: true, command: null })).kind, "none");
});

test("desktop は [状態] [サービス] [停止/起動] を順に出し、リンクは稼働中だけ", () => {
  const html = withLocation(() =>
    renderToStaticMarkup(
      createElement(ServedAppGroup, serveProps({ status: serveStatus({ reachable: true, owner: { kind: "mine" } }) })),
    ),
  );
  assert.match(html, /稼働中/);
  assert.match(html, /href="http:\/\/app.test:8016\/"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer noopener"/);
  assert.match(html, /aria-label="サービスを開く"/);
  assert.match(html, /サービス<\/a>/);
  assert.match(html, /停止/);
  assert.ok(!html.includes("起動</button>"));
  // 並びは 状態 → サービス → 停止 → 区切り
  assert.ok(html.indexOf("稼働中") < html.indexOf("サービス</a>"));
  assert.ok(html.indexOf("サービス</a>") < html.indexOf("停止"));

  // 停止中 (実績あり) はリンクを出さない
  const stopped = withLocation(() => renderToStaticMarkup(createElement(ServedAppGroup, serveProps())));
  assert.ok(!stopped.includes("href="));
  assert.match(stopped, /停止中/);
  assert.match(stopped, /起動/);

  // 起動元不明は停止と起動の両方
  const unknown = withLocation(() =>
    renderToStaticMarkup(
      createElement(
        ServedAppGroup,
        serveProps({ status: serveStatus({ reachable: true, owner: { kind: "unknown" } }) }),
      ),
    ),
  );
  assert.match(unknown, /停止中（起動元不明）/);
  assert.ok(unknown.includes("停止") && unknown.includes("起動"));

  // 実績なし・取得失敗は何も出さない
  for (const props of [serveProps({ status: null }), serveProps({ failed: true })]) {
    assert.equal(renderToStaticMarkup(createElement(ServedAppGroup, props)), "");
  }
});

test("起動中は遷移状態としてバッジとキャンセルを出し、状態の形で区別する", () => {
  const html = renderToStaticMarkup(
    createElement(ServedAppGroup, serveProps({ status: null, starting: true, failed: false })),
  );
  assert.match(html, /起動中…/);
  assert.match(html, /キャンセル/);
  // 色だけでなく形でも区別する (稼働中 = 塗りドット / 起動元不明 = ! / 起動中 = スピナー)
  assert.match(html, /run-spinner/);
  const unknown = renderToStaticMarkup(
    createElement(ServedAppGroup, serveProps({ status: serveStatus({ reachable: true, owner: { kind: "unknown" } }) })),
  );
  assert.match(unknown, />!<\/span>/);
  const running = withLocation(() =>
    renderToStaticMarkup(
      createElement(ServedAppGroup, serveProps({ status: serveStatus({ reachable: true, owner: { kind: "mine" } }) })),
    ),
  );
  assert.match(running, /dot dot-ok/);
});

test("singleColumn は 1 枠で操作でき、停止中はメニューなしの起動ボタンを出す", () => {
  const running = withLocation(() =>
    renderToStaticMarkup(
      createElement(
        ServedAppIndicator,
        serveProps({ status: serveStatus({ reachable: true, owner: { kind: "mine" } }) }),
      ),
    ),
  );
  assert.match(running, /aria-label="サービスは稼働中。メニューを開く"/);
  assert.match(running, /aria-haspopup="menu"/);
  assert.match(running, /popover="auto"/);
  assert.match(running, /role="menu"/);
  assert.match(running, /サービスを開く/);
  assert.match(running, /停止/);

  const stopped = renderToStaticMarkup(createElement(ServedAppIndicator, serveProps()));
  assert.match(stopped, /^<button\b[^>]*aria-label="サービスを起動"/);
  assert.ok(!stopped.includes("popover"));

  // 他会話が使用中は押せて、起動は説明文で置き換えを予告する
  const other = withLocation(() =>
    renderToStaticMarkup(
      createElement(
        ServedAppIndicator,
        serveProps({ status: serveStatus({ reachable: true, owner: { kind: "other", title: "決済画面の検証" } }) }),
      ),
    ),
  );
  assert.match(other, /aria-label="サービスは停止中。メニューを開く"/);
  assert.match(other, /会話「決済画面の検証」が公開中/);
  assert.match(other, /会話「決済画面の検証」を停止して置き換え/);

  // 起動元不明は停止も選べる
  const unknown = renderToStaticMarkup(
    createElement(
      ServedAppIndicator,
      serveProps({ status: serveStatus({ reachable: true, owner: { kind: "unknown" } }) }),
    ),
  );
  assert.match(unknown, /停止中（起動元不明）/);
  assert.match(unknown, /記録と一致しないプロセスが使用中/);
  assert.match(unknown, /いま公開中のプロセスを停止/);
  assert.match(unknown, /停止して置き換え/);

  // 実績なし・取得失敗はアイコン自体を出さない
  for (const props of [serveProps({ status: null }), serveProps({ failed: true })]) {
    assert.equal(renderToStaticMarkup(createElement(ServedAppIndicator, props)), "");
  }
});

test("メニューの区切りは通常の操作と危険な操作の境界に 1 本だけ置き、並びは変えない", () => {
  // 「サービスを開く」の次が「停止」 (危険な操作が末尾)。危険な操作の前にだけ区切りを置く
  assert.deepEqual(servedAppMenuSeparators([{ danger: undefined }, { danger: true }]), [false, true]);
  // 「停止」が先頭で「起動」が続く形でも、境界の 1 本は同じ (危険なのが末尾とは限らない)
  assert.deepEqual(servedAppMenuSeparators([{ danger: true }, { danger: undefined }]), [false, true]);
  // 危険な操作が無い / 項目が 1 つ以下なら区切りは入らない
  assert.deepEqual(servedAppMenuSeparators([{ danger: undefined }]), [false]);
  assert.deepEqual(servedAppMenuSeparators([]), []);
  // 危険な操作が並んでも項目ごとには増やさず、境界ごとに 1 本にする
  assert.deepEqual(
    servedAppMenuSeparators([{ danger: undefined }, { danger: true }, { danger: true }, { danger: undefined }]),
    [false, true, false, true],
  );
});

test("置き換えの確認は所有者名を 1 回だけ独立した行に出し、起動コマンドを等幅の行にする", () => {
  const other = servedAppView(serveStatus({ reachable: true, owner: { kind: "other", title: "決済画面の検証" } }));
  const request = servedAppStartConfirm(other, undefined);
  assert.ok(request, "置き換えは確認を出す");
  assert.equal(request.kind, "confirm");
  assert.equal(request.title, "サービスを起動");
  // 初回メッセージ由来のタイトルは長いので、本文へ埋めず clamp される行へ 1 回だけ出す
  assert.deepEqual(request.subject, { label: "停止する会話", value: "決済画面の検証" });
  assert.deepEqual(request.body, ["他会話のサービスを停止して、この会話のサービスを起動します。"]);
  assert.ok(!(request.body ?? []).some((line) => line.includes("決済画面の検証")), "本文へ所有者名を埋めない");
  assert.deepEqual(request.code, { label: "起動コマンド", value: "pnpm dev" });
  assert.equal(request.confirmLabel, "停止して起動");
  assert.ok(request.danger, "他会話のサービスを止める操作は danger にする");

  const unknown = servedAppView(serveStatus({ reachable: true, owner: { kind: "unknown" } }));
  const unknownRequest = servedAppStartConfirm(unknown, undefined);
  assert.deepEqual(unknownRequest?.body, ["起動元不明のプロセスを停止して、この会話のサービスを起動します。"]);
  assert.equal(unknownRequest?.subject, undefined, "停止対象の会話は無い");
  assert.deepEqual(unknownRequest?.code, { label: "起動コマンド", value: "pnpm dev" });
});

test("閲覧中の会話が running / queued なら、所属にかかわらず self を返す", () => {
  for (const selfStatus of ["running", "queued"] as const) {
    for (const projectId of ["project-a", "", undefined]) {
      assert.equal(servedAppBusyKind({ selfStatus, sessionId: "self", projectId, sessions: [] }), "self");
    }
  }
});

test("圧縮中・待機中・終端の閲覧中会話だけでは実行中と判定しない", () => {
  for (const selfStatus of ["compacting", "idle", "completed", "stopped", "error"] as const) {
    assert.equal(servedAppBusyKind({ selfStatus, sessionId: "self", sessions: [] }), undefined);
  }
});

test("同じプロジェクトの他会話が running / queued のときだけ other を返す", () => {
  for (const status of ["running", "queued", "compacting", "idle", "completed", "stopped", "error"] as const) {
    for (const selfStatus of ["idle", "compacting"] as const) {
      assert.equal(
        servedAppBusyKind({
          selfStatus,
          sessionId: "self",
          projectId: "project-a",
          sessions: [{ sessionId: "other", projectId: "project-a", status }],
        }),
        status === "running" || status === "queued" ? "other" : undefined,
      );
    }
  }
});

test("他会話の所属が違う場合と、非空の所属を照合できない場合は実行中と判定しない", () => {
  const projects = ["project-a", "project-b", "", undefined];
  for (const projectId of projects) {
    for (const otherProjectId of projects) {
      assert.equal(
        servedAppBusyKind({
          selfStatus: "idle",
          sessionId: "self",
          projectId,
          sessions: [{ sessionId: "other", projectId: otherProjectId, status: "running" }],
        }),
        projectId && projectId === otherProjectId ? "other" : undefined,
      );
    }
  }
});

test("他会話の照合から自分自身を除き、一覧の古い実行状態で確認を増やさない", () => {
  for (const status of ["running", "queued"] as const) {
    assert.equal(
      servedAppBusyKind({
        selfStatus: "completed",
        sessionId: "self",
        projectId: "project-a",
        sessions: [{ sessionId: "self", projectId: "project-a", status }],
      }),
      undefined,
    );
  }
});

test("閲覧中の会話と同じプロジェクトの他会話が実行中なら self を優先する", () => {
  for (const selfStatus of ["running", "queued"] as const) {
    assert.equal(
      servedAppBusyKind({
        selfStatus,
        sessionId: "self",
        projectId: "project-a",
        sessions: [{ sessionId: "other", projectId: "project-a", status: "running" }],
      }),
      "self",
    );
  }
});

test("起動の確認は置き換えだけなら出し、どちらもなければ省略する", () => {
  const stopped = servedAppView(serveStatus());
  assert.equal(servedAppStartConfirm(stopped, undefined), undefined);
  for (const owner of [{ kind: "other", title: "決済画面の検証" }, { kind: "unknown" }] as const) {
    const view = servedAppView(serveStatus({ reachable: true, owner }));
    const request = servedAppStartConfirm(view, undefined);
    assert.equal(request?.confirmLabel, "停止して起動");
    assert.equal(request?.notes, undefined, "実行中でなければ補足は出さない");
  }
});

test("実行中だけの起動確認は、閲覧中と同じ作業フォルダの他会話で補足を分ける", () => {
  const stopped = servedAppView(serveStatus());
  const self = servedAppStartConfirm(stopped, "self");
  assert.equal(self?.confirmLabel, "起動する");
  assert.deepEqual(self?.notes, ["エージェントが実行中です。編集途中のファイルを読み込んだ状態で起動します。"]);

  const other = servedAppStartConfirm(stopped, "other");
  assert.equal(other?.confirmLabel, "起動する");
  assert.deepEqual(other?.notes, [
    "同じ作業フォルダの他会話でエージェントが実行中です。編集途中のファイルを読み込んだ状態で起動します。",
  ]);
  assert.equal(other?.subject, undefined, "置き換えが無ければ停止対象は出さない");
});

test("置き換えと実行中の確認は 1 つのダイアログへ本文と補足にまとめる", () => {
  for (const owner of [{ kind: "other", title: "決済画面の検証" }, { kind: "unknown" }] as const) {
    const view = servedAppView(serveStatus({ reachable: true, owner }));
    for (const [busy, note] of [
      ["self", "エージェントが実行中です。編集途中のファイルを読み込んだ状態で起動します。"],
      ["other", "同じ作業フォルダの他会話でエージェントが実行中です。編集途中のファイルを読み込んだ状態で起動します。"],
    ] as const) {
      const request = servedAppStartConfirm(view, busy);
      assert.equal(request?.confirmLabel, "停止して起動");
      assert.deepEqual(request?.notes, [note]);
      assert.deepEqual(
        request?.subject,
        owner.kind === "other" ? { label: "停止する会話", value: owner.title } : undefined,
      );
    }
  }
});

test("停止中の起動ヒントは停止・置き換えを予告せず、状態の根拠とは分ける", () => {
  const stopped = servedAppView(serveStatus());
  assert.equal(stopped.ariaLabel, "サービスを起動");
  assert.equal(stopped.badgeTitle, "この会話の作業ディレクトリには起動の実績があります");
  assert.equal(servedAppReplaceHint(stopped), "この会話のサービスを起動");
});

/** バーを描くための最小の props。行のテストは状態の値だけを差し替える */
function renderSingleColumnBar(overrides: Partial<ServedAppProps>, note?: string): string {
  return withLocation(() =>
    renderToStaticMarkup(
      createElement(SingleColumnBar, {
        mode: "portrait",
        title: "ピアノゲーム",
        scope: { label: "未所属", project: false, root: "" },
        serve: serveProps(overrides),
        runtimeStatus: { text: "", error: false },
        notify: { on: false, ring: 0, deliverable: true, note, onToggle: () => {} },
        onOpenNav: () => {},
      }),
    ),
  );
}

const MINE = serveStatus({ reachable: true, owner: { kind: "mine", title: "ピアノゲーム" }, generation: "gen-1" });

/** ポーリング / 停止の観測。観測した時点で確認待ち (starting) だったかも入力に含める */
function refreshed(status: ServeStatus, starting = false): ServeRowEvent {
  return { kind: "refreshed", status, starting };
}

// What: エピソードの状態遷移。行を出すのは起動のエピソードごとに 1 回で、✕ はそのエピソードだけを閉じる
test("起動のエピソードは start-ok で立ち、会話切替 / 取得失敗 / 確認待ち / 閉じるで落ちる", () => {
  const standing = servedAppRow({ episode: false }, { kind: "start-ok", status: MINE });
  assert.equal(standing.episode, true);
  for (const event of [
    { kind: "session-changed" },
    { kind: "failed" },
    { kind: "starting" },
    { kind: "dismissed" },
    { kind: "opened" },
  ] as const) {
    assert.equal(servedAppRow(standing, event).episode, false, event.kind);
  }
  // 会話切替は直前の確定状態も捨てる (別の会話の到達不可で次のエピソードを立てない)
  assert.equal(servedAppRow(standing, { kind: "session-changed" }).settled, undefined);
});

// What: 確認待ち (起動の押下から応答まで) の間に到達可を観測しても行は立たない
test("確認待ちの最中の取得では行が立たず、確認待ちが解けたあとの到達可 → 到達可でも立てない", () => {
  const waiting = servedAppRow({ episode: false, settled: serveStatus() }, { kind: "starting" });
  // POST の応答より先に GET が稼働中を返しても、「起動中」の表示と行を同時に出さない
  const observed = servedAppRow(waiting, refreshed(MINE, true));
  assert.equal(observed.episode, false, "確認待ち中の観測");
  // 観測した状態は記録するので、確認待ちが解けたあとに running → running が続いても立てない
  assert.equal(servedAppRow(observed, refreshed(MINE)).episode, false, "確認待ちが解けたあと");
  // 成功応答 (start-ok) が来たら立てる (このタブの起動を観測したエピソード)
  assert.equal(servedAppRow(observed, { kind: "start-ok", status: MINE }).episode, true);
});

// What: ポーリングで観測した稼働はエピソードを壊さず、到達不可からの復帰だけが新しいエピソードになる
test("稼働中のポーリングでは落とさず、立てるのは到達不可から自分のサービスへ変わったときだけ", () => {
  const standing = servedAppRow({ episode: false }, { kind: "start-ok", status: MINE });
  assert.equal(servedAppRow(standing, refreshed(MINE)).episode, true, "running → running");
  // 取得失敗は「到達不可」ではなく状態を見失っただけなので、復帰した稼働中で立て直さない
  const afterFailure = servedAppRow(servedAppRow(standing, { kind: "failed" }), refreshed(MINE));
  assert.equal(afterFailure.episode, false, "取得失敗からの復帰");

  const stopped = serveStatus();
  assert.equal(servedAppRow({ episode: false, settled: stopped }, refreshed(MINE)).episode, true);
  // 初期取得と会話切替の直後 (直前の確定状態が無い) では立てない
  assert.equal(servedAppRow({ episode: false }, refreshed(MINE)).episode, false);
  // 到達可のまま (他会話の公開) では立てない
  const other = serveStatus({ reachable: true, owner: { kind: "other", title: "決済画面の検証" } });
  assert.equal(servedAppRow({ episode: false, settled: other }, refreshed(MINE)).episode, false);
  // 到達可でも自分のサービスでなければ立てない
  assert.equal(servedAppRow({ episode: false, settled: stopped }, refreshed(other)).episode, false);
});

// What: ✕ はそのエピソードだけを閉じ、次のエピソードではまた出す
test("✕ の後の次のエピソード (到達不可 → 到達可) ではまた立つ", () => {
  const dismissed = servedAppRow(servedAppRow({ episode: false }, { kind: "start-ok", status: MINE }), {
    kind: "dismissed",
  });
  assert.equal(dismissed.episode, false);
  const stopped = servedAppRow(dismissed, refreshed(serveStatus()));
  assert.equal(stopped.episode, false, "停止では立てない");
  assert.equal(servedAppRow(stopped, refreshed(MINE)).episode, true);
});

// What: 焦点要求を立てる条件 (確認待ちの間にレイアウトが変わった場合は立てない)
test("焦点要求はこのタブの起動が適用され、成功時点が desktop で焦点が body にあるときだけ立てる", () => {
  const base = { applied: true, singleColumn: false, focusOnBody: true };
  assert.equal(servedAppFocusRequest(base), true);
  // 待っている間に singleColumn へ切り替わったら、リンクの無いバーへ要求を残さない
  assert.equal(servedAppFocusRequest({ ...base, singleColumn: true }), false);
  // 入力欄などへ焦点が移っていたら動かさない
  assert.equal(servedAppFocusRequest({ ...base, focusOnBody: false }), false);
  // 適用されなかった (失敗 / 会話切替 / セッション未確定) ときや、ポーリングで観測した外部起動では立てない
  assert.equal(servedAppFocusRequest({ ...base, applied: false }), false);
});

// What: 行を描くかの判定 (エピソード かつ 開ける かつ URL を作れる)
test("行の href はエピソード・開ける状態・URL の 3 つが揃うときだけ作る", () => {
  const base = { row: { episode: true }, status: MINE, failed: false, hostname: "app.test", port: 8016 };
  assert.equal(servedAppRowHref(base), "http://app.test:8016/");
  // previewPort が未取得・不正なら href を作らない (href の無い行を描かない)
  for (const port of [undefined, 0, -1, 70000]) {
    assert.equal(servedAppRowHref({ ...base, port }), undefined, String(port));
  }
  // エピソードが無ければ描かない
  assert.equal(servedAppRowHref({ ...base, row: { episode: false } }), undefined);
  // 取得失敗中は描かない (既存の契約: 失敗ではリンクも操作も出さない)
  assert.equal(servedAppRowHref({ ...base, failed: true, status: null }), undefined);
  assert.equal(servedAppRowHref({ ...base, failed: true }), undefined);
  // 到達不可 (停止)・他会話への置き換え・起動元不明・取得失敗では描かない
  for (const status of [
    serveStatus(),
    serveStatus({ reachable: true, owner: { kind: "other", title: "決済画面の検証" } }),
    serveStatus({ reachable: true, owner: { kind: "unknown" } }),
    null,
    undefined,
  ]) {
    assert.equal(servedAppRowHref({ ...base, status }), undefined, String(status));
  }
});

// What: singleColumn のバーへ行を出す位置と構造 (開くボタンと ✕ を兄弟にし、失敗理由と通知の間に置く)
test("singleColumn のバーは起動直後の 1 行を失敗理由の直後・通知の注記より前に出す", () => {
  const html = renderSingleColumnBar(
    { status: MINE, error: "BFF が応答しません", row: { episode: true } },
    "通知は届きません",
  );
  assert.match(html, /<div role="status"[^>]*>/, "状態の変化として読み上げる器に置く");
  assert.match(html, /サービスが起動しました/);
  assert.match(html, /aria-label="閉じる"/);
  // ✕ は開くボタンの兄弟にする (開くボタンの中で入れ子にしない)
  assert.match(html, /サービスが起動しました<\/button><button type="button" aria-label="閉じる"/);
  const error = html.indexOf("サービスの操作に失敗しました");
  const row = html.indexOf("サービスが起動しました");
  const note = html.indexOf("通知は届きません");
  assert.ok(error >= 0 && error < row && row < note, "順は 失敗理由 → 1 行 → 通知の注記");

  // エピソードが無い / 取得失敗 / 到達不可では出さない
  for (const overrides of [
    { status: MINE },
    { status: MINE, row: { episode: true }, failed: true },
    { status: serveStatus(), row: { episode: true } },
    { status: MINE, row: { episode: true }, port: undefined },
  ]) {
    assert.ok(!renderSingleColumnBar(overrides).includes("サービスが起動しました"));
  }
});

test("desktop のグループは起動の 1 行を出さず、状態のバッジとサービスリンクのままにする", () => {
  const html = withLocation(() =>
    renderToStaticMarkup(createElement(ServedAppGroup, serveProps({ status: MINE, row: { episode: true } }))),
  );
  assert.ok(!html.includes("サービスが起動しました"));
  assert.match(html, /稼働中/);
  assert.match(html, /aria-label="サービスを開く"/);
});
