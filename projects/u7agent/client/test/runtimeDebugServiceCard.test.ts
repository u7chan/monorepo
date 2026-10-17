import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RuntimeDebugServiceCard } from "../src/components/RuntimeDebugServiceCard";
import { INITIAL_RUNTIME_DEBUG_SERVE_STATE, type RuntimeDebugServeState } from "../src/lib/runtimeDebugServe";
import type { RuntimeDebugServeEntry } from "../src/types";

function render(state: Partial<RuntimeDebugServeState> = {}, onStop: (port: number) => void = () => {}) {
  return renderToStaticMarkup(
    createElement(RuntimeDebugServiceCard, {
      state: { ...INITIAL_RUNTIME_DEBUG_SERVE_STATE, loading: false, ...state },
      onStop,
    }),
  );
}

const tracked: RuntimeDebugServeEntry = {
  port: 18000,
  owner: { sessionId: "session-a", title: "会話A", spaceId: "space-1111111111111111" },
  command: "pnpm dev --port $U7AGENT_DEBUG_PORT",
  startedAt: 1_700_000_000_000,
};
const untracked: RuntimeDebugServeEntry = { port: 18005, owner: null, command: null, startedAt: null };

test("デバッグ用は待受ポート・起動元のリンク・コマンド・強制停止を出す", () => {
  const html = render({ status: { servers: [tracked] } });
  assert.ok(html.includes("デバッグ用（エージェント内部）"));
  assert.ok(html.includes("18000"));
  assert.ok(html.includes('href="/s/session-a?space=space-1111111111111111"'));
  assert.ok(html.includes("会話A"));
  assert.ok(html.includes("pnpm dev --port $U7AGENT_DEBUG_PORT"));
  assert.ok(html.includes("強制停止</button>"));
  assert.ok(!html.includes("ページを開く"), "デバッグ用に開く導線を出さない");
  assert.ok(!html.includes("起動</button>"), "起動・置き換えの導線を出さない");
});

test("追跡外のポートはポートだけを出し、誤った会話リンクを出さない", () => {
  const html = render({ status: { servers: [untracked] } });
  assert.ok(html.includes("18005"));
  assert.ok(html.includes("所有者不明（追跡外）"));
  assert.ok(!html.includes('href="/s/'));
  assert.ok(html.includes("強制停止</button>"));
});

test("起動元を確認できない行は所有者不明として出し、lease の値は残す", () => {
  const html = render({ status: { servers: [{ ...tracked, owner: null }] } });
  assert.ok(html.includes("所有者不明（起動元を確認できません）"));
  assert.ok(html.includes("pnpm dev --port $U7AGENT_DEBUG_PORT"));
  assert.ok(!html.includes('href="/s/'));
});

test("空の一覧・取得失敗・初回取得中では停止を出さない", () => {
  assert.ok(render({ status: { servers: [] } }).includes("デバッグ用のサーバーはありません。"));
  assert.ok(render({ failed: true }).includes('role="alert"'));
  for (const state of [{ status: { servers: [] } }, { failed: true }, { loading: true }]) {
    assert.ok(!render(state).includes("強制停止</button>"));
  }
});

test("停止確認中は二重操作を無効にし、対象のポートを停止へ渡す", () => {
  const ports: number[] = [];
  const stopping = render({ status: { servers: [tracked, untracked] }, stoppingPort: 18005 }, (port) =>
    ports.push(port),
  );
  assert.ok(stopping.includes("停止を確認中"));
  assert.equal((stopping.match(/disabled/g) ?? []).length, 2, "停止中の行も他の行も無効にする");
  assert.equal(ports.length, 0, "描画だけでは停止しない");
});
