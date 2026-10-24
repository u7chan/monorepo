// 実行状況の「公開中のサービス」1 行と行ごとの操作の決定。稼働状態は全スペース共通の runtime status を
// 正とし、取得できない間はリンクも起動も停止も出さない。描画は activityPage.test.ts が担う。
import assert from "node:assert/strict";
import test from "node:test";
import { activityServiceView, activityRowServe, runtimeServeStartConfirm } from "../src/lib/activityServe";
import type { RuntimeServeStatus } from "../src/types";

const running: RuntimeServeStatus = {
  reachable: true,
  owner: { sessionId: "session-a", title: "会話A", spaceId: "space-1111111111111111" },
  generation: "gen-a",
  command: { cwd: "app", command: "python3 -m http.server 8080" },
};
const unknown: RuntimeServeStatus = { reachable: true, owner: null, generation: "gen-b", command: null };
const stopped: RuntimeServeStatus = { reachable: false, owner: null, generation: null, command: null };

const row = { sessionId: "session-a", kind: "finished" as const, serveCommand: "pnpm dev" };

test("サービス行は取得前・取得失敗・停止中・起動中・稼働中・起動元不明を区別する", () => {
  const view = (status: RuntimeServeStatus | null, failed = false, launching?: { title?: string; command?: string }) =>
    activityServiceView({ status, failed, launching, hostname: "localhost", port: 8016 });

  assert.equal(view(null).kind, "loading");
  assert.equal(view(running, true).kind, "failed", "取得失敗を停止中へ丸めない");
  assert.equal(view(running, true).canStop, false);
  assert.equal(view(stopped).label, "停止中");
  const active = view(running);
  assert.equal(active.kind, "running");
  assert.equal(active.label, "稼働中");
  assert.deepEqual(active.owner, running.owner);
  assert.deepEqual(active.command, running.command);
  assert.equal(active.url, "http://localhost:8016/");
  assert.equal(active.canStop, true);
  const unclear = view(unknown);
  assert.equal(unclear.kind, "unknown");
  assert.equal(unclear.label, "稼働中（起動元不明）");
  assert.equal(unclear.owner, undefined, "起動元は推測しない");
  // 起動の確認待ちは取得の値より優先し、操作を出さない (確定は最大 10 秒後)
  const starting = view(running, false, { title: "会話B", command: "pnpm dev" });
  assert.equal(starting.kind, "starting");
  assert.equal(starting.url, undefined);
  assert.equal(starting.canStop, false);
});

test("公開ポートが未取得なら開く URL を作らない (操作は出さない)", () => {
  const active = activityServiceView({ status: running, failed: false, hostname: "", port: undefined });
  assert.equal(active.url, undefined);
  assert.equal(active.canStop, true, "停止は公開ポートに依存しない");
});

test("行の操作は稼働中の起動元が開く、実績のある終了行が起動、それ以外は無し", () => {
  const serve = (input: Parameters<typeof activityRowServe>[0]) => activityRowServe(input);
  const base = { status: running, failed: false, starting: null, hostname: "localhost", port: 8016 };

  const served = serve({ ...base, row });
  assert.equal(served.served, true);
  assert.equal(served.action, "open");
  assert.equal(served.url, "http://localhost:8016/");

  const finished = serve({ ...base, row: { ...row, sessionId: "other" } });
  assert.equal(finished.served, false);
  assert.equal(finished.action, "start");
  assert.equal(finished.command, "pnpm dev");

  // 実行中の行には起動を出さない (エージェントの serve と競合させない)
  assert.equal(serve({ ...base, row: { ...row, sessionId: "other", kind: "working" } }).action, "none");
  // 実績の無い終了行も操作なし
  assert.equal(serve({ ...base, row: { ...row, sessionId: "other", serveCommand: null } }).action, "none");
  // 状態を取得できない間は、どの行にも操作を出さない (押せない理由も出さない)
  assert.deepEqual(serve({ ...base, row, status: null }), { served: false, action: "none", disabled: false });
  assert.deepEqual(serve({ ...base, row, failed: true }), { served: false, action: "none", disabled: false });
  // 公開ポートが未取得なら、稼働中でも開くを出さない (行全体のリンクへ戻す)
  assert.deepEqual(serve({ ...base, row, port: undefined }), { served: true, action: "none", disabled: false });
});

test("起動中は対象の行を操作に変え、他の行の起動を無効にする", () => {
  const base = { status: stopped, failed: false, hostname: "localhost", port: 8016 };
  const target = activityRowServe({ ...base, row, starting: "session-a" });
  assert.equal(target.action, "starting");
  assert.equal(target.disabled, true);
  const other = activityRowServe({ ...base, row: { ...row, sessionId: "other" }, starting: "session-a" });
  assert.equal(other.action, "start");
  assert.equal(other.disabled, true, "同時に 1 件だけ");
});

test("起動の確認は対象の会話・コマンドと、置き換える現在の起動元を出す", () => {
  const target = { title: "起動する会話", serveCommand: "pnpm dev" };
  const plain = runtimeServeStartConfirm(target, stopped);
  assert.equal(plain.title, "サービスを起動");
  assert.deepEqual(plain.body, []);
  assert.deepEqual(plain.subject, { label: "起動元の会話", value: "起動する会話" });
  assert.deepEqual(plain.code, { label: "起動コマンド", value: "pnpm dev" });
  assert.equal(plain.confirmLabel, "起動する");
  assert.equal(plain.danger, false);

  const replace = runtimeServeStartConfirm(target, running);
  assert.equal(replace.body?.[0], "公開中の「会話A」を停止して置き換えます。");
  assert.equal(replace.confirmLabel, "停止して起動");
  assert.equal(replace.danger, true);
  assert.match(replace.notes?.[0] ?? "", /いま公開中の作業ディレクトリ: app（python3 -m http\.server 8080）/);

  const unclear = runtimeServeStartConfirm(target, unknown);
  assert.equal(unclear.body?.[0], "起動元不明のプロセスを停止して置き換えます。");
  assert.match(unclear.notes?.[0] ?? "", /起動元を特定できません/);
});
