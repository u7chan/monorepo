// サービスの状態取得 (useServeStatus) の契約。
//   - 会話を切り替えたら前の会話の状態を描かない (render 中の同期 reset)
//   - 選択中の会話 id と要求世代で古い応答を捨てる (requestGate)
//   - 取得失敗はリンクも操作も出さない状態にする (到達不可と区別する)
//   - 既存の 4 秒ポーリングと同じリズムに乗せる
// DOM を持たない方針のため、Effect とクリックの実行はソース走査で固定する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

const hook = read("src/hooks/useServeStatus.ts");
const facade = read("src/hooks/useU7Agent.ts");
const api = read("src/api.ts");

test("会話を切り替えたフレームで前の会話の状態を描かない", () => {
  // Effect を待つと 1 フレーム古い値が出るため、render 中に同期して捨てる (App の sheetScope と同じ作法)
  assert.match(hook, /if \(tracked !== sessionId\) \{\n\s+setTracked\(sessionId\);\n\s+setState\(IDLE\);/);
  assert.match(hook, /const IDLE: ServeState = \{ status: null, failed: false, starting: false, error: undefined \}/);
  // 切替後は選択中の会話で取り直す
  assert.match(
    hook,
    /useEffect\(\(\) => \{\n\s+if \(!sessionId\) return;\n\s+void refresh\(\);\n\s+\}, \[sessionId, refresh\]\)/,
  );
});

test("選択中の会話 id と要求世代で古い応答を捨てる", () => {
  // 応答の適用可否は requestGate に任せる (後から始まった要求と lifecycle を優先する)
  assert.match(hook, /createRequestGate\(\)/);
  assert.match(hook, /const canApply = gate\(\(\) => sessionIdRef\.current === id\)/);
  // 取得と操作の応答はどちらも会話 id の一致を見てから適用する
  assert.equal((hook.match(/if \(!canApply\(\)\) return;/g) ?? []).length, 2);
  assert.equal((hook.match(/if \(sessionIdRef\.current !== id\) return;/g) ?? []).length, 4);
});

test("操作は進行中の取得を捨て、後から届いた取得で操作の結果を上書きさせない", () => {
  // 操作の直前と、操作の応答を適用する直前に、進行中の取得を無効化する
  assert.match(
    hook,
    /const invalidatePending = useCallback\(\(\): void => \{\n\s+gate\(\(\) => false\);\n\s+\}, \[gate\]\)/,
  );
  const start = hook.slice(hook.indexOf("const start ="), hook.indexOf("const stop ="));
  assert.ok(start.indexOf("invalidatePending();") < start.indexOf("await startServe"), "送信の前に捨てる");
  assert.ok(
    start.indexOf("invalidatePending();", start.indexOf("await startServe")) < start.indexOf("setState({ status"),
    "応答の適用前にも捨てる",
  );
  const stop = hook.slice(hook.indexOf("const stop ="), hook.indexOf("const cancel ="));
  assert.ok(stop.indexOf("invalidatePending();") < stop.indexOf("await stopServe"), "送信の前に捨てる");
  assert.ok(
    stop.indexOf("invalidatePending();", stop.indexOf("await stopServe")) < stop.indexOf("setState({ status"),
    "応答の適用前にも捨てる",
  );
});

test("取得失敗はリンクも操作も出さない状態にし、到達不可と区別する", () => {
  assert.match(hook, /setState\(\(prev\) => \(\{ \.\.\.prev, status: null, failed: true \}\)\)/);
  // 起動・停止の失敗は理由を残し、状態はサーバーの値を取り直す
  assert.match(
    hook,
    /setState\(\(prev\) => \(\{ \.\.\.prev, starting: false, error: messageFor\(error\) \}\)\);\n\s+await refresh\(\);/,
  );
  assert.match(
    hook,
    /setState\(\(prev\) => \(\{ \.\.\.prev, error: messageFor\(error\) \}\)\);\n\s+await refresh\(\);/,
  );
  // 起動は期限つきのプローブまで確定しないため、遷移状態を持つ (キャンセルは待つのをやめる)
  assert.match(hook, /setState\(\(prev\) => \(\{ \.\.\.prev, starting: true, error: undefined \}\)\)/);
  assert.match(hook, /startAbort\.current\?\.abort\(\)/);
});

test("既存の 4 秒ポーリングと同じリズムに乗せる", () => {
  assert.match(facade, /const serve = useServeStatus\(\{ sessionId \}\)/);
  const interval = facade.slice(facade.indexOf("window.setInterval"), facade.indexOf("window.setInterval") + 700);
  assert.match(interval, /void serve\.refresh\(\)/);
  assert.match(interval, /\}, 4000\)/);
  // interval は refresh (安定した useCallback) だけに依存させる (毎描画で作り直さない)
  assert.match(facade, /\}, \[refreshSessions, serve\.refresh\]\)/);
});

test("API 呼び出しは閲覧中の会話 id と世代だけを送る", () => {
  assert.match(api, /client\.api\.serve\.status\.\$get\(\{ query: \{ sessionId \} \}/);
  assert.match(api, /client\.api\.serve\.start\.\$post\(\{ json: input \}, \{ init: \{ signal \} \}\)/);
  assert.match(api, /client\.api\.serve\.stop\.\$post\(\{ json: input \}\)/);
  // 作業ディレクトリはサーバーが解決する (client は cwd を送らない)
  const serveApi = api.slice(api.indexOf("export const getServeStatus"), api.indexOf("export const stopServe"));
  assert.ok(serveApi.length > 0 && !serveApi.includes("cwd"), "client から cwd を送っていない");
});
