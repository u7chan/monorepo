// 会話タイトルのリネーム導線。client に DOM テスト基盤が無いため、prompt / API / 一覧反映の配線を
// ソース走査で固定する (メニュー項目の出し分けと描画は client/test/sidebarRowMenu.test.ts)。
//   1. 一覧の ⋯「名前を変更」は window.prompt の初期値を現在のタイトルにし、空・未変更なら何もしない
//   2. 応答の正規化後タイトルを一覧へ反映する (ヘッダの表示も一覧から引くため、これで追従する)
//   3. 失敗は状態行へ出し、楽観反映はしない (サーバーが値を変えないため)
//   4. Sidebar / ProjectRow の両方の入口から同じ handler を通す
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
}

test("リネームは prompt の初期値を現在のタイトルにして、空・未変更なら何もしない", () => {
  const source = read("src/hooks/useSessions.ts");
  assert.match(source, /const renameSession = useCallback\(/, "リネームの handler が無い");
  assert.ok(source.includes("window.prompt(sessionRenamePrompt(), current)"), "prompt の初期値が現在のタイトルでない");
  assert.ok(source.includes("if (!next || next === current) return;"), "空・未変更で何もしない判定が無い");
});

test("リネームは応答のタイトルを一覧へ反映し、失敗は状態行へ出す", () => {
  const source = read("src/hooks/useSessions.ts");
  assert.ok(source.includes("await updateSessionTitle(id, next)"), "タイトルの PATCH を呼んでいない");
  assert.ok(source.includes("applyTitle(result.sessionId, result.title)"), "応答のタイトルを一覧へ反映していない");
  assert.ok(source.includes("セッション名を変更できませんでした。"), "失敗の理由を状態行へ出していない");
  // 楽観反映はしない: 要求前に新しいタイトルを一覧へ入れる経路を作らない
  assert.ok(!source.includes("applyTitle(id, next)"), "要求前にタイトルを楽観反映している");
});

test("API はタイトルの PATCH ルートを叩く", () => {
  const source = read("src/api.ts");
  assert.ok(source.includes("export const updateSessionTitle ="), "updateSessionTitle が無い");
  assert.ok(
    source.includes('client.api.sessions[":id"].title.$patch({ param: { id: sessionId }, json: { title } })'),
    "PATCH /api/sessions/:id/title を叩いていない",
  );
});

test("App / Sidebar / ProjectRow は同じ renameSession を両方の入口へ渡す", () => {
  const app = read("src/App.tsx");
  assert.ok(app.includes("void app.renameSession(sessionId)"), "App が renameSession を配線していない");
  const sidebar = read("src/components/Sidebar.tsx");
  assert.ok(sidebar.includes("onRenameSession={renameSession}"), "Sidebar がプロジェクト配下の行へ渡していない");
  assert.ok(sidebar.includes("onRename={() => renameSession(item.sessionId)}"), "Sidebar が未所属の行へ渡していない");
  const projectRow = read("src/components/sidebar/ProjectRow.tsx");
  assert.ok(
    projectRow.includes("onRename={() => onRenameSession(item.sessionId)}"),
    "ProjectRow が配下の行へ渡していない",
  );
});
