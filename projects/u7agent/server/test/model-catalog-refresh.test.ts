// カタログ更新の期限が状態再計算 (実 SDK の認証ストア読み) まで伝わることの回帰テスト。
//
// 実 SDK + 隔離した agent dir を使い、他プロセスが auth.json.lock を保持した状態を作る。期限が伝わらないと
// refreshModelState() → getAvailable() がロック待ちを続け、総時間キャップを超えて共有 MutationLock を塞ぐ。
// キー・ネットワーク・実カタログには依存せず、期限で閉じることだけを固定する。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPiBff } from "../src/agent";

/** 他プロセスが auth.json.lock を持つ状態。proper-lockfile は `<path>.lock` のディレクトリで排他する */
function holdAuthLock(agentDir: string): void {
  mkdirSync(join(agentDir, "auth.json.lock"), { recursive: true });
}

test("状態再計算の期限は実 SDK の認証ストア読みにも伝わり、期限後も現在のカタログを保つ", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "u7agent-catalog-refresh-"));
  const cwd = mkdtempSync(join(tmpdir(), "u7agent-catalog-refresh-cwd-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const pi = await createPiBff({ cwd });
    const before = pi.modelCatalog;
    assert.ok(before, "起動直後は同梱カタログから公開 state を組む");
    // 起動後に auth.json が変わり、別プロセスがロックを保持している状態を作る (レビュー指摘の再現条件)
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ stub: { type: "api_key", key: "sk-lock-holder" } }));
    holdAuthLock(agentDir);

    const started = Date.now();
    await pi.refreshModelState({ signal: AbortSignal.timeout(50) });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 2_000, `期限 (50ms) で閉じる (elapsed=${elapsed}ms)`);
    assert.equal(pi.modelCatalog, before, "期限後は公開 state を差し替えない (一覧は現在値のまま)");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
