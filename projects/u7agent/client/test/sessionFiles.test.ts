// セッションの作業フォルダを出せる条件を固定する。表示方法は desktop=右パネル / compact=全画面シートだが、
// root の可用性は layout に依存させない (run_end での取り直しは client/test/chatReducer.test.ts が見る)。
import assert from "node:assert/strict";
import test from "node:test";
import { sessionFilesDefaultOpen, sessionFilesRoot } from "../src/lib/sessionFiles";

const cwd = ".u7agent/sessions/01a0b4cf";
const projectCwd = "work/hello";

test("チャット画面では選択中セッションの root を返す", () => {
  assert.equal(sessionFilesRoot({ chatView: true, cwd, projectCwd: "" }), cwd);
});

test("セッション未作成では作成先プロジェクトの root を使う", () => {
  assert.equal(sessionFilesRoot({ chatView: true, cwd: "", projectCwd }), projectCwd);
});

test("設定ページと未所属の新規会話は出さない (ワークスペース root へ落とさない)", () => {
  assert.equal(sessionFilesRoot({ chatView: false, cwd, projectCwd }), "", "設定ページでは出さない");
  assert.equal(sessionFilesRoot({ chatView: true, cwd: "", projectCwd: "" }), "", "root が無ければ出さない");
});

test("既定オープンは desktop でプロジェクト配下の新規会話のときだけ開にする", () => {
  assert.equal(sessionFilesDefaultOpen({ compact: false, projectId: "p1" }), true, "プロジェクト配下で閉じている");
  assert.equal(sessionFilesDefaultOpen({ compact: false, projectId: "" }), false, "未所属で開いている");
  // compact のシートは手動トグルだけ (既定オープンの対象は desktop のパネル)
  assert.equal(sessionFilesDefaultOpen({ compact: true, projectId: "p1" }), false, "compact で既定を開にしている");
});
