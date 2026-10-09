import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RuntimeServiceCard } from "../src/components/RuntimeServiceCard";
import { INITIAL_RUNTIME_SERVE_STATE, type RuntimeServeState } from "../src/lib/runtimeServe";

function render(state: Partial<RuntimeServeState>, port: number | undefined = 8016) {
  return renderToStaticMarkup(
    createElement(RuntimeServiceCard, {
      state: { ...INITIAL_RUNTIME_SERVE_STATE, loading: false, ...state },
      hostname: "localhost",
      port,
      onStop: () => {},
    }),
  );
}
const running = {
  reachable: true,
  owner: { sessionId: "session-a", title: "会話A", spaceId: "space-1111111111111111" },
  generation: "gen-a",
  command: { cwd: "app", command: "pnpm dev" },
};

test("共有サービスは稼働状態・別タブのページ・起動元会話のリンク・停止を表示する", () => {
  const html = render({ status: running });
  assert.ok(html.includes("稼働中"));
  assert.ok(html.includes('href="http://localhost:8016/"'));
  assert.ok(html.includes('target="_blank" rel="noreferrer noopener"'));
  assert.ok(html.includes('href="/s/session-a?space=space-1111111111111111"'));
  assert.ok(html.includes("会話A"));
  assert.ok(html.includes("pnpm dev"));
  assert.ok(html.includes("停止</button>"));
});
test("起動元不明でもページと停止を出すが、誤った会話リンクは出さない", () => {
  const html = render({ status: { ...running, owner: null, command: null } });
  assert.ok(html.includes("起動元不明"));
  assert.ok(html.includes("ページを開く"));
  assert.ok(html.includes("停止</button>"));
  assert.ok(!html.includes('href="/s/'));
});
test("所属スペースが分からない起動元は space を付けず、保存値で解決させる", () => {
  const html = render({ status: { ...running, owner: { sessionId: "session-a", title: "会話A" } } });
  assert.ok(html.includes('href="/s/session-a"'));
  assert.ok(!html.includes("?space="));
});
test("停止中・取得失敗・初回取得中ではページと停止を出さない", () => {
  for (const state of [
    { status: { reachable: false, owner: null, generation: null, command: null } },
    { failed: true },
    { loading: true },
  ]) {
    const html = render(state);
    assert.ok(!html.includes("ページを開く"));
    assert.ok(!html.includes("停止</button>"));
  }
  assert.ok(render({ failed: true }).includes('role="alert"'));
});
test("公開ポートが不明ならリンクを作らず、停止確認中は二重操作を無効にする", () => {
  const html = renderToStaticMarkup(
    createElement(RuntimeServiceCard, {
      state: { ...INITIAL_RUNTIME_SERVE_STATE, loading: false, status: running, stopping: true },
      hostname: "localhost",
      onStop: () => {},
    }),
  );
  assert.ok(!html.includes("ページを開く"));
  assert.ok(html.includes("disabled"));
  assert.ok(html.includes("停止を確認中"));
});
