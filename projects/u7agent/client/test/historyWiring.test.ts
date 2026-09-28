// 全履歴 API の配線 (取得 / マージ / 追加取得) をソース走査で固定する。
// フェッチ自体はサーバーのテストと手動受入で確認する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

const api = read("src/api.ts");
const sessions = read("src/hooks/useSessions.ts");
const u7agent = read("src/hooks/useU7Agent.ts");
const chatArea = read("src/components/ChatArea.tsx");

test("getSessionHistory は before / limit を query に載せて履歴ルートを叩く", () => {
  assert.ok(api.includes("export const getSessionHistory"));
  assert.ok(api.includes('client.api.sessions[":id"].history.$url({ param: { id: sessionId } })'));
  assert.ok(api.includes("query.before = options.before"));
  assert.ok(api.includes("query.limit = String(options.limit)"));
});

test("useSessions は resync のたびに最新ページを取り直し、古いページを前置きする", () => {
  assert.ok(sessions.includes("getSessionHistory"));
  assert.ok(sessions.includes('dispatch({ type: "resyncHistory", page })'));
  assert.ok(sessions.includes('dispatch({ type: "prependHistory", cursor, page })'));
  assert.ok(sessions.includes('dispatch({ type: "historyUnsupported" })'));
  // resync (applySnapshot) のたびに最新ページを取り直す
  assert.ok(sessions.includes("void refreshHistory(payload.sessionId)"));
  // in-flight の古い応答で新しい表示を戻さない
  assert.ok(sessions.includes("historyRef.current.seq !== seq"));
});

test("欠落区間 (prevCursor が保持分に無い) は fillHistoryGap で取り直す", () => {
  assert.ok(sessions.includes("const fillHistoryGap = useCallback"));
  assert.ok(sessions.includes('dispatch({ type: "historyGap", cursor, page })'));
  assert.ok(sessions.includes("fillHistoryGap,"));
  // reducer の保留を Effect で解消する
  assert.ok(u7agent.includes("chat.history.gapCursor"));
  assert.ok(u7agent.includes("void fillHistoryGap(gapCursor)"));
});

test("追加取得のカーソルは reducer が適用したページの値だけを使う", () => {
  assert.ok(sessions.includes("historyStateRef.current"));
  assert.ok(
    !sessions.includes("historyRef.current.nextCursor"),
    "gap で保留したページの nextCursor を先読みに使わない",
  );
  assert.ok(u7agent.includes("const historyStateRef = useRef(chat.history)"));
  assert.ok(u7agent.includes("historyStateRef.current = chat.history"));
});

test("上方向の追加取得は useU7Agent の facade から ChatArea へ渡る", () => {
  assert.ok(u7agent.includes("loadOlderHistory"));
  assert.ok(chatArea.includes("onLoadOlder"));
});

test("CompactionDivider は通し番号を受け取り、要約をその位置で読める", () => {
  const divider = read("src/components/chat/CompactionDivider.tsx");
  assert.ok(divider.includes("startIndex"));
  assert.ok(divider.includes("compactionSummaryHeading(compaction, startIndex + index)"));
});
