import assert from "node:assert/strict";

import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServedAppGroup, ServedAppIndicator } from "../src/components/ServedAppStatus";
import {
  servedAppBusyKind,
  servedAppReplaceConfirm,
  servedAppReplaceHint,
  servedAppStartConfirm,
  servedAppUrl,
  servedAppView,
} from "../src/lib/servedApp";
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

test("compact は 1 枠で操作でき、停止中はメニューなしの起動ボタンを出す", () => {
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

test("置き換えの確認文言は所有者名を 1 回だけ出し、起動コマンドを独立した行にする", () => {
  const other = servedAppView(serveStatus({ reachable: true, owner: { kind: "other", title: "決済画面の検証" } }));
  assert.equal(
    servedAppReplaceConfirm(other),
    ["「決済画面の検証」を停止して、この会話のサービスを起動します。", "起動コマンド: pnpm dev"].join("\n"),
  );
  // 初回メッセージ由来のタイトルは長いので、2 回出すと同じ文が段落になる (重複の再発を防ぐ)
  assert.equal(servedAppReplaceConfirm(other).split("決済画面の検証").length - 1, 1);
  const unknown = servedAppView(serveStatus({ reachable: true, owner: { kind: "unknown" } }));
  assert.match(servedAppReplaceConfirm(unknown), /起動元不明のプロセスを停止して/);
  assert.match(servedAppReplaceConfirm(unknown), /pnpm dev/);
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

test("起動の確認は置き換えだけなら既存の文言を使い、どちらもなければ省略する", () => {
  const stopped = servedAppView(serveStatus());
  assert.equal(servedAppStartConfirm(stopped, undefined), undefined);
  for (const owner of [{ kind: "other", title: "決済画面の検証" }, { kind: "unknown" }] as const) {
    const view = servedAppView(serveStatus({ reachable: true, owner }));
    assert.equal(servedAppStartConfirm(view, undefined), servedAppReplaceConfirm(view));
  }
});

test("実行中だけの起動確認は、閲覧中と同じ作業フォルダの他会話で文言を分ける", () => {
  const stopped = servedAppView(serveStatus());
  assert.equal(
    servedAppStartConfirm(stopped, "self"),
    "エージェントが実行中です。編集途中のファイルを読み込んだ状態で起動します。",
  );
  assert.equal(
    servedAppStartConfirm(stopped, "other"),
    "同じ作業フォルダの他会話でエージェントが実行中です。編集途中のファイルを読み込んだ状態で起動します。",
  );
});

test("置き換えと実行中の確認は、置き換え → 空行 → 実行中の順で 1 つにまとめる", () => {
  for (const owner of [{ kind: "other", title: "決済画面の検証" }, { kind: "unknown" }] as const) {
    const view = servedAppView(serveStatus({ reachable: true, owner }));
    for (const [busy, message] of [
      ["self", "エージェントが実行中です。編集途中のファイルを読み込んだ状態で起動します。"],
      ["other", "同じ作業フォルダの他会話でエージェントが実行中です。編集途中のファイルを読み込んだ状態で起動します。"],
    ] as const) {
      assert.equal(servedAppStartConfirm(view, busy), `${servedAppReplaceConfirm(view)}\n\n${message}`);
    }
  }
});

test("停止中の起動ヒントは停止・置き換えを予告せず、状態の根拠とは分ける", () => {
  const stopped = servedAppView(serveStatus());
  assert.equal(stopped.ariaLabel, "サービスを起動");
  assert.equal(stopped.badgeTitle, "この会話の作業ディレクトリには起動の実績があります");
  assert.equal(servedAppReplaceHint(stopped), "この会話のサービスを起動");
});
